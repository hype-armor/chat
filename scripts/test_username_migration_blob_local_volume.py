import errno
import json
import os
import tempfile
import unittest
from unittest import mock

import username_migration_blob_local_volume as volume


class CaptureTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = os.path.join(self.temp.name, 'volumes')
        self.source = os.path.join(self.root, 'data', '_data')
        self.workspace = os.path.join(self.temp.name, 'workspace')
        os.makedirs(self.source, mode=0o700)
        os.mkdir(self.workspace, 0o700)
        with open(os.path.join(self.source, 'file'), 'w') as stream:
            stream.write('synthetic')
        self.info = {'Name': 'data', 'Driver': 'local', 'Scope': 'local',
                     'Mountpoint': self.source, 'Options': None}
        self.mounts = []
        self.inspections = 0
        self.after = None

    def runner(self, args):
        if args[:2] == ['volume', 'inspect']:
            self.inspections += 1
            info = self.after if self.inspections > 1 and self.after else self.info
            return json.dumps([info]).encode()
        if args[0] == 'ps':
            return (('a' * 64 + '\n') if self.mounts else '').encode()
        if args[:2] == ['container', 'inspect']:
            return json.dumps([{'Id': 'a' * 64, 'State': {'Running': True},
                                'Mounts': self.mounts}]).encode()
        raise AssertionError(args)

    def capture(self, **overrides):
        limits = dict(max_archive_size=1024 * 1024, max_entries=100,
                      max_file_bytes=1024 * 1024, max_path_depth=10,
                      max_path_bytes=1024, max_xattr_bytes=1024)
        limits.update(overrides)
        return volume._capture('data', self.workspace, 'backup.tar', root=self.root,
                               owner=os.geteuid(), runner=self.runner, test_root=True,
                               **limits)

    def test_real_archive_and_no_overwrite(self):
        path = self.capture()
        self.assertTrue(os.path.isfile(path))
        self.assertEqual(self.inspections, 2)
        with self.assertRaises(FileExistsError):
            self.capture()
        self.assertEqual(os.listdir(self.workspace), ['backup.tar'])

    def test_unrestorable_link_does_not_publish(self):
        os.symlink('file', os.path.join(self.source, 'link'))
        with self.assertRaises(volume.snapshot.RestoreError):
            self.capture()
        self.assertEqual(os.listdir(self.workspace), [])

    def test_post_inspection_failure_does_not_publish(self):
        self.after = dict(self.info, Driver='other')
        with self.assertRaises(volume.VolumeError):
            self.capture()
        self.assertEqual(os.listdir(self.workspace), [])

    def test_reject_access_and_unknown_mount(self):
        for mount in ({'Type': 'bind', 'Source': self.root},
                      {'Type': 'bind', 'Source': self.source + '/child'},
                      {'Type': 'tmpfs', 'Source': '/elsewhere'},
                      {'Type': 'bind', 'Source': '/elsewhere', 'surprise': 1}):
            with self.subTest(mount=mount):
                self.mounts = [mount]
                with self.assertRaises(volume.VolumeError):
                    self.capture()
        self.assertEqual(os.listdir(self.workspace), [])

    def test_reject_symlink_and_options(self):
        self.info['Options'] = {'device': '/elsewhere'}
        with self.assertRaises(volume.VolumeError):
            self.capture()
        self.info['Options'] = None
        os.rename(self.source, self.source + '-real')
        os.symlink(self.source + '-real', self.source)
        with self.assertRaises(volume.VolumeError):
            self.capture()

    def test_limits_are_required_and_enforced(self):
        with self.assertRaises(TypeError):
            volume.capture('data', self.workspace, 'backup.tar')
        for limits in ({'max_archive_size': None}, {'max_entries': 0},
                       {'max_file_bytes': 1}, {'max_path_depth': 0},
                       {'max_path_bytes': 1}, {'max_xattr_bytes': -1},
                       {'max_archive_size': 1}):
            with self.subTest(limits=limits), self.assertRaises(Exception):
                self.capture(**limits)
            self.assertEqual(os.listdir(self.workspace), [])

    def test_large_limits_and_insufficient_space(self):
        # Simulate large capacity without allocating a large archive.
        huge = 1024 ** 4
        with mock.patch.object(volume.os, 'statvfs', return_value=mock.Mock(f_bavail=huge, f_frsize=4096)):
            self.capture(max_archive_size=512 * 1024 ** 2)
        os.unlink(os.path.join(self.workspace, 'backup.tar'))
        with mock.patch.object(volume.os, 'statvfs', return_value=mock.Mock(f_bavail=1, f_frsize=1)):
            with self.assertRaises(volume.VolumeError):
                self.capture()
        self.assertEqual(os.listdir(self.workspace), [])

    def test_enospc_never_publishes(self):
        with mock.patch.object(volume.snapshot, 'snapshot_and_validate',
                               side_effect=OSError(errno.ENOSPC, 'full')):
            with self.assertRaises(OSError):
                self.capture()
        self.assertEqual(os.listdir(self.workspace), [])

    def test_docker_forces_unix_socket(self):
        result = mock.Mock(returncode=0, stdout=b'[]')
        with mock.patch.dict(os.environ, {'DOCKER_HOST': 'tcp://remote', 'DOCKER_CONTEXT': 'remote'}), \
             mock.patch.object(volume.subprocess, 'run', return_value=result) as run:
            volume._docker(['volume', 'inspect', 'data'])
        args, kwargs = run.call_args
        self.assertEqual(args[0][:3], ['docker', '--host', 'unix:///var/run/docker.sock'])
        self.assertNotIn('DOCKER_HOST', kwargs['env'])
        self.assertNotIn('DOCKER_CONTEXT', kwargs['env'])


if __name__ == '__main__':
    unittest.main()
