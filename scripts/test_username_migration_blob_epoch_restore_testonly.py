import copy
import importlib.util
import os
import tempfile
import unittest
import uuid
from pathlib import Path
from unittest import mock

from test_username_migration_blob_fenced_restore_testonly import FencedRestoreTest
from username_migration_blob_tree import inventory
from username_migration_blob_epoch_restore_testonly import restore_epoch_testonly, operational
from username_migration_recovery_epoch_model_testonly import Identity
import username_migration_recovery_epoch_durable_testonly as epochs
import username_migration_mount_check_testonly as mounts

spec = importlib.util.spec_from_file_location('epoch_journal', os.path.join(os.path.dirname(__file__), 'username-migration-journal.py'))
journal_module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(journal_module)


class EpochRestoreTests(unittest.TestCase):
    def setUp(self):
        # Reuse the small disposable archive fixture, not its test methods.
        self.fixture = FencedRestoreTest('test_journal_and_identity_gate')
        self.fixture.setUp()
        self.addCleanup(self.fixture.doCleanups)
        f = self.fixture
        self.journal_dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.journal_dir.cleanup)
        self.operation = str(uuid.uuid4())
        with journal_module.Journal(self.journal_dir.name) as journal:
            journal.begin(self.operation)
            for phase in ('fence', 'backup', 'migrate'):
                journal.advance(phase)
            journal.begin_rollback()
        self.identity = Identity('fake', 'fake-fs', 'blob', 'fake-metadata', f.dest.stat().st_ino)
        self.lease = 'fake-lease'
        self.original = f.workspace / 'original-intent'
        self.original.write_text('original evidence')

    def run_attempt(self, journal, number, mount='100', actual_mount=None, **changes):
        f = self.fixture
        args = dict(journal=journal, evidence_digest=f.digest, mount_id=mount, number=number,
                    authority=lambda operation, digest: self.identity,
                    fence=lambda: self.lease, original_intent_path=self.original,
                    resolve_prior=lambda context: True,
                    verify_evidence=lambda state, digest, snapshot_hash, expected, original:
                        digest == f.digest and snapshot_hash == f.digest and expected == inventory(f.source)
                        and original == str(self.original) and self.original.read_text() == 'original evidence',
                    verify_mount=lambda phase, mount_id, volume, device_inode, identity:
                        mount_id == mount and volume == 'blob' and device_inode == (f.dest.stat().st_dev, f.dest.stat().st_ino),
                    synthetic_volume_root=f.volumes, volume_name='blob', source=f.source,
                    workspace=f.workspace, snapshot=f.archive, snapshot_sha256=f.digest,
                    expected_inventory=inventory(f.source),
                    inspect_fake_docker=lambda: copy.deepcopy(f.data),
                    max_archive_size=1024 * 1024, max_entries=100, max_depth=10, max_path_bytes=4096)
        args.update(changes)
        with mock.patch.object(mounts, 'mount_id', side_effect=actual_mount or (lambda fd: int(mount))):
            return restore_epoch_testonly(**args)

    def test_evidence_callback_cannot_mutate_inventory(self):
        expected = inventory(self.fixture.source)
        before = inventory(self.fixture.dest)
        def mutate(state, digest, snapshot_hash, received, original):
            received['changed'] = True
            return True
        with journal_module.Journal(self.journal_dir.name) as journal:
            with self.assertRaises(epochs.EpochError):
                self.run_attempt(journal, 1, expected_inventory=expected, verify_evidence=mutate)
        self.assertEqual(inventory(self.fixture.dest), before)
        self.assertFalse(Path(str(self.original) + '.epoch-000001').exists())

    def test_authority_journal_mutation_stops_before_clear(self):
        phase = [None]
        changed = [False]
        intent = Path(str(self.original) + '.epoch-000001')
        with journal_module.Journal(self.journal_dir.name) as journal:
            def verify_mount(current, mount, volume, device_inode, identity):
                phase[0] = current
                return True
            def authority(operation, digest):
                if phase[0] == 'clear' and not changed[0]:
                    changed[0] = True
                    journal.advance('old_ready')
                return self.identity
            with self.assertRaises(Exception):
                self.run_attempt(journal, 1, authority=authority, verify_mount=verify_mount)
        with journal_module.Journal(self.journal_dir.name) as journal:
            self.assertEqual(journal.load()['phase'], 'old_ready')
        self.assertTrue(changed[0])
        self.assertEqual((self.fixture.dest / 'old').read_text(), 'old')
        self.assertTrue(intent.exists())
        self.assertTrue(Path(self.journal_dir.name, epochs.PREFIX + '000001.json').exists())
        self.assertEqual(self.original.read_text(), 'original evidence')

    def test_journal_file_changes_after_final_callback_stop_clear(self):
        for target, change in (('state.json', 'replace'), ('lock', 'replace'),
                               ('state.json', 'mode'), ('lock', 'mode'),
                               ('state.json', 'missing'), ('lock', 'missing')):
            with self.subTest(target=target, change=change), tempfile.TemporaryDirectory() as directory:
                operation = str(uuid.uuid4())
                with journal_module.Journal(directory) as journal:
                    journal.begin(operation)
                    for phase in ('fence', 'backup', 'migrate'):
                        journal.advance(phase)
                    journal.begin_rollback()
                phase = [None]
                changed = [False]
                path = Path(directory, target)
                def mount(current, *args):
                    phase[0] = current
                    return True
                def authority(operation, digest):
                    if phase[0] == 'clear' and not changed[0]:
                        changed[0] = True
                        if change == 'replace':
                            replacement = Path(directory, 'replacement')
                            replacement.write_bytes(path.read_bytes())
                            replacement.chmod(0o600)
                            os.replace(replacement, path)
                        elif change == 'mode':
                            path.chmod(0o640)
                        else:
                            os.rename(path, Path(directory, target + '.retained'))
                    return self.identity
                with journal_module.Journal(directory) as journal:
                    with self.assertRaises(Exception):
                        self.run_attempt(journal, 1, authority=authority, verify_mount=mount)
                self.assertTrue(changed[0])
                self.assertEqual((self.fixture.dest / 'old').read_text(), 'old')
                self.assertTrue(Path(directory, epochs.PREFIX + '000001.json').exists())
                self.assertTrue(Path(str(self.original) + '.epoch-000001').exists())
                Path(str(self.original) + '.epoch-000001').unlink()

    def test_reboot_retry_preserves_original_and_uses_new_intent(self):
        self.assertFalse(operational)
        def stop(phase):
            if phase == 'remove':
                raise RuntimeError('simulated crash')
        with journal_module.Journal(self.journal_dir.name) as journal:
            with self.assertRaises(RuntimeError):
                self.run_attempt(journal, 1, interrupt=stop)
        with journal_module.Journal(self.journal_dir.name) as journal:
            self.run_attempt(journal, 2, mount='200', resolve_prior=lambda context: True)
        self.assertEqual(inventory(self.fixture.dest), inventory(self.fixture.source))
        self.assertEqual(self.original.read_text(), 'original evidence')
        self.assertTrue(Path(str(self.original) + '.epoch-000001').exists())
        self.assertTrue(Path(str(self.original) + '.epoch-000002').exists())

    def test_rejections_have_no_destructive_effects(self):
        f = self.fixture
        with journal_module.Journal(self.journal_dir.name) as journal:
            for changes in (dict(evidence_digest=''), dict(number=2),
                            dict(fence=lambda: None), dict(authority=lambda op, digest: None)):
                args = dict(number=1)
                args.update(changes)
                with self.assertRaises(Exception):
                    self.run_attempt(journal, **args)
                self.assertEqual((f.dest / 'old').read_text(), 'old')
            # Publish an epoch without reaching a destructive phase.
            with self.assertRaises(RuntimeError):
                self.run_attempt(journal, 1, interrupt=lambda phase: (_ for _ in ()).throw(RuntimeError()) if phase == 'intent' else None)
            self.identity = Identity('fake', 'fake-fs', 'other-volume', 'fake-metadata', f.dest.stat().st_ino)
            with self.assertRaises(Exception):
                self.run_attempt(journal, 2, mount='200')
            self.assertTrue((f.dest / 'old').exists())
            with self.assertRaises(Exception):
                self.run_attempt(journal, 1)

    def test_evidence_must_bind_each_input(self):
        f = self.fixture
        with journal_module.Journal(self.journal_dir.name) as journal:
            for changes in (dict(verify_evidence=None), dict(evidence_digest='b' * 64),
                            dict(snapshot_sha256='b' * 64), dict(expected_inventory=[]),
                            dict(original_intent_path=f.workspace / 'other')):
                with self.assertRaises(Exception):
                    self.run_attempt(journal, 1, **changes)
                self.assertTrue((f.dest / 'old').exists())

    def test_mount_verification_required_at_each_gate(self):
        f = self.fixture
        with journal_module.Journal(self.journal_dir.name) as journal:
            with self.assertRaises(epochs.EpochError):
                self.run_attempt(journal, 1, verify_mount=None)
            calls = []
            def changed(phase, mount, volume, device_inode, identity):
                calls.append((phase, mount, volume, device_inode))
                return phase == 'publish'
            with self.assertRaises(Exception):
                self.run_attempt(journal, 1, verify_mount=changed)
            self.assertGreater(len(calls), 1)
            self.assertTrue((f.dest / 'old').exists())

    def test_resolver_receives_current_restore_bindings(self):
        seen = []
        with journal_module.Journal(self.journal_dir.name) as journal:
            self.run_attempt(journal, 1, resolve_prior=lambda ctx: seen.append(ctx) or True)
        ctx = seen[0]
        st = self.original.stat()
        dest = self.fixture.dest.stat()
        self.assertEqual(ctx.operation, self.operation)
        self.assertEqual(ctx.evidence_digest, self.fixture.digest)
        self.assertEqual(ctx.original_intent_identity, (st.st_dev, st.st_ino, st.st_size, st.st_mtime_ns, st.st_ctime_ns))
        self.assertEqual(ctx.destination_identity, (dest.st_dev, dest.st_ino, 'blob'))
        self.assertEqual((ctx.mount_id, ctx.number, ctx.prior), ('100', 1, ()))

    def test_resolution_includes_prior_intents_and_runs_at_restore_gates(self):
        with journal_module.Journal(self.journal_dir.name) as journal:
            with self.assertRaises(RuntimeError):
                self.run_attempt(journal, 1, interrupt=lambda phase: (_ for _ in ()).throw(RuntimeError()) if phase == 'intent' else None)
        seen = []
        with journal_module.Journal(self.journal_dir.name) as journal:
            def resolver(context):
                seen.append(context)
                return True
            self.run_attempt(journal, 2, resolve_prior=resolver)
        self.assertGreater(len(seen), 2)
        self.assertEqual(seen[0].original_intent_contents, b'original evidence')
        self.assertEqual(seen[0].prior_intents, ((str(self.original) + '.epoch-000001',
                                                Path(str(self.original) + '.epoch-000001').read_bytes()),))
        self.assertTrue(all(context == seen[0] for context in seen))

    def test_resolver_revocation_stops_before_clear(self):
        calls = []
        with journal_module.Journal(self.journal_dir.name) as journal:
            def resolver(context):
                calls.append(context)
                return len(calls) < 3
            with self.assertRaises(epochs.EpochError):
                self.run_attempt(journal, 1, resolve_prior=resolver)
        self.assertTrue((self.fixture.dest / 'old').exists())

    def test_prior_epoch_requires_explicit_resolution(self):
        with journal_module.Journal(self.journal_dir.name) as journal:
            with self.assertRaises(RuntimeError):
                self.run_attempt(journal, 1, interrupt=lambda phase: (_ for _ in ()).throw(RuntimeError()) if phase == 'intent' else None)
        with journal_module.Journal(self.journal_dir.name) as journal:
            with self.assertRaises(epochs.EpochError):
                self.run_attempt(journal, 2, resolve_prior=None)
            with self.assertRaises(epochs.EpochError):
                self.run_attempt(journal, 2, resolve_prior=lambda *args: False)
        self.assertTrue((self.fixture.dest / 'old').exists())

    def test_post_rename_fsync_uncertainty_requires_resolution(self):
        original_fsync = os.fsync
        with journal_module.Journal(self.journal_dir.name) as journal:
            def fail_dir(fd):
                if fd == journal.dirfd and Path(self.journal_dir.name, epochs.PREFIX + '000001.json').exists():
                    raise OSError('uncertain publication')
                return original_fsync(fd)
            with mock.patch.object(epochs.os, 'fsync', side_effect=fail_dir):
                with self.assertRaises(OSError):
                    self.run_attempt(journal, 1)
        with journal_module.Journal(self.journal_dir.name) as journal:
            with self.assertRaises(epochs.EpochError):
                self.run_attempt(journal, 2, resolve_prior=None)
            self.run_attempt(journal, 2, resolve_prior=lambda context: True)
        self.assertEqual(inventory(self.fixture.dest), inventory(self.fixture.source))

    def test_missing_epoch_after_uncertain_publication_requires_resolution(self):
        original_fsync = os.fsync
        with journal_module.Journal(self.journal_dir.name) as journal:
            def fail_dir(fd):
                if fd == journal.dirfd and Path(self.journal_dir.name, epochs.PREFIX + '000001.json').exists():
                    raise OSError('uncertain publication')
                return original_fsync(fd)
            with mock.patch.object(epochs.os, 'fsync', side_effect=fail_dir):
                with self.assertRaises(OSError):
                    self.run_attempt(journal, 1)
        Path(self.journal_dir.name, epochs.PREFIX + '000001.json').unlink()
        with journal_module.Journal(self.journal_dir.name) as journal:
            with self.assertRaises(epochs.EpochError):
                self.run_attempt(journal, 1, resolve_prior=None)
            self.run_attempt(journal, 1, resolve_prior=lambda context: context.prior == ())
        self.assertEqual(self.original.read_text(), 'original evidence')

    def test_actual_mount_id_mismatch_at_publish_and_restore(self):
        with journal_module.Journal(self.journal_dir.name) as journal:
            with self.assertRaises(epochs.EpochError):
                self.run_attempt(journal, 1, actual_mount=lambda fd: 999)
            calls = []
            def changed(fd):
                calls.append(fd)
                return 100 if len(calls) == 1 else 999
            with self.assertRaises(epochs.EpochError):
                self.run_attempt(journal, 1, actual_mount=changed)
        self.assertTrue((self.fixture.dest / 'old').exists())

    def test_independent_mapping_rejects_changed_device_inode_or_volume(self):
        f = self.fixture
        actual = (f.dest.stat().st_dev, f.dest.stat().st_ino)
        for expected, expected_volume in (((actual[0] + 1, actual[1]), 'blob'),
                                          ((actual[0], actual[1] + 1), 'blob'),
                                          (actual, 'changed-volume')):
            with self.subTest(expected=expected, volume=expected_volume):
                with journal_module.Journal(self.journal_dir.name) as journal:
                    with self.assertRaises(epochs.EpochError):
                        self.run_attempt(journal, 1, verify_mount=lambda phase, mount, volume, device_inode, identity:
                                         device_inode == expected and volume == expected_volume)
        self.assertTrue((f.dest / 'old').exists())

    def test_final_authority_mutations_stop_before_clear(self):
        f = self.fixture
        for target in ('journal', 'inventory', 'original', 'intent', 'epoch', 'destination', 'mount'):
            with self.subTest(target=target), tempfile.TemporaryDirectory() as directory:
                expected = inventory(f.source)
                phase, changed, mount = [None], [False], [100]
                intent = Path(str(self.original) + '.epoch-000001')
                def verify_mount(current, *args):
                    phase[0] = current
                    return True
                with journal_module.Journal(directory) as journal:
                    journal.begin(self.operation)
                    for step in ('fence', 'backup', 'migrate'):
                        journal.advance(step)
                    journal.begin_rollback()
                    def authority(operation, digest):
                        if phase[0] == 'clear' and not changed[0]:
                            changed[0] = True
                            if target == 'journal':
                                journal.advance('old_ready')
                            elif target == 'inventory':
                                expected['changed'] = True
                            elif target == 'original':
                                self.original.write_text('changed')
                            elif target == 'intent':
                                intent.write_bytes(b'changed')
                            elif target == 'epoch':
                                Path(directory, epochs.PREFIX + '000001.json').write_bytes(b'changed')
                            elif target == 'destination':
                                f.dest.rename(f.volumes / 'original')
                                f.dest.mkdir()
                            else:
                                mount[0] = 999
                        return self.identity
                    with self.assertRaises(Exception):
                        self.run_attempt(journal, 1, expected_inventory=expected,
                                         authority=authority, verify_mount=verify_mount,
                                         actual_mount=lambda fd: mount[0])
                self.assertTrue(changed[0])
                old = f.volumes / 'original' / 'old' if target == 'destination' else f.dest / 'old'
                self.assertEqual(old.read_text(), 'old')
                self.assertTrue(intent.exists())
                self.assertTrue(Path(directory, epochs.PREFIX + '000001.json').exists())
                if target == 'destination':
                    f.dest.rmdir()
                    (f.volumes / 'original').rename(f.dest)
                if target == 'original':
                    self.original.write_text('original evidence')
                intent.unlink()

    def test_final_authority_mutates_prior_intent(self):
        prior = Path(str(self.original) + '.epoch-000001')
        with journal_module.Journal(self.journal_dir.name) as journal:
            with self.assertRaises(RuntimeError):
                self.run_attempt(journal, 1, interrupt=lambda phase: (_ for _ in ()).throw(RuntimeError())
                                 if phase == 'intent' else None)
        phase, changed = [None], [False]
        def verify_mount(current, *args):
            phase[0] = current
            return True
        def authority(operation, digest):
            if phase[0] == 'clear' and not changed[0]:
                changed[0] = True
                prior.write_bytes(b'changed')
            return self.identity
        with journal_module.Journal(self.journal_dir.name) as journal:
            with self.assertRaises(epochs.EpochError):
                self.run_attempt(journal, 2, authority=authority, verify_mount=verify_mount)
        self.assertTrue(changed[0])
        self.assertEqual(prior.read_bytes(), b'changed')
        self.assertTrue(Path(str(self.original) + '.epoch-000002').exists())
        self.assertEqual((self.fixture.dest / 'old').read_text(), 'old')

    def test_inspector_mutations_stop_before_clear(self):
        f = self.fixture
        for target in ('inventory', 'epoch', 'intent', 'destination'):
            for replacement in ((False, True) if target in ('epoch', 'intent') else (False,)):
                with self.subTest(target=target, identical_replacement=replacement), tempfile.TemporaryDirectory() as directory:
                    expected = inventory(f.source)
                    phase = [None]
                    changed = [False]
                    intent = Path(str(self.original) + '.epoch-000001')
                    def verify_mount(current, mount, volume, device_inode, identity):
                        phase[0] = current
                        return True
                    def inspect():
                        if phase[0] == 'clear' and not changed[0]:
                            changed[0] = True
                            if target == 'inventory':
                                expected['changed'] = True
                            elif target == 'destination':
                                f.dest.rename(f.volumes / 'original')
                                f.dest.mkdir()
                            else:
                                path = intent if target == 'intent' else Path(directory, epochs.PREFIX + '000001.json')
                                if replacement:
                                    other = path.with_name('replacement')
                                    other.write_bytes(path.read_bytes())
                                    other.chmod(0o600)
                                    os.replace(other, path)
                                else:
                                    path.write_bytes(b'changed')
                        return copy.deepcopy(f.data)
                    with journal_module.Journal(directory) as journal:
                        journal.begin(self.operation)
                        for step in ('fence', 'backup', 'migrate'):
                            journal.advance(step)
                        journal.begin_rollback()
                        with self.assertRaises(Exception):
                            self.run_attempt(journal, 1, expected_inventory=expected,
                                             verify_mount=verify_mount, inspect_fake_docker=inspect)
                    self.assertTrue(changed[0])
                    if target == 'destination':
                        self.assertTrue((f.volumes / 'original' / 'old').exists())
                        f.dest.rmdir()
                        (f.volumes / 'original').rename(f.dest)
                    else:
                        self.assertEqual((f.dest / 'old').read_text(), 'old')
                    if intent.exists():
                        intent.unlink()

    def test_current_intent_tampering_stops_before_clear(self):
        intent = Path(str(self.original) + '.epoch-000001')
        for action in ('mutate', 'remove', 'replace', 'permissions'):
            with self.subTest(action=action), tempfile.TemporaryDirectory() as directory:
                def interrupt(phase):
                    if phase != 'intent':
                        return
                    if action == 'mutate':
                        intent.write_bytes(b'changed')
                    elif action == 'remove':
                        intent.unlink()
                    elif action == 'replace':
                        replacement = intent.with_name('replacement')
                        replacement.write_bytes(intent.read_bytes())
                        replacement.chmod(0o600)
                        os.replace(replacement, intent)
                    else:
                        intent.chmod(0o644)
                with journal_module.Journal(directory) as journal:
                    journal.begin(self.operation)
                    for phase in ('fence', 'backup', 'migrate'):
                        journal.advance(phase)
                    journal.begin_rollback()
                    with self.assertRaises(Exception):
                        self.run_attempt(journal, 1, interrupt=interrupt)
                self.assertTrue((self.fixture.dest / 'old').exists())
                self.assertTrue(Path(directory, epochs.PREFIX + '000001.json').exists())
                if intent.exists():
                    intent.unlink()

    def test_early_intent_and_noncanonical_publication_are_rejected(self):
        import username_migration_blob_disposable_restart as disposable
        intent = Path(str(self.original) + '.epoch-000001')
        with journal_module.Journal(self.journal_dir.name) as journal:
            def early(phase, mount, volume, device_inode, identity):
                intent.write_text('early')
                intent.chmod(0o600)
                return True
            with self.assertRaises(epochs.EpochError):
                self.run_attempt(journal, 1, verify_mount=early)
            self.assertEqual(intent.read_text(), 'early')
            intent.unlink()
            persist = disposable._persist
            def altered(path, record):
                persist(path, {**record, 'snapshot_sha256': 'wrong'})
            with mock.patch.object(disposable, '_persist', side_effect=altered):
                with self.assertRaises(epochs.EpochError):
                    self.run_attempt(journal, 1)
            self.assertIn('wrong', intent.read_text())
        self.assertTrue((self.fixture.dest / 'old').exists())

    def test_invalid_phase_and_ambiguous_publication(self):
        with journal_module.Journal(self.journal_dir.name) as journal:
            Path(self.journal_dir.name, '.epoch-testonly-uncertain').write_text('')
            with self.assertRaises(epochs.EpochError):
                self.run_attempt(journal, 1, resolve_prior=None)
        self.assertTrue((self.fixture.dest / 'old').exists())
        with tempfile.TemporaryDirectory() as other:
            with journal_module.Journal(other) as journal:
                journal.begin(str(uuid.uuid4()))
                with self.assertRaises(Exception):
                    self.run_attempt(journal, 1)
        self.assertTrue((self.fixture.dest / 'old').exists())


if __name__ == '__main__':
    unittest.main()
