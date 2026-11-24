import hashlib
import json
import os
import stat
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import patch

import username_migration_docker_pg_evidence as module


class EvidenceTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.path = self.tmp.name
        self.operation = 'operation_123456789'
        self.journal = SimpleNamespace(load=lambda: {'phase': 'backup', 'operation_id': self.operation})
        props = {'name': 'chat', 'owner': 'app', 'encoding': 'UTF8', 'collate': 'C', 'ctype': 'C',
                 'connection_limit': -1, 'comment': None, 'acl': [], 'settings': []}
        self.metadata = {'system_id': '12345', 'role': {'rolname': 'app', 'rolsuper': True,
            'rolpassword': None, 'rolinherit': True, 'rolcreatedb': True, 'rolcreaterole': True,
            'rolcanlogin': True, 'rolreplication': False, 'rolbypassrls': False,
            'rolconnlimit': -1, 'rolvaliduntil': None, 'settings': {}},
            'database': {'datname': 'chat', 'owner': 'app', 'encoding': 'UTF8', 'datcollate': 'C',
                         'datctype': 'C', 'datconnlimit': -1, 'datallowconn': True},
            'selected_database_properties': props, 'roles': ['app'], 'databases': ['chat'],
            'prepared': 0, 'memberships': 0}
        self.validation = {'version': 2, 'source_system_identifier': '12345', 'target_system_identifier': '67890',
            'status': 'MATCHED', 'operational': False, 'restore_authorized': False, 'container_id': 'a' * 64,
            'archive_sha256': hashlib.sha256(b'archive').hexdigest(), 'selected_database_properties': props.copy()}
        self.put('postgres.dump', b'archive')
        self.refresh()

    def put(self, name, data):
        with open(os.path.join(self.path, name), 'wb') as f:
            f.write(data)
        os.chmod(os.path.join(self.path, name), 0o600)

    def refresh(self):
        for name, obj in [('postgres-metadata.json', self.metadata), ('postgres-restore-check.json', self.validation)]:
            self.put(name, json.dumps(obj).encode())
        files = {}
        for key, name in module._FILES.items():
            with open(os.path.join(self.path, name), 'rb') as f:
                raw = f.read()
            files[key] = {'name': name, 'size': len(raw), 'sha256': hashlib.sha256(raw).hexdigest()}
        self.binding = {'version': 1, 'operation_id': self.operation, 'files': files,
                        'operational_restore_authorized': False}
        self.anchor_binding()

    def anchor_binding(self):
        raw = json.dumps(self.binding).encode()
        self.put(module._BINDING, raw)
        self.anchor = hashlib.sha256(raw).hexdigest()

    def verify(self, anchor=None):
        return module.verify_test_only(journal=self.journal, directory=self.path,
                                       independent_binding_sha256=self.anchor if anchor is None else anchor)

    def test_binder_retry_and_independent_digest(self):
        os.unlink(os.path.join(self.path, module._BINDING))
        digest = module.bind_test_only(journal=self.journal, directory=self.path)
        self.assertEqual(digest, module.bind_test_only(journal=self.journal, directory=self.path))
        result = module.verify_test_only(journal=self.journal, directory=self.path,
                                         independent_binding_sha256=digest)
        self.assertFalse(result['restore_authorized'])
        self.assertFalse(module.restore_authorized)

    def test_binder_cannot_create_after_backup_phase(self):
        binding = os.path.join(self.path, module._BINDING)
        os.unlink(binding)
        self.journal.load = lambda: {'phase': 'migrate', 'operation_id': self.operation}
        with self.assertRaises(module.VerificationError):
            module.bind_test_only(journal=self.journal, directory=self.path)
        self.assertFalse(os.path.exists(binding))
        self.journal.load = lambda: {'phase': 'backup', 'operation_id': self.operation}
        digest = module.bind_test_only(journal=self.journal, directory=self.path)
        self.journal.load = lambda: {'phase': 'migrate', 'operation_id': self.operation}
        self.assertEqual(module.bind_test_only(journal=self.journal, directory=self.path), digest)

    def test_binder_refuses_mismatch_and_invalid_candidate(self):
        binding = os.path.join(self.path, module._BINDING)
        with open(binding, 'rb') as f:
            original = f.read()
        with self.assertRaises(module.VerificationError):
            module.bind_test_only(journal=self.journal, directory=self.path)
        with open(binding, 'rb') as f:
            self.assertEqual(f.read(), original)
        os.unlink(binding)
        self.validation['archive_sha256'] = 'b' * 64
        self.refresh()
        os.unlink(binding)
        with self.assertRaises(module.VerificationError):
            module.bind_test_only(journal=self.journal, directory=self.path)
        self.assertFalse(os.path.exists(binding))

    def test_binder_directory_fsync_failure_can_retry(self):
        binding = os.path.join(self.path, module._BINDING)
        os.unlink(binding)
        fsync = os.fsync
        def fail_directory(fd):
            if stat.S_ISDIR(os.fstat(fd).st_mode):
                raise OSError('injected fsync failure')
            return fsync(fd)
        with patch.object(module.os, 'fsync', side_effect=fail_directory):
            with self.assertRaises(module.VerificationError):
                module.bind_test_only(journal=self.journal, directory=self.path)
        self.assertTrue(os.path.exists(binding))
        digest = module.bind_test_only(journal=self.journal, directory=self.path)
        self.assertEqual(len(digest), 64)

    def test_valid_and_disabled(self):
        self.assertEqual(self.verify()['restore_authorized'], False)
        self.assertFalse(module.operational)

    def test_independent_anchor_and_mutation(self):
        with self.assertRaises(module.VerificationError): self.verify('')
        self.put('postgres.dump', b'changed')
        with self.assertRaises(module.VerificationError): self.verify()
        self.put('postgres.dump', b'archive')
        self.put(module._BINDING, b'{}')
        with self.assertRaises(module.VerificationError): self.verify()

    def test_cross_file_mismatches(self):
        for key, value in [('source_system_identifier', '111'), ('target_system_identifier', '12345'),
                           ('archive_sha256', 'b' * 64), ('status', 'MATCHED!'), ('operational', True)]:
            with self.subTest(key=key):
                old = self.validation[key]
                self.validation[key] = value
                self.refresh()
                with self.assertRaises(module.VerificationError): self.verify()
                self.validation[key] = old
        self.validation['selected_database_properties']['collate'] = 'other'
        self.refresh()
        with self.assertRaises(module.VerificationError): self.verify()

    def test_bad_metadata_and_operation(self):
        self.metadata['role']['settings'] = {'bad setting': 'x'}
        self.refresh()
        with self.assertRaises(module.VerificationError): self.verify()
        self.metadata['role']['settings'] = {}
        self.metadata['prepared'] = False
        self.refresh()
        with self.assertRaises(module.VerificationError): self.verify()
        self.metadata['prepared'] = 0
        self.refresh()
        self.operation = 'different_operation'
        with self.assertRaises(module.VerificationError): self.verify()

    def test_untrusted_filename_and_symlink(self):
        self.binding['files']['archive']['name'] = '../postgres.dump'
        self.anchor_binding()
        with self.assertRaises(module.VerificationError): self.verify()
        self.refresh()
        os.unlink(os.path.join(self.path, 'postgres.dump'))
        os.symlink('postgres-metadata.json', os.path.join(self.path, 'postgres.dump'))
        with self.assertRaises(module.VerificationError): self.verify()

    def test_duplicate_json_key(self):
        self.put('postgres-metadata.json', b'{"system_id":"1","system_id":"2"}')
        name = 'postgres-metadata.json'
        with open(os.path.join(self.path, name), 'rb') as f: raw = f.read()
        self.binding['files']['metadata'] = {'name': name, 'size': len(raw), 'sha256': hashlib.sha256(raw).hexdigest()}
        self.anchor_binding()
        with self.assertRaises(module.VerificationError): self.verify()


if __name__ == '__main__':
    unittest.main()
