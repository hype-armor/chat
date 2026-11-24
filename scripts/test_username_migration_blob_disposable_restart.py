import hashlib
import io
import json
import os
from pathlib import Path
import subprocess
import tarfile
import tempfile
import unittest
from unittest import mock

import username_migration_blob_disposable_restart as restart
import username_migration_mount_check_testonly as mount_check
from username_migration_blob_tree_sync_testonly import sync_synthetic_tree, TreeSyncError

from username_migration_blob_tree import inventory
from username_migration_blob_disposable_restart import restore, RestoreError, operational


class DisposableRestoreTest(unittest.TestCase):
    def setUp(self):
        patcher = mock.patch.object(mount_check, 'mount_id', return_value=42)
        self.mount_id = patcher.start()
        self.addCleanup(patcher.stop)
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.source = self.root / 'source'
        self.source.mkdir()
        (self.source / 'file').write_text('snapshot')
        self.archive = self.root / 'snapshot.tar'
        subprocess.run(['tar', '--create', '--file', str(self.archive), '--acls',
                        '--xattrs', '-C', str(self.source), '.'], check=True)
        self.digest = hashlib.sha256(self.archive.read_bytes()).hexdigest()
        self.expected = inventory(self.source)
        self.dest = self.root / 'destination'
        self.dest.mkdir()
        (self.dest / 'old').write_text('old')
        self.intent = self.root / 'intent.json'
        self.workspace = self.root / 'workspace'
        self.workspace.mkdir(mode=0o700)

    def run_restore(self, interrupt=None, fence=lambda phase: True, **limits):
        opts = {'max_archive_size': 1024 * 1024, 'max_entries': 100,
                'max_depth': 10, 'max_path_bytes': 4096}
        opts.update(limits)
        restore(self.archive, self.digest, self.expected, self.dest, self.intent,
                fence, interrupt, workspace=self.workspace, **opts)

    def test_intent_publication_failures_preserve_evidence(self):
        for failure in ('write', 'file_fsync', 'replace', 'directory_fsync'):
            with self.subTest(failure=failure), tempfile.TemporaryDirectory() as directory:
                parent = Path(directory)
                intent = parent / 'intent'
                intent.write_text('existing evidence')
                old_temp = parent / '.restore-intent-old'
                old_temp.write_text('older evidence')
                real_fsync = os.fsync
                synced_directories = []
                def fsync(fd):
                    is_directory = os.path.isdir('/proc/self/fd/' + str(fd))
                    if is_directory:
                        synced_directories.append(True)
                    if (failure == 'file_fsync' and not is_directory or
                            failure == 'directory_fsync' and is_directory):
                        raise OSError('injected fsync failure')
                    return real_fsync(fd)
                def fail_write(record, stream, **kwargs):
                    stream.write('partial evidence')
                    raise OSError('injected write failure')
                with mock.patch.object(restart.os, 'fsync', side_effect=fsync), \
                     mock.patch.object(restart.json, 'dump', side_effect=fail_write if failure == 'write' else json.dump), \
                     mock.patch.object(restart.os, 'replace', side_effect=OSError('injected replace failure') if failure == 'replace' else os.replace):
                    with self.assertRaisesRegex(OSError, 'injected'):
                        restart._persist(str(intent), {'new': 'record'})
                self.assertEqual(old_temp.read_text(), 'older evidence')
                self.assertTrue(synced_directories)
                new_temps = set(parent.glob('.restore-intent-*')) - {old_temp}
                if failure == 'directory_fsync':
                    self.assertEqual(json.loads(intent.read_text()), {'new': 'record'})
                    self.assertFalse(new_temps)
                else:
                    self.assertEqual(intent.read_text(), 'existing evidence')
                    self.assertEqual(len(new_temps), 1)
                    if failure == 'write':
                        self.assertEqual(new_temps.pop().read_text(), 'partial evidence')
                    else:
                        self.assertEqual(json.loads(new_temps.pop().read_text()), {'new': 'record'})

    def test_retry_each_step(self):
        self.assertFalse(operational)
        for step in ('intent', 'remove', 'clear', 'extract'):
            (self.dest / 'extra').write_text('remove on retry')
            def stop(current):
                if current == step:
                    raise RuntimeError('interrupted')
            with self.assertRaises(RuntimeError):
                self.run_restore(stop)
            self.run_restore()
            self.assertEqual(inventory(self.dest), self.expected)

    def test_sync_failure_and_fence_failure_leave_intent_for_retry(self):
        for failure in ('fsync', 'fence'):
            def sync_with_failure(root, fence, **limits):
                def fail_fsync(fd):
                    raise OSError('injected fsync failure')
                return sync_synthetic_tree(root, fence, fsync=fail_fsync, **limits)
            def fence(phase):
                return phase != 'sync'
            with self.subTest(failure=failure):
                if failure == 'fsync':
                    with mock.patch.object(restart, 'sync_synthetic_tree', sync_with_failure):
                        with self.assertRaises(TreeSyncError):
                            self.run_restore()
                else:
                    with self.assertRaises(RestoreError):
                        self.run_restore(fence=fence)
                self.assertTrue(self.intent.is_file())
                (self.dest / 'retry-marker').write_text('must be cleared')
                self.run_restore()
                self.assertEqual(inventory(self.dest), self.expected)
                self.assertTrue(self.intent.is_file())

    def test_sync_runs_after_inventory_and_before_completion(self):
        phases = []
        calls = []
        def observe_sync(root, fence, **limits):
            self.assertEqual(inventory(root), self.expected)
            def record(fd):
                calls.append(os.readlink('/proc/self/fd/' + str(fd)))
                os.fsync(fd)
            return sync_synthetic_tree(root, fence, fsync=record, **limits)
        with mock.patch.object(restart, 'sync_synthetic_tree', observe_sync):
            self.run_restore(fence=lambda phase: phases.append(phase) or True)
        self.assertEqual(calls, [str(self.dest / 'file'), str(self.dest)])
        self.assertLess(phases.index('verify'), phases.index('sync'))
        self.assertLess(phases.index('sync'), phases.index('complete'))

    def test_mount_drift_during_sync_aborts_and_retry_succeeds(self):
        for failure in ('mismatch', 'unsupported', 'fence'):
            with self.subTest(failure=failure):
                phases = []
                def sync_with_drift(root, fence, **limits):
                    self.assertEqual(limits['root_mount_id'], 42)
                    def drift(fd):
                        if os.readlink('/proc/self/fd/' + str(fd)) == str(self.dest / 'file'):
                            if failure == 'unsupported':
                                raise mount_check.Unsupported('no statx')
                            return 43
                        return 42
                    def lost_fence():
                        raise RestoreError('fence lost')
                    with mock.patch.object(mount_check, 'mount_id', side_effect=drift if failure != 'fence' else None,
                                           return_value=42):
                        return sync_synthetic_tree(root, lost_fence if failure == 'fence' else fence, **limits)
                with mock.patch.object(restart, 'sync_synthetic_tree', sync_with_drift):
                    with self.assertRaises((TreeSyncError, mount_check.Unsupported, RestoreError)):
                        self.run_restore(fence=lambda phase: phases.append(phase) or True)
                self.assertNotIn('complete', phases)
                self.assertEqual(json.loads(self.intent.read_text())['root_mount_id'], 42)
                self.run_restore()
                self.assertEqual(inventory(self.dest), self.expected)

    def test_sync_limits_leave_intent_for_retry(self):
        for limits in ({'max_depth': 0}, {'max_path_bytes': 0}):
            with self.subTest(limits=limits):
                with self.assertRaises(mount_check.UnsafeTree):
                    self.run_restore(**limits)
                self.assertTrue(self.intent.is_file())
                self.run_restore()
                self.assertEqual(inventory(self.dest), self.expected)

    def test_source_replaced_after_preflight(self):
        def fence(phase):
            if phase == 'extract':
                self.archive.write_bytes(b'changed')
            return True
        self.run_restore(fence=fence)
        self.assertEqual(inventory(self.dest), self.expected)

    def test_invalid_limits_digest_and_inventory_preserve_destination(self):
        for options in ({'max_archive_size': 1}, {'max_entries': 1}):
            with self.assertRaises(RestoreError):
                self.run_restore(**options)
            self.assertTrue((self.dest / 'old').exists())
        self.digest = '0' * 64
        with self.assertRaises(RestoreError):
            self.run_restore()
        self.digest = hashlib.sha256(self.archive.read_bytes()).hexdigest()
        self.expected = {}
        with self.assertRaises(RestoreError):
            self.run_restore()
        self.assertTrue((self.dest / 'old').exists())

    def test_unsafe_archives_rejected_before_extract(self):
        for name, kind in [('link', tarfile.SYMTYPE), ('../escape', tarfile.REGTYPE),
                           ('hard', tarfile.LNKTYPE)]:
            with tarfile.open(self.archive, 'w') as tar:
                root = tarfile.TarInfo('.')
                root.type = tarfile.DIRTYPE
                tar.addfile(root)
                entry = tarfile.TarInfo(name)
                entry.type = kind
                entry.linkname = 'file'
                tar.addfile(entry, io.BytesIO(b''))
            self.digest = hashlib.sha256(self.archive.read_bytes()).hexdigest()
            with self.assertRaises(RestoreError):
                self.run_restore()
            self.assertTrue((self.dest / 'old').exists())
            self.assertFalse(self.intent.exists())

    def test_identity_and_intent_protection(self):
        self.intent.symlink_to(self.root / 'outside')
        with self.assertRaises(OSError):
            self.run_restore()
        self.intent.unlink()
        def stop(step):
            if step == 'intent':
                raise RuntimeError()
        with self.assertRaises(RuntimeError):
            self.run_restore(stop)
        self.dest.rename(self.root / 'original')
        self.dest.mkdir()
        with self.assertRaises(RestoreError):
            self.run_restore()
        self.assertTrue((self.root / 'original' / 'old').exists())

    def test_fence_rejection(self):
        def fence(phase):
            if phase == 'clear':
                raise RuntimeError('fence')
            return True
        with self.assertRaises(RuntimeError):
            self.run_restore(fence=fence)
        self.assertTrue((self.dest / 'old').exists())
        with self.assertRaises(RestoreError):
            self.run_restore(fence=lambda phase: False)
        self.assertTrue((self.dest / 'old').exists())

    def test_mount_failures_preserve_intent_and_do_not_complete(self):
        for phase in ('clear', 'extract', 'sync'):
            with self.subTest(phase=phase):
                phases = []
                def fence(current):
                    phases.append(current)
                    return True
                original = mount_check.check_tree
                def fail_tree(fd, **kwargs):
                    if phases[-1] == phase:
                        raise mount_check.UnsafeTree('injected mount boundary or identity drift')
                    return original(fd, **kwargs)
                with mock.patch.object(mount_check, 'check_tree', side_effect=fail_tree):
                    with self.assertRaises(mount_check.UnsafeTree):
                        self.run_restore(fence=fence)
                self.assertTrue(self.intent.exists())
                self.assertNotIn('complete', phases)
                if phase == 'clear':
                    self.assertTrue((self.dest / 'old').exists())
                self.run_restore()

    def test_mount_id_bound_to_intent_and_rechecked(self):
        def stop(step):
            if step == 'intent':
                raise RuntimeError('stop')
        with self.assertRaises(RuntimeError):
            self.run_restore(interrupt=stop)
        self.assertEqual(json.loads(self.intent.read_text())['root_mount_id'], 42)
        self.mount_id.return_value = 43
        with self.assertRaises(RestoreError):
            self.run_restore()
        self.assertTrue((self.dest / 'old').exists())
        self.assertTrue(self.intent.exists())

    def test_unsupported_statx_and_nested_mount(self):
        self.mount_id.side_effect = mount_check.Unsupported('no statx')
        with self.assertRaises(mount_check.Unsupported):
            self.run_restore()
        self.assertTrue((self.dest / 'old').exists())
        self.mount_id.side_effect = lambda fd: 43 if os.readlink('/proc/self/fd/' + str(fd)) == str(self.dest / 'old') else 42
        with self.assertRaises(mount_check.UnsafeTree):
            self.run_restore()
        self.assertTrue((self.dest / 'old').exists())
        self.assertTrue(self.intent.exists())

    def test_clear_does_not_follow_existing_symlink(self):
        outside = self.root / 'outside'
        outside.mkdir()
        (outside / 'keep').write_text('safe')
        (self.dest / 'external').symlink_to(outside, target_is_directory=True)
        with self.assertRaises(mount_check.UnsafeTree):
            self.run_restore()
        self.assertTrue(self.intent.exists())
        self.assertEqual((outside / 'keep').read_text(), 'safe')


if __name__ == '__main__':
    unittest.main()
