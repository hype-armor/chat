import fcntl
import importlib.util
import os
import tempfile
import unittest
import uuid
from unittest import mock

import username_migration_recovery_epoch_durable_testonly as epochs
from username_migration_recovery_epoch_model_testonly import Identity

spec = importlib.util.spec_from_file_location('journal', os.path.join(os.path.dirname(__file__), 'username-migration-journal.py'))
journal_module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(journal_module)


class DurableEpochTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.operation = str(uuid.uuid4())
        self.identity = Identity('test-authority', 'fs', 'volume', 'metadata', 42)
        self.effects = []
        with journal_module.Journal(self.tmp.name) as journal:
            journal.begin(self.operation)
            for phase in ('fence', 'backup', 'migrate'):
                journal.advance(phase)
            journal.begin_rollback()

    def tearDown(self):
        self.tmp.cleanup()

    def run_epoch(self, journal, number=1, **changes):
        args = dict(evidence_digest='a' * 64, mount_id='mount-1', number=number,
                    authority=lambda op, digest: self.identity, fence=lambda: 'lease',
                    effect=lambda context: self.effects.append(number),
                    original_intent_identity=(1, 2, 3, 4, 5),
                    original_intent_contents=b'abc', prior_intents=(),
                    destination_identity=(7, 42, 'volume'), resolve_prior=lambda context: True)
        args.update(changes)
        return epochs.attempt(journal, **args)

    def test_direct_calls_require_resolution_and_bind_prior(self):
        seen = []
        with journal_module.Journal(self.tmp.name) as journal:
            with self.assertRaises(epochs.EpochError):
                self.run_epoch(journal, resolve_prior=None)
            self.run_epoch(journal, resolve_prior=lambda ctx: seen.append(ctx) or True)
            with self.assertRaises(epochs.EpochError):
                self.run_epoch(journal, resolve_prior=None)
            self.run_epoch(journal, resolve_prior=lambda ctx: seen.append(ctx) or True)
        self.assertEqual(seen[0].operation, self.operation)
        self.assertEqual(seen[0].evidence_digest, 'a' * 64)
        self.assertEqual(seen[0].original_intent_identity, (1, 2, 3, 4, 5))
        self.assertEqual(seen[0].destination_identity, (7, 42, 'volume'))
        self.assertEqual(seen[0].mount_id, 'mount-1')
        self.assertEqual(seen[0].number, 1)
        self.assertEqual(len(seen[0].fence_sha256), 64)
        self.assertEqual(seen[0].prior, ())
        self.assertIn(b'"number":1', seen[1].prior[0][1])
        self.assertEqual(self.effects, [1, 1])

    def test_context_is_frozen_and_passed_to_effect(self):
        seen = []
        intents = (('attempt-1', b'private intent'),)
        with journal_module.Journal(self.tmp.name) as journal:
            self.run_epoch(journal, prior_intents=intents,
                           resolve_prior=lambda ctx: seen.append(ctx) or True,
                           effect=lambda ctx: seen.append(ctx))
        self.assertIs(seen[0], seen[1])
        self.assertEqual(seen[0].original_intent_contents, b'abc')
        self.assertEqual(seen[0].prior_intents, intents)
        self.assertEqual(seen[0].failure_markers, ())
        with self.assertRaises(AttributeError):
            seen[0].number = 9

    def test_intent_contents_must_be_immutable(self):
        with journal_module.Journal(self.tmp.name) as journal:
            for changes in (dict(original_intent_contents=bytearray(b'abc')),
                            dict(original_intent_contents=b'wrong'),
                            dict(prior_intents=[('a', b'x')]),
                            dict(prior_intents=(('a', bytearray(b'x')),)),
                            dict(prior_intents=(('a', b'x'), ('a', b'y')))):
                with self.subTest(changes=changes), self.assertRaises(epochs.EpochError):
                    self.run_epoch(journal, **changes)
        self.assertEqual(self.effects, [])

    def test_binding_original_and_destination_across_epochs(self):
        with journal_module.Journal(self.tmp.name) as journal:
            self.run_epoch(journal)
            for changes in (dict(original_intent_identity=(1, 9, 3, 4, 5)),
                            dict(original_intent_contents=b'xyz'),
                            dict(destination_identity=(8, 42, 'volume'))):
                for number in (1, 2):
                    with self.subTest(changes=changes, number=number), self.assertRaises(epochs.EpochError):
                        self.run_epoch(journal, number, **changes)
        self.assertEqual(self.effects, [1])

    def test_effect_failure_preserves_private_evidence_for_resolution(self):
        def fail(context):
            raise RuntimeError('private secret')
        with journal_module.Journal(self.tmp.name) as journal:
            with self.assertRaises(RuntimeError):
                self.run_epoch(journal, effect=fail)
            self.assertTrue(journal.failed)
        names = [n for n in os.listdir(self.tmp.name) if n.startswith('.epoch-testonly-failure-')]
        self.assertEqual(len(names), 1)
        path = os.path.join(self.tmp.name, names[0])
        self.assertEqual(os.stat(path).st_mode & 0o777, 0o600)
        with open(path, 'rb') as f:
            contents = f.read()
        self.assertIn(b'RuntimeError', contents)
        self.assertNotIn(b'private secret', contents)
        seen = []
        with journal_module.Journal(self.tmp.name) as journal:
            with self.assertRaises(epochs.EpochError):
                self.run_epoch(journal, 2, prior_intents=(('attempt-1', None),),
                               resolve_prior=lambda ctx: seen.append(ctx) or False)
            self.run_epoch(journal, 2, prior_intents=(('attempt-1', None),),
                           resolve_prior=lambda ctx: seen.append(ctx) or True)
        self.assertEqual(seen[0].failure_markers, ((names[0], contents),))
        self.assertEqual(seen[1].prior_intents, (('attempt-1', None),))
        self.assertEqual(self.effects, [2])
        with open(path, 'rb') as f:
            self.assertEqual(f.read(), contents)

    def test_identical_replacement_of_epoch_and_marker_is_rejected(self):
        with journal_module.Journal(self.tmp.name) as journal:
            with self.assertRaises(RuntimeError):
                self.run_epoch(journal, effect=lambda context: (_ for _ in ()).throw(RuntimeError()))
        names = [n for n in os.listdir(self.tmp.name) if n.startswith((epochs.PREFIX, epochs.FAILURE_PREFIX))]
        for name in names:
            with self.subTest(name=name):
                def replace(context):
                    path = os.path.join(self.tmp.name, name)
                    with open(path, 'rb') as source:
                        data = source.read()
                    replacement = path + '.replacement'
                    fd = os.open(replacement, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
                    with os.fdopen(fd, 'wb') as target:
                        target.write(data)
                    os.replace(replacement, path)
                    return True
                with journal_module.Journal(self.tmp.name) as journal:
                    with self.assertRaises(epochs.EpochError):
                        self.run_epoch(journal, 2, resolve_prior=replace)
        self.assertEqual(self.effects, [])

    def test_resolver_cannot_change_failure_evidence(self):
        def fail(context):
            raise RuntimeError('failed')
        with journal_module.Journal(self.tmp.name) as journal:
            with self.assertRaises(RuntimeError):
                self.run_epoch(journal, effect=fail)
        marker = next(n for n in os.listdir(self.tmp.name) if n.startswith(epochs.FAILURE_PREFIX))
        path = os.path.join(self.tmp.name, marker)
        def mutate(context):
            with open(path, 'ab') as f:
                f.write(b'changed')
            return True
        with journal_module.Journal(self.tmp.name) as journal:
            with self.assertRaises(epochs.EpochError):
                self.run_epoch(journal, 2, resolve_prior=mutate)
        self.assertEqual(self.effects, [])

    def test_resolver_cannot_change_prior_or_fence(self):
        with journal_module.Journal(self.tmp.name) as journal:
            self.run_epoch(journal)
            path = os.path.join(self.tmp.name, epochs.PREFIX + '000001.json')
            def mutate(context):
                with open(path, 'ab') as f:
                    f.write(b'changed')
                return True
            with self.assertRaises(epochs.EpochError):
                self.run_epoch(journal, 2, resolve_prior=mutate)
        self.assertEqual(self.effects, [1])

    def test_epochs_retry_and_binding(self):
        with journal_module.Journal(self.tmp.name) as journal:
            self.run_epoch(journal)
            self.run_epoch(journal)
            self.run_epoch(journal, 2, mount_id='mount-2')
            with self.assertRaises(epochs.EpochError):
                self.run_epoch(journal, 2, mount_id='wrong')
            with self.assertRaises(epochs.EpochError):
                self.run_epoch(journal, 3, evidence_digest='b' * 64)
        self.assertEqual(self.effects, [1, 1, 2])

    def test_lost_directory_sync_reply_resyncs_on_reopen(self):
        original = os.fsync
        with journal_module.Journal(self.tmp.name) as journal:
            def fail_dir(fd):
                if fd == journal.dirfd and os.path.exists(os.path.join(self.tmp.name, epochs.PREFIX + '000001.json')):
                    raise OSError('lost reply')
                return original(fd)
            with mock.patch.object(epochs.os, 'fsync', side_effect=fail_dir):
                with self.assertRaises(OSError):
                    self.run_epoch(journal)
            self.assertTrue(journal.failed)
        self.assertEqual(self.effects, [])
        with journal_module.Journal(self.tmp.name) as journal:
            self.run_epoch(journal)
        self.assertEqual(self.effects, [1])

    def test_partial_write_retains_private_evidence_and_blocks_retry(self):
        original_write = os.write
        calls = 0
        with journal_module.Journal(self.tmp.name) as journal:
            def partial_then_fail(fd, data):
                nonlocal calls
                calls += 1
                if calls == 1:
                    return original_write(fd, data[:12])
                raise OSError('write failure')
            with mock.patch.object(epochs.os, 'write', side_effect=partial_then_fail):
                with self.assertRaises(OSError):
                    self.run_epoch(journal)
            self.assertTrue(journal.failed)
        names = [n for n in os.listdir(self.tmp.name) if n.startswith('.epoch-testonly-')]
        self.assertEqual(len(names), 1)
        path = os.path.join(self.tmp.name, names[0])
        with open(path, 'rb') as f:
            retained = f.read()
        self.assertEqual(len(retained), 12)
        self.assertEqual(os.stat(path).st_mode & 0o777, 0o600)
        with journal_module.Journal(self.tmp.name) as journal:
            with self.assertRaises(epochs.EpochError):
                self.run_epoch(journal)
            self.assertTrue(journal.failed)
        with open(path, 'rb') as f:
            self.assertEqual(f.read(), retained)
        self.assertEqual(self.effects, [])

    def test_rename_failures_preserve_evidence_and_sync_directory(self):
        original_rename = epochs._rename_noreplace
        original_sync = os.fsync
        for after_rename in (False, True):
            with self.subTest(after_rename=after_rename), tempfile.TemporaryDirectory() as directory:
                with journal_module.Journal(directory) as journal:
                    journal.begin(str(uuid.uuid4()))
                    for phase in ('fence', 'backup', 'migrate'):
                        journal.advance(phase)
                    journal.begin_rollback()
                    synced = []
                    def sync(fd):
                        if fd == journal.dirfd:
                            synced.append(fd)
                        return original_sync(fd)
                    def fail_rename(*args):
                        if after_rename:
                            original_rename(*args)
                        raise OSError('uncertain rename')
                    with mock.patch.object(epochs, '_rename_noreplace', side_effect=fail_rename), mock.patch.object(epochs.os, 'fsync', side_effect=sync):
                        with self.assertRaises(OSError):
                            self.run_epoch(journal)
                    self.assertTrue(journal.failed)
                    self.assertTrue(synced)
                    names = [n for n in os.listdir(directory) if n.startswith(('.epoch-testonly-', epochs.PREFIX))]
                    self.assertEqual(len(names), 1)
                    self.assertEqual(names[0].startswith(epochs.PREFIX), after_rename)
                    path = os.path.join(directory, names[0])
                    self.assertEqual(os.stat(path).st_mode & 0o777, 0o600)
                    with open(path, 'rb') as f:
                        self.assertIn(b'"evidence_sha256"', f.read())
        self.assertEqual(self.effects, [])

    def test_gap_corruption_and_fence_loss_stop_effects(self):
        with journal_module.Journal(self.tmp.name) as journal:
            with self.assertRaises(epochs.EpochError):
                self.run_epoch(journal, 2)
            self.run_epoch(journal)
            name = os.path.join(self.tmp.name, epochs.PREFIX + '000001.json')
            with open(name, 'wb') as f:
                f.write(b'{}\n')
            with self.assertRaises(epochs.EpochError):
                self.run_epoch(journal, 2)
        self.assertEqual(self.effects, [1])

    def test_journal_change_during_final_evidence_read_stops_effect(self):
        for replay in (False, True):
            with self.subTest(replay=replay), tempfile.TemporaryDirectory() as directory:
                with journal_module.Journal(directory) as journal:
                    journal.begin(str(uuid.uuid4()))
                    for phase in ('fence', 'backup', 'migrate'):
                        journal.advance(phase)
                    journal.begin_rollback()
                    if replay:
                        self.run_epoch(journal)
                        self.effects.clear()
                    calls = 0
                    changed = False
                    original_read = epochs._read
                    def authority(op, digest):
                        nonlocal calls
                        calls += 1
                        return self.identity
                    def read_and_change(*args, **kwargs):
                        nonlocal changed
                        result = original_read(*args, **kwargs)
                        if calls == (4 if replay else 5) and not changed:
                            state = journal.load()
                            state['operation_id'] = str(uuid.uuid4())
                            journal._save(state)
                            changed = True
                        return result
                    with mock.patch.object(epochs, '_read', side_effect=read_and_change):
                        with self.assertRaisesRegex(epochs.EpochError, 'pinned journal changed'):
                            self.run_epoch(journal, authority=authority)
                    self.assertTrue(changed)
                    self.assertTrue(journal.failed)
                    self.assertEqual(self.effects, [])
                    name = epochs.PREFIX + '000001.json'
                    with open(os.path.join(directory, name), 'rb') as f:
                        self.assertIn(b'"number":1', f.read())

    def test_resolver_unlock_is_rejected(self):
        with journal_module.Journal(self.tmp.name) as journal:
            def unlock(context):
                fcntl.flock(journal.lockfd, fcntl.LOCK_UN)
                return True
            with self.assertRaisesRegex(epochs.EpochError, 'lock is not held'):
                self.run_epoch(journal, resolve_prior=unlock)
            self.assertTrue(journal.failed)
        self.assertEqual(self.effects, [])
        self.assertFalse(any(n.startswith(epochs.PREFIX) for n in os.listdir(self.tmp.name)))

    def test_resolver_downgrade_to_shared_lock_is_rejected(self):
        with journal_module.Journal(self.tmp.name) as journal:
            def downgrade(context):
                fcntl.flock(journal.lockfd, fcntl.LOCK_SH)
                return True
            with self.assertRaisesRegex(epochs.EpochError, 'lock is not held'):
                self.run_epoch(journal, resolve_prior=downgrade)
            self.assertTrue(journal.failed)
        self.assertEqual(self.effects, [])
        self.assertFalse(any(n.startswith(epochs.PREFIX) for n in os.listdir(self.tmp.name)))

    def test_resolver_unlock_with_competing_locker_is_rejected(self):
        with journal_module.Journal(self.tmp.name) as journal:
            competitor = os.open('lock', os.O_RDWR | os.O_CLOEXEC, dir_fd=journal.dirfd)
            try:
                def replace_owner(context):
                    fcntl.flock(journal.lockfd, fcntl.LOCK_UN)
                    fcntl.flock(competitor, fcntl.LOCK_EX | fcntl.LOCK_NB)
                    return True
                with self.assertRaisesRegex(epochs.EpochError, 'lock ownership lost'):
                    self.run_epoch(journal, resolve_prior=replace_owner)
                self.assertTrue(journal.failed)
            finally:
                os.close(competitor)
        self.assertEqual(self.effects, [])
        self.assertFalse(any(n.startswith(epochs.PREFIX) for n in os.listdir(self.tmp.name)))

    def test_identity_and_fence_change(self):
        with journal_module.Journal(self.tmp.name) as journal:
            fence = iter(['lease', 'lease', 'other'])
            with self.assertRaises(epochs.EpochError):
                self.run_epoch(journal, fence=lambda: next(fence))
        self.assertEqual(self.effects, [])


if __name__ == '__main__':
    unittest.main()
