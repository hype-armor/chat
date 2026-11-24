import copy
import os
import tempfile
import tarfile
import unittest
from unittest import mock

import username_migration_compose_binds as binds
from username_migration_compose_binds import BindPolicyError, validate_bind_mounts, snapshot_bind_mounts, verify_bind_snapshots


class BindPolicyTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = self.tmp.name
        self.mount = {'type': 'bind', 'source': os.path.join(self.root, 'api-proxy.conf'),
                      'target': '/etc/nginx/conf.d/extra/api-proxy.conf', 'read_only': True,
                      'bind': {'create_host_path': True}}
        self.config = {'services': {'web': {'volumes': [self.mount]}}}

    def test_known_mounts(self):
        self.config['services']['web']['volumes'].append({
            'type': 'bind', 'source': os.path.join(self.root, 'tiles'),
            'target': '/srv/tiles', 'read_only': True})
        self.config['services']['https'] = {'volumes': [{
            'type': 'bind', 'source': os.path.join(self.root, 'Caddyfile'),
            'target': '/etc/caddy/Caddyfile', 'read_only': True}]}
        self.assertEqual(len(validate_bind_mounts(self.config, self.root)), 3)

    def test_rejects_unsafe_declarations(self):
        for changes in ({'read_only': False}, {'read_only': 1}, {'source': '/tmp/external'},
                        {'target': '/other'}, {'consistency': 'cached'}, {'bind': {'propagation': 'shared'}},
                        {'type': 'tmpfs'}, {'type': None}):
            config = copy.deepcopy(self.config)
            config['services']['web']['volumes'][0].update(changes)
            with self.subTest(changes=changes), self.assertRaises(BindPolicyError):
                validate_bind_mounts(config, self.root)

    def test_snapshots_actual_bind_file_and_directory(self):
        source = os.path.join(self.root, 'api-proxy.conf')
        with open(source, 'w') as stream:
            stream.write('synthetic proxy')
        os.chmod(source, 0o644)
        tiles = os.path.join(self.root, 'tiles')
        os.mkdir(tiles, 0o755)
        with open(os.path.join(tiles, 'tiles.dat'), 'wb') as stream:
            stream.write(b'synthetic tiles')
        self.config['services']['web']['volumes'].append({
            'type': 'bind', 'source': tiles, 'target': '/srv/tiles', 'read_only': True})
        parent = os.path.join(self.root, 'private')
        os.mkdir(parent, 0o700)
        output = os.path.join(parent, 'binds')
        rewritten, records = snapshot_bind_mounts(self.config, self.root, output)
        self.assertEqual(len(records), 2)
        for record in records:
            info = os.stat(record['source'])
            self.assertEqual(record['source_identity'], {'device': info.st_dev, 'inode': info.st_ino})
        self.assertTrue(verify_bind_snapshots(records, output))
        file_snapshot = rewritten['services']['web']['volumes'][0]['source']
        dir_snapshot = rewritten['services']['web']['volumes'][1]['source']
        with open(file_snapshot) as stream:
            self.assertEqual(stream.read(), 'synthetic proxy')
        self.assertEqual(os.stat(file_snapshot).st_mode & 0o777, 0o644)
        with open(os.path.join(dir_snapshot, 'tiles.dat'), 'rb') as stream:
            self.assertEqual(stream.read(), b'synthetic tiles')
        with open(source, 'w') as stream:
            stream.write('changed later')
        with open(file_snapshot) as stream:
            self.assertEqual(stream.read(), 'synthetic proxy')
        with self.assertRaises(FileExistsError):
            snapshot_bind_mounts(self.config, self.root, output)
        with open(file_snapshot, 'w') as stream:
            stream.write('changed snapshot')
        with self.assertRaises(BindPolicyError):
            verify_bind_snapshots(records, output)

    def test_oversized_file_and_low_space_fail_closed(self):
        with open(os.path.join(self.root, 'api-proxy.conf'), 'w') as stream:
            stream.write('synthetic')
        parent = os.path.join(self.root, 'private')
        os.mkdir(parent, 0o700)
        with mock.patch.object(binds, 'MAX_BIND_FILE', 3):
            with self.assertRaises(BindPolicyError):
                snapshot_bind_mounts(self.config, self.root, os.path.join(parent, 'too_large'))
        with mock.patch.object(binds.shutil, 'disk_usage', return_value=mock.Mock(free=0)):
            with self.assertRaises(BindPolicyError):
                snapshot_bind_mounts(self.config, self.root, os.path.join(parent, 'no_space'))

    def test_snapshot_rejects_symlink(self):
        os.symlink('/etc/passwd', os.path.join(self.root, 'api-proxy.conf'))
        parent = os.path.join(self.root, 'private')
        os.mkdir(parent, 0o700)
        with self.assertRaises(OSError):
            snapshot_bind_mounts(self.config, self.root, os.path.join(parent, 'binds'))

    def _directory_fixture(self):
        tiles = os.path.join(self.root, 'tiles')
        os.mkdir(tiles)
        with open(os.path.join(tiles, 'data'), 'wb') as stream:
            stream.write(b'synthetic')
        self.config['services']['web']['volumes'] = [{
            'type': 'bind', 'source': tiles, 'target': '/srv/tiles', 'read_only': True}]
        parent = os.path.join(self.root, 'private')
        os.mkdir(parent, 0o700)
        return tiles, os.path.join(parent, 'binds')

    def test_directory_above_old_limit_uses_disk_preflight(self):
        tiles, output = self._directory_fixture()
        real_inventory = binds.inventory
        def simulated_large(path, **limits):
            result = real_inventory(path, **limits)
            for entry in result['entries']:
                if entry['type'] == 'file':
                    entry['size'] = 257 * 1024 * 1024
            return result
        with mock.patch.object(binds, 'inventory', side_effect=simulated_large), \
             mock.patch.object(binds.shutil, 'disk_usage', return_value=mock.Mock(free=10**12)), \
             mock.patch.object(binds.disk_snapshot, 'snapshot_and_validate', wraps=binds.disk_snapshot.snapshot_and_validate) as preflight:
            _, records = snapshot_bind_mounts(self.config, self.root, output)
            self.assertTrue(verify_bind_snapshots(records, output))
            self.assertEqual(preflight.call_count, 1)

    def test_inventory_limits_propagate_to_every_pass(self):
        _, output = self._directory_fixture()
        limits = binds._inventory_limits()
        with mock.patch.object(binds, 'inventory', wraps=binds.inventory) as outer, \
             mock.patch.object(binds.blob_archive, 'inventory', wraps=binds.blob_archive.inventory) as inner:
            _, records = snapshot_bind_mounts(self.config, self.root, output)
            self.assertTrue(verify_bind_snapshots(records, output))
        self.assertEqual(outer.call_count, 4)
        self.assertEqual(inner.call_count, 3)
        for call in outer.call_args_list + inner.call_args_list:
            self.assertEqual(call.kwargs, limits)

    def test_directory_inventory_limit_rejects_before_file_hash(self):
        _, output = self._directory_fixture()
        with mock.patch.object(binds, 'MAX_BIND_TREE', 3), \
             mock.patch('username_migration_blob_tree.hashlib.sha256') as digest, \
             mock.patch.object(binds.blob_archive, 'capture') as capture:
            with self.assertRaisesRegex(Exception, 'file byte limit'):
                snapshot_bind_mounts(self.config, self.root, output)
        digest.assert_not_called()
        capture.assert_not_called()
        self.assertEqual(os.listdir(output), [])

    def test_directory_archive_hard_limit(self):
        tiles, output = self._directory_fixture()
        with mock.patch.object(binds, 'MAX_BIND_ARCHIVE', 512):
            with self.assertRaises(binds.blob_archive.ArchiveError):
                snapshot_bind_mounts(self.config, self.root, output)
        self.assertEqual(os.listdir(output), [])
        with open(os.path.join(tiles, 'data'), 'rb') as stream:
            self.assertEqual(stream.read(), b'synthetic')

    def test_directory_source_mutation_is_rejected(self):
        tiles, output = self._directory_fixture()
        real_capture = binds.blob_archive.capture
        def mutate(*args, **kwargs):
            archive = real_capture(*args, **kwargs)
            with open(os.path.join(tiles, 'data'), 'wb') as stream:
                stream.write(b'changed')
            return archive
        with mock.patch.object(binds.blob_archive, 'capture', side_effect=mutate):
            with self.assertRaises(BindPolicyError):
                snapshot_bind_mounts(self.config, self.root, output)
        self.assertFalse(os.path.exists(os.path.join(output, 'bind_0')))

    def test_directory_disk_full_and_malicious_archive_fail(self):
        tiles, output = self._directory_fixture()
        with mock.patch.object(binds.shutil, 'disk_usage', return_value=mock.Mock(free=0)):
            with self.assertRaises(BindPolicyError):
                snapshot_bind_mounts(self.config, self.root, output)
        def malicious(source, workspace, name, **kwargs):
            path = os.path.join(workspace, name)
            with tarfile.open(path, 'w') as tar:
                root = tarfile.TarInfo('.')
                root.type = tarfile.DIRTYPE
                tar.addfile(root)
                link = tarfile.TarInfo('./escape')
                link.type = tarfile.SYMTYPE
                link.linkname = '/tmp'
                tar.addfile(link)
            return path
        output = output + '_malicious'
        with mock.patch.object(binds.blob_archive, 'capture', side_effect=malicious):
            with self.assertRaises(binds.disk_snapshot.RestoreError):
                snapshot_bind_mounts(self.config, self.root, output)
        self.assertFalse(os.path.exists(os.path.join(output, 'bind_0')))

    def test_rejects_duplicate_and_short_syntax(self):
        self.config['services']['web']['volumes'].append(copy.deepcopy(self.mount))
        with self.assertRaises(BindPolicyError):
            validate_bind_mounts(self.config, self.root)
        self.config['services']['web']['volumes'] = ['./x:/x:ro']
        with self.assertRaises(BindPolicyError):
            validate_bind_mounts(self.config, self.root)


if __name__ == '__main__':
    unittest.main()
