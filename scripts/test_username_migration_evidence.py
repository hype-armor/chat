#!/usr/bin/env python3
"""Durable evidence tests; no live data."""
import importlib.util
import os
from pathlib import Path
import tempfile
import unittest
from unittest import mock
import uuid

import username_migration_evidence as evidence

spec = importlib.util.spec_from_file_location('journal', Path(__file__).with_name('username-migration-journal.py'))
journal_module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(journal_module)


class EvidenceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        root = Path(self.temp.name)
        self.directory, self.state = root / 'evidence', root / 'journal'
        self.directory.mkdir(mode=0o700)
        self.state.mkdir(mode=0o700)
        self.files = {}
        for key in evidence.REQUIRED:
            file = self.directory / key
            file.write_text('synthetic-' + key)
            file.chmod(0o600)
            self.files[key] = file.name
        self.operation_id = str(uuid.uuid4())

    def advance_to_backup(self, journal):
        journal.begin(self.operation_id)
        journal.advance('fence')
        journal.advance('backup')

    def test_seal_restore_retry_and_terminal_boundaries(self):
        with journal_module.Journal(self.state) as journal:
            self.advance_to_backup(journal)
            record = evidence.seal(journal, self.directory, self.files)
            self.assertEqual(evidence.seal(journal, self.directory, self.files), record)
            journal.advance('migrate')
            self.assertEqual(evidence.load(journal, self.directory), record)
            file = self.directory / self.files['database_archive']
            original = file.read_bytes()
            file.write_bytes(b'changed')
            with self.assertRaises(evidence.EvidenceError):
                evidence.load(journal, self.directory)
            file.write_bytes(original)
            journal.begin_rollback()
            self.assertEqual(evidence.load(journal, self.directory), record)
            journal.advance('old_ready')
            with self.assertRaises(evidence.EvidenceError):
                evidence.load(journal, self.directory)

    def test_failed_publication_and_symlink_fail_closed(self):
        with journal_module.Journal(self.state) as journal:
            self.advance_to_backup(journal)
            with mock.patch.object(evidence, '_rename_noreplace', side_effect=OSError('publication failed')):
                with self.assertRaises(OSError):
                    evidence.seal(journal, self.directory, self.files)
            self.assertFalse((self.directory / 'recovery_evidence.json').exists())
            file = self.directory / self.files['blob_archive']
            file.unlink()
            file.symlink_to(self.files['database_archive'])
            with self.assertRaises(OSError):
                evidence.seal(journal, self.directory, self.files)

    def test_post_commit_never_exposes_restore_evidence(self):
        with journal_module.Journal(self.state) as journal:
            self.advance_to_backup(journal)
            evidence.seal(journal, self.directory, self.files)
            for phase in ('migrate', 'start_new', 'committed'):
                journal.advance(phase)
            with self.assertRaises(evidence.EvidenceError):
                evidence.load(journal, self.directory)


if __name__ == '__main__':
    unittest.main()
