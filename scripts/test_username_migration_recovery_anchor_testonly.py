"""Private fixture tests only; no Docker or deployment."""
import importlib.util
import os
from pathlib import Path
import tempfile
import unittest
from unittest import mock
import uuid

import username_migration_recovery_anchor_testonly as anchor

spec = importlib.util.spec_from_file_location('journal', Path(__file__).with_name('username-migration-journal.py'))
journal_module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(journal_module)


class RecoveryAnchorTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.operation = str(uuid.uuid4())
        self.values = {'postgres': 'a' * 64, 'blob': 'b' * 64, 'runtime': {'resources': 'c' * 64}}
        self.args = dict(boundary=lambda: 'same-fence',
                         verify_postgres=lambda: self.values['postgres'],
                         verify_blob=lambda: self.values['blob'],
                         verify_runtime=lambda: self.values['runtime'])
        with self.journal() as j:
            j.begin(self.operation)
            j.advance('fence')
            j.advance('backup')

    def journal(self):
        return journal_module.Journal(self.tmp.name)

    def test_retry_and_recovery_phases(self):
        with self.journal() as j:
            record = anchor.store_anchor(j, **self.args)
            self.assertEqual(record, anchor.store_anchor(j, **self.args))
            j.advance('migrate')
            self.assertEqual(record, anchor.verify_anchor(j, **self.args))
            j.advance('start_new')
            self.assertEqual(record, anchor.verify_anchor(j, **self.args))
            j.begin_rollback()
            self.assertEqual(record, anchor.verify_anchor(j, **self.args))

    def test_components_changed(self):
        with self.journal() as j:
            anchor.store_anchor(j, **self.args)
            for key, changed in [('postgres', 'd' * 64), ('blob', 'e' * 64),
                                 ('runtime', {'resources': 'f' * 64})]:
                old = self.values[key]
                self.values[key] = changed
                with self.subTest(key=key), self.assertRaises(anchor.AnchorError):
                    anchor.store_anchor(j, **self.args)
                self.values[key] = old

    def test_stable_replacement_fence_rejected_across_calls(self):
        with self.journal() as j:
            anchor.store_anchor(j, **self.args)
            replacement = dict(self.args, boundary=lambda: 'replacement-fence')
            with self.assertRaisesRegex(anchor.AnchorError, 'mismatch'):
                anchor.store_anchor(j, **replacement)
            j.advance('migrate')
            with self.assertRaisesRegex(anchor.AnchorError, 'mismatch'):
                anchor.verify_anchor(j, **replacement)
            anchor.verify_anchor(j, **self.args)

    def test_invalid_fence_tokens_rejected(self):
        with self.journal() as j:
            for token in ('', 'x' * (anchor._TOKEN_LIMIT + 1),
                          'é' * anchor._TOKEN_LIMIT, '\ud800', None):
                with self.subTest(token=repr(token)), self.assertRaisesRegex(anchor.AnchorError, 'invalid fence'):
                    anchor.store_anchor(j, **dict(self.args, boundary=lambda: token))
            self.assertFalse((Path(self.tmp.name) / anchor._NAME).exists())

    def test_changed_operation(self):
        with self.journal() as j:
            anchor.store_anchor(j, **self.args)
            state = j.load()
            state['operation_id'] = str(uuid.uuid4())
            j._save(state)
            with self.assertRaises(anchor.AnchorError):
                anchor.verify_anchor(j, **self.args)

    def test_missing_after_backup(self):
        with self.journal() as j:
            j.advance('migrate')
            with self.assertRaisesRegex(anchor.AnchorError, 'missing'):
                anchor.verify_anchor(j, **self.args)
            j.begin_rollback()
            with self.assertRaisesRegex(anchor.AnchorError, 'missing'):
                anchor.verify_anchor(j, **self.args)

    def test_callback_and_fence_failure_do_not_publish(self):
        with self.journal() as j:
            args = dict(self.args, verify_blob=mock.Mock(side_effect=RuntimeError('failure')))
            with self.assertRaises(RuntimeError):
                anchor.store_anchor(j, **args)
            self.assertFalse((Path(self.tmp.name) / anchor._NAME).exists())
            boundary = mock.Mock(side_effect=['fence', 'fence', 'other'])
            with self.assertRaisesRegex(anchor.AnchorError, 'fence'):
                anchor.store_anchor(j, **dict(self.args, boundary=boundary))
            self.assertFalse((Path(self.tmp.name) / anchor._NAME).exists())

    def test_ambiguous_directory_fsync_reopen_retry(self):
        with self.journal() as j:
            real = os.fsync
            published = False
            def fail_after_publish(fd):
                nonlocal published
                if fd == j.dirfd and (Path(self.tmp.name) / anchor._NAME).exists() and not published:
                    published = True
                    raise OSError('ambiguous fsync')
                return real(fd)
            with mock.patch.object(anchor.os, 'fsync', side_effect=fail_after_publish):
                with self.assertRaises(OSError):
                    anchor.store_anchor(j, **self.args)
            self.assertTrue(j.failed)
        with self.journal() as j:
            self.assertEqual(anchor.store_anchor(j, **self.args), anchor.verify_anchor(j, **self.args))


if __name__ == '__main__':
    unittest.main()
