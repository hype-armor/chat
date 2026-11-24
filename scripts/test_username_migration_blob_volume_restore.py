import hashlib
import io
import json
import os
import tarfile
import tempfile
import unittest
from unittest import mock

import username_migration_blob_volume_restore as volume


class VolumeRestoreTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = os.path.join(self.tmp.name, 'volumes')
        self.source = os.path.join(self.root, 'weed', '_data')
        os.makedirs(self.source, mode=0o700)
        self.workspace = os.path.join(self.tmp.name, 'work')
        os.mkdir(self.workspace, 0o700)
        self.archive = os.path.join(self.tmp.name, 'archive.tar')
        self.containers = []

    def runner(self, args):
        if args == ['volume', 'inspect', 'weed']:
            return json.dumps([{'Name': 'weed', 'Driver': 'local', 'Scope': 'local',
                                'Mountpoint': self.source, 'Options': None}])
        if args == ['ps', '--all', '--quiet', '--no-trunc']:
            return '\n'.join(c['Id'] for c in self.containers)
        if args[:2] == ['container', 'inspect']:
            return json.dumps(self.containers)
        raise AssertionError(args)

    def make_tar(self, name='file', kind=tarfile.REGTYPE):
        with tarfile.open(self.archive, 'w') as tar:
            root = tarfile.TarInfo('.')
            root.type = tarfile.DIRTYPE
            tar.addfile(root)
            item = tarfile.TarInfo(name)
            item.type = kind
            if kind == tarfile.REGTYPE:
                item.size = 3
                tar.addfile(item, io.BytesIO(b'abc'))
            else:
                item.linkname = '../outside'
                tar.addfile(item)
        with open(self.archive, 'rb') as f:
            return hashlib.sha256(f.read()).hexdigest()

    def inspect(self):
        volume._inspect_all(self.runner, 'weed', self.source)

    def container(self, mount, running=False, restarting=False, policy='no'):
        return {'Id': 'a' * 64, 'State': {'Running': running, 'Restarting': restarting},
                'HostConfig': {'RestartPolicy': {'Name': policy}}, 'Mounts': [mount]}

    def named_mount(self):
        return {'Type': 'volume', 'Name': 'weed', 'Driver': 'local', 'Source': self.source}

    def test_inspection_rejects_active_and_restart_users(self):
        for kwargs in ({'running': True}, {'restarting': True}, {'policy': 'always'}):
            with self.subTest(kwargs=kwargs):
                self.containers = [self.container(self.named_mount(), **kwargs)]
                with self.assertRaises(volume.RestoreError):
                    self.inspect()
        self.containers = [self.container(self.named_mount())]
        self.inspect()

    def test_inspection_rejects_bind_alias_even_stopped(self):
        alias = os.path.join(self.tmp.name, 'alias')
        os.symlink(self.source, alias)
        self.containers = [self.container({'Type': 'bind', 'Source': alias})]
        with self.assertRaises(volume.RestoreError):
            self.inspect()

    def test_tar_validation_rejects_unsafe_paths_and_links(self):
        for name, kind in [('../escape', tarfile.REGTYPE), ('link', tarfile.SYMTYPE)]:
            with self.subTest(name=name):
                self.make_tar(name, kind)
                fd = os.open(self.archive, os.O_RDONLY)
                try:
                    with self.assertRaises(volume.RestoreError):
                        volume._validate_archive(fd)
                finally:
                    os.close(fd)

    def test_valid_archive_and_bad_digest(self):
        digest = self.make_tar()
        fd = os.open(self.archive, os.O_RDONLY)
        try:
            volume._validate_archive(fd)
        finally:
            os.close(fd)
        with self.assertRaisesRegex(volume.RestoreError, 'digest mismatch'):
            volume._stage_verity(self.archive, '0' * 64, self.workspace)
        self.assertEqual(os.listdir(self.workspace), [])
        # This depends on actual fs-verity support; unsupported filesystems
        # must fail closed, not fall back to a mutable staging file.
        try:
            fd = volume._stage_verity(self.archive, digest, self.workspace)
        except volume.RestoreError as exc:
            self.assertIn('fs-verity staging unavailable', str(exc))
        else:
            try:
                volume._validate_archive(fd)
            finally:
                os.close(fd)
        self.assertEqual(os.listdir(self.workspace), [])

    def test_preflight_requires_boundary_and_restore_is_disabled(self):
        with self.assertRaises(volume.RestoreError):
            volume.preflight(archive_path=self.archive, trusted_sha256='0' * 64,
                             workspace=self.workspace, volume_name='weed', volume_root=self.root,
                             runner=self.runner, boundary_check=lambda: False)
        with self.assertRaises(volume.RestoreError):
            volume.restore()
        self.assertFalse(volume.operational)

    def test_unavailable_verity_fails_closed(self):
        digest = self.make_tar()
        with mock.patch.object(volume.fcntl, 'ioctl', side_effect=OSError('unsupported')):
            with self.assertRaisesRegex(volume.RestoreError, 'fs-verity'):
                volume._stage_verity(self.archive, digest, self.workspace)
        self.assertEqual(os.listdir(self.workspace), [])


if __name__ == '__main__':
    unittest.main()
