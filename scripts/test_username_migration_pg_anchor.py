import importlib.util
import os
import tempfile
import unittest
import uuid
from unittest import mock

import username_migration_pg_anchor as anchor

spec = importlib.util.spec_from_file_location('journal', os.path.join(os.path.dirname(__file__), 'username-migration-journal.py'))
journal_module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(journal_module)


class AnchorTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        os.chmod(self.temp.name, 0o700)
        self.operation = str(uuid.uuid4())
        self.digest = 'ab' * 32
        self.journal = journal_module.Journal(self.temp.name)
        self.journal.__enter__()
        self.addCleanup(self.temp.cleanup)
        self.addCleanup(self.journal.__exit__, None, None, None)
        self.journal.begin(self.operation)

    def backup(self):
        self.journal.advance('fence')
        self.journal.advance('backup')

    def test_create_retry_and_recovery(self):
        self.backup()
        self.assertEqual(anchor.store_anchor(self.journal, self.digest), self.digest)
        self.assertEqual(anchor.store_anchor(self.journal, self.digest), self.digest)
        path = os.path.join(self.temp.name, anchor._NAME)
        self.assertEqual(os.stat(path).st_mode & 0o777, 0o600)
        self.journal.advance('migrate')
        self.assertEqual(anchor.load_anchor(self.journal), self.digest)
        with self.assertRaises(anchor.AnchorError):
            anchor.store_anchor(self.journal, self.digest)
        self.journal.begin_rollback()
        self.assertEqual(anchor.load_anchor(self.journal), self.digest)

    def test_phase_and_validation(self):
        with self.assertRaises(anchor.AnchorError):
            anchor.store_anchor(self.journal, self.digest)
        self.backup()
        for digest in ('A' * 64, 'a' * 63, None):
            with self.assertRaises(anchor.AnchorError):
                anchor.store_anchor(self.journal, digest)
        anchor.store_anchor(self.journal, self.digest)
        with self.assertRaises(anchor.AnchorError):
            anchor.store_anchor(self.journal, 'c' * 64)
        self.journal.begin_rollback()
        with self.assertRaises(anchor.AnchorError):
            anchor.load_anchor(self.journal)

    def test_unsafe_and_mismatched_files(self):
        self.backup()
        path = os.path.join(self.temp.name, anchor._NAME)
        os.symlink('state.json', path)
        with self.assertRaises(OSError):
            anchor.store_anchor(self.journal, self.digest)
        os.unlink(path)
        anchor.store_anchor(self.journal, self.digest)
        os.chmod(path, 0o644)
        with self.assertRaises(journal_module.JournalError):
            anchor.load_anchor(self.journal)
        os.chmod(path, 0o600)
        with open(path, 'wb') as file:
            file.write(anchor._payload(str(uuid.uuid4()), self.digest))
        with self.assertRaises(anchor.AnchorError):
            anchor.load_anchor(self.journal)

    def test_failure_after_publish_requires_reopen(self):
        self.backup()
        original = anchor.os.fsync
        def fail_directory(fd):
            if fd == self.journal.dirfd and os.path.exists(os.path.join(self.temp.name, anchor._NAME)):
                raise OSError('injected')
            return original(fd)
        with mock.patch.object(anchor.os, 'fsync', side_effect=fail_directory):
            with self.assertRaises(OSError):
                anchor.store_anchor(self.journal, self.digest)
        self.assertTrue(self.journal.failed)
        with self.assertRaises(journal_module.JournalError):
            anchor.load_anchor(self.journal)
        self.journal.__exit__(None, None, None)
        with journal_module.Journal(self.temp.name) as reopened:
            self.assertEqual(anchor.store_anchor(reopened, self.digest), self.digest)

    def test_write_failure_and_closed_lock(self):
        self.backup()
        with mock.patch.object(anchor.os, 'write', side_effect=OSError('injected')):
            with self.assertRaises(OSError):
                anchor.store_anchor(self.journal, self.digest)
        self.assertTrue(self.journal.failed)
        self.journal.__exit__(None, None, None)
        with self.assertRaises(journal_module.JournalError):
            anchor.load_anchor(self.journal)


if __name__ == '__main__':
    unittest.main()
