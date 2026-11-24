import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import patch

import username_migration_source_snapshot_testonly as s


class SnapshotTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.base = Path(self.tmp.name)
        self.repo = self.base / 'repo'
        self.repo.mkdir()
        self.git('init', '-q')
        self.git('config', 'user.email', 'test@example.invalid')
        self.git('config', 'user.name', 'Test')
        (self.repo / 'file').write_text('committed')
        (self.repo / '.gitattributes').write_text('file export-ignore\n')
        (self.repo / 'exec').write_text('exec')
        (self.repo / 'exec').chmod(0o755)
        self.git('add', '.')
        self.git('commit', '-qm', 'test')
        self.commit = self.git('rev-parse', 'HEAD').strip()
        self.parent = self.base / 'private'
        self.parent.mkdir(mode=0o700)

    def git(self, *args):
        return subprocess.check_output(['git', '-C', str(self.repo), *args], stderr=subprocess.PIPE).decode()

    def build(self, commit=None):
        return s.build(self.repo, self.parent, commit or self.commit, 'operation-1')

    def test_worktree_and_attributes_do_not_affect_snapshot(self):
        (self.repo / 'file').write_text('dirty')
        (self.repo / 'untracked').write_text('secret')
        manifest = self.build()
        self.assertEqual((self.parent / 'snapshot/file').read_text(), 'committed')
        self.assertFalse((self.parent / 'snapshot/untracked').exists())
        self.assertEqual((self.parent / 'snapshot/exec').stat().st_mode & 0o777, 0o755)
        self.assertEqual(manifest['operation_id'], 'operation-1')
        self.assertEqual(manifest['commit'], self.commit)
        expected = s.entries(self.repo, self.commit)
        s.verify(self.parent / 'snapshot', expected)
        (self.parent / 'snapshot/file').write_text('mutated')
        with self.assertRaises(s.SnapshotError):
            s.verify(self.parent / 'snapshot', expected)
        (self.parent / 'snapshot/file').write_text('committed')
        (self.parent / 'snapshot/extra').touch()
        with self.assertRaises(s.SnapshotError):
            s.verify(self.parent / 'snapshot', expected)
        (self.parent / 'snapshot/extra').unlink()
        (self.parent / 'snapshot/file').chmod(0o600)
        with self.assertRaises(s.SnapshotError):
            s.verify(self.parent / 'snapshot', expected)
        (self.parent / 'snapshot/file').unlink()
        (self.parent / 'snapshot/file').symlink_to('../exec')
        with self.assertRaises(s.SnapshotError):
            s.verify(self.parent / 'snapshot', expected)

    def test_invalid_and_missing_objects(self):
        for commit in ('HEAD', '0' * 40, self.commit[:12]):
            with self.subTest(commit=commit), self.assertRaises(s.SnapshotError):
                self.build(commit)
        blob = self.git('rev-parse', 'HEAD:file').strip()
        obj = self.repo / '.git/objects' / blob[:2] / blob[2:]
        obj.unlink()
        with self.assertRaises(s.SnapshotError):
            self.build()

    def test_unsupported_entries(self):
        for name, content in [('badlink', None), ('.env.local', 'secret'), ('lfs', 'version https://git-lfs.github.com/spec/v1\noid sha256:abc\n')]:
            with self.subTest(name=name):
                path = self.repo / name
                if content is None:
                    path.symlink_to('file')
                else:
                    path.write_text(content)
                self.git('add', name)
                self.git('commit', '-qm', name)
                self.commit = self.git('rev-parse', 'HEAD').strip()
                with self.assertRaises(s.SnapshotError):
                    self.build()
                self.git('rm', '-q', name)
                self.git('commit', '-qm', 'remove')
        self.git('update-index', '--add', '--cacheinfo', '160000,' + self.commit + ',submodule')
        self.git('commit', '-qm', 'submodule')
        with self.assertRaises(s.SnapshotError):
            self.build(self.git('rev-parse', 'HEAD').strip())

    def test_replacement_object_is_ignored(self):
        original = self.git('rev-parse', 'HEAD:file').strip()
        (self.repo / 'replacement').write_text('replacement')
        replacement = self.git('hash-object', '-w', 'replacement').strip()
        self.git('replace', original, replacement)
        self.build()
        self.assertEqual((self.parent / 'snapshot/file').read_text(), 'committed')

    def test_manifest_verification_and_mutation(self):
        self.build()
        self.assertEqual(s.retry_verify_manifest(self.repo, self.parent, self.commit, 'operation-1')['commit'], self.commit)
        with self.assertRaises(s.SnapshotError):
            s.retry_verify_manifest(self.repo, self.parent, self.commit, 'other')
        manifest = self.parent / 'manifest.json'
        original = manifest.read_bytes()
        for data in (b'{', original.replace(b'operation-1', b'operation-2')):
            manifest.write_bytes(data)
            with self.assertRaises(s.SnapshotError):
                s.retry_verify_manifest(self.repo, self.parent, self.commit, 'operation-1')
        manifest.write_bytes(original)
        (self.parent / 'snapshot/file').write_text('changed after verification')
        with self.assertRaises(s.SnapshotError):
            s.retry_verify_manifest(self.repo, self.parent, self.commit, 'operation-1')

    def test_manifest_atime_change_is_ignored(self):
        self.build()
        manifest = self.parent / 'manifest.json'
        real_lstat = Path.lstat
        real_read = Path.read_bytes
        read = False

        def lstat(path, *args, **kwargs):
            result = real_lstat(path, *args, **kwargs)
            if path != manifest or not read:
                return result
            fields = ('st_dev', 'st_ino', 'st_mode', 'st_uid', 'st_gid',
                      'st_nlink', 'st_size', 'st_mtime_ns', 'st_ctime_ns')
            return SimpleNamespace(**{name: getattr(result, name) for name in fields},
                                   st_atime_ns=result.st_atime_ns + 1)

        def read_bytes(path):
            nonlocal read
            result = real_read(path)
            if path == manifest:
                read = True
            return result

        with patch.object(Path, 'lstat', lstat), patch.object(Path, 'read_bytes', read_bytes):
            s.retry_verify_manifest(self.repo, self.parent, self.commit, 'operation-1')
        self.assertTrue(read)

    def test_521_blob_build_and_retry_process_budget(self):
        # The three files from setUp plus 518 files give 521 blobs.
        for i in range(518):
            (self.repo / f'fixture-{i:03}').write_text(f'{i}\n')
        self.git('add', '.')
        self.git('commit', '-qm', '521 blob fixture')
        self.commit = self.git('rev-parse', 'HEAD').strip()
        required = 4 + 2 * 521
        real_start = s.GitBudget.start
        calls = []

        def count_start(budget):
            real_start(budget)
            calls.append(1)

        with patch.object(s.GitBudget, 'start', count_start):
            manifest = self.build()
            self.assertEqual(len(manifest['entries']), 521)
            self.assertEqual(len(calls), required)
            calls.clear()
            s.retry_verify_manifest(self.repo, self.parent, self.commit, 'operation-1')
            self.assertEqual(len(calls), required)

        # One less than required must stop before publication on build and
        # reject retry of an already published snapshot.
        other = self.base / 'other'
        other.mkdir(mode=0o700)
        with patch.object(s, 'MAX_GIT_PROCESSES', required - 1):
            with self.assertRaisesRegex(s.SnapshotError, 'Git process budget exceeded'):
                s.build(self.repo, other, self.commit, 'operation-1')
            self.assertFalse(any(other.iterdir()))
            with self.assertRaisesRegex(s.SnapshotError, 'Git process budget exceeded'):
                s.retry_verify_manifest(self.repo, self.parent, self.commit, 'operation-1')

    def test_total_git_budgets_fail_closed(self):
        real_popen = s.subprocess.Popen
        with patch.object(s, 'MAX_GIT_PROCESSES', 2), patch.object(s.subprocess, 'Popen', wraps=real_popen) as popen:
            with self.assertRaisesRegex(s.SnapshotError, 'process budget'):
                self.build()
            self.assertEqual(popen.call_count, 2)
        self.assertFalse(any(self.parent.iterdir()))

        clock = [0.0]
        real_git = s.git
        def advancing_git(*args, **kwargs):
            result = real_git(*args, **kwargs)
            clock[0] += 1
            return result
        with patch.object(s.time, 'monotonic', side_effect=lambda: clock[0]), \
             patch.object(s, 'TOTAL_GIT_DEADLINE_SECONDS', 2), \
             patch.object(s, 'git', side_effect=advancing_git):
            with self.assertRaisesRegex(s.SnapshotError, 'total Git deadline'):
                self.build()
        self.assertFalse(any(self.parent.iterdir()))

    def test_aggregate_output_and_manifest_limits(self):
        # Each command stays below its own limit, but their sum does not.
        with patch.object(s, 'MAX_TOTAL_GIT_OUTPUT_BYTES', 35):
            with self.assertRaisesRegex(s.SnapshotError, 'aggregate Git output'):
                self.build()
        self.assertFalse(any(self.parent.iterdir()))
        with patch.object(s, 'MAX_MANIFEST_BYTES', 10):
            with self.assertRaisesRegex(s.SnapshotError, 'manifest size'):
                self.build()

    def test_deadline_after_git_and_during_sync(self):
        clock = [0.0]
        real_entries = s.entries
        def expired_entries(*args, **kwargs):
            result = real_entries(*args, **kwargs)
            clock[0] = 100
            return result
        with patch.object(s.time, 'monotonic', side_effect=lambda: clock[0]), \
             patch.object(s, 'entries', side_effect=expired_entries):
            with self.assertRaisesRegex(s.SnapshotError, 'deadline'):
                self.build()
        self.assertFalse(any(self.parent.iterdir()))

        clock[0] = 0.0
        real_sync = s.sync_file
        calls = []
        def advancing_sync(path):
            calls.append(path)
            real_sync(path)
            clock[0] = 100.0
        with patch.object(s.time, 'monotonic', side_effect=lambda: clock[0]), \
             patch.object(s, 'sync_file', side_effect=advancing_sync):
            with self.assertRaisesRegex(s.SnapshotError, 'deadline'):
                self.build()
        self.assertTrue(calls)

    def test_aggregate_output_exact_boundaries(self):
        budget = s.GitBudget()
        budget.output_remaining = 12
        for remaining in (6, 0):
            self.assertEqual(s.git(self.repo, 'rev-parse', '--is-bare-repository', budget=budget), b'false\n')
            self.assertEqual(budget.output_remaining, remaining)
        with self.assertRaisesRegex(s.SnapshotError, 'aggregate Git output'):
            s.git(self.repo, 'rev-parse', '--is-bare-repository', budget=budget)

    def test_retry_uses_shared_output_budget(self):
        self.build()
        # A single command fits, but the complete retry must share its budget.
        with patch.object(s, 'MAX_TOTAL_GIT_OUTPUT_BYTES', 45):
            with self.assertRaisesRegex(s.SnapshotError, 'aggregate Git output'):
                s.retry_verify_manifest(self.repo, self.parent, self.commit, 'operation-1')

    def test_deadline_after_marker_removal_preserves_evidence(self):
        for point in ('unlink', 'final_sync'):
            with self.subTest(point=point), tempfile.TemporaryDirectory() as directory:
                parent = Path(directory)
                marker = parent / 'manifest.json.partial'
                clock = [0.0]
                real_unlink = Path.unlink
                real_sync = s.sync_dir
                parent_syncs = []
                def unlink(path, *args, **kwargs):
                    result = real_unlink(path, *args, **kwargs)
                    if path == marker and point == 'unlink':
                        clock[0] = 100.0
                    return result
                def sync(path):
                    result = real_sync(path)
                    if path == parent:
                        parent_syncs.append(path)
                        if len(parent_syncs) == 2 and point == 'final_sync':
                            clock[0] = 100.0
                    return result
                with patch.object(s.time, 'monotonic', side_effect=lambda: clock[0]), \
                     patch.object(Path, 'unlink', unlink), patch.object(s, 'sync_dir', side_effect=sync):
                    with self.assertRaisesRegex(s.SnapshotError, 'total Git deadline'):
                        s.build(self.repo, parent, self.commit, 'operation-1')
                self.assertTrue(marker.exists())
                self.assertEqual(len(parent_syncs), 2 if point == 'unlink' else 3)
                with self.assertRaises(s.SnapshotError):
                    s.verify_manifest(self.repo, parent, self.commit, 'operation-1')
                with self.assertRaises(s.SnapshotError):
                    s.retry_verify_manifest(self.repo, parent, self.commit, 'operation-1')

    def test_recreated_marker_sync_failure_preserves_original_error(self):
        real_sync = s.sync_dir
        parent_calls = 0
        def fail_sync(path):
            nonlocal parent_calls
            if path == self.parent:
                parent_calls += 1
                if parent_calls == 2:
                    raise OSError('original sync failure')
                if parent_calls == 3:
                    raise OSError('marker sync failure')
            return real_sync(path)
        with patch.object(s, 'sync_dir', side_effect=fail_sync):
            with self.assertRaisesRegex(OSError, 'original sync failure'):
                self.build()
        self.assertEqual(parent_calls, 3)
        self.assertTrue((self.parent / 'manifest.json.partial').exists())
        with self.assertRaises(s.SnapshotError):
            s.retry_verify_manifest(self.repo, self.parent, self.commit, 'operation-1')

    def test_traversal_error_is_fatal(self):
        self.build()
        def broken_walk(path, followlinks, onerror):
            onerror(PermissionError('denied'))
            yield
        with patch.object(s.os, 'walk', broken_walk), self.assertRaises(s.SnapshotError):
            s.verify(self.parent / 'snapshot', s.entries(self.repo, self.commit))

    def test_publication_failures_leave_evidence(self):
        for target in ('link', 'fsync'):
            with self.subTest(target=target), tempfile.TemporaryDirectory() as directory:
                parent = Path(directory)
                with patch.object(s.os, target, side_effect=OSError('failure')):
                    with self.assertRaises(OSError):
                        s.build(self.repo, parent, self.commit, 'operation-1')
                self.assertTrue(any(parent.iterdir()))
                with self.assertRaises(s.SnapshotError):
                    s.retry_verify_manifest(self.repo, parent, self.commit, 'operation-1')

    def test_post_removal_sync_and_marker_recreation_failure(self):
        real_sync = s.sync_dir
        calls = []
        def fail_final(path):
            calls.append(path)
            if path == self.parent and calls.count(path) == 2:
                raise OSError('post-removal sync failure')
            return real_sync(path)
        with patch.object(s, 'sync_dir', side_effect=fail_final), patch.object(Path, 'touch', side_effect=OSError('marker recreation failure')):
            with self.assertRaises(OSError):
                self.build()
        self.assertEqual({p.name for p in self.parent.iterdir()}, {'snapshot', 'manifest.json'})
        with self.assertRaises(s.SnapshotError):
            s.verify_manifest(self.repo, self.parent, self.commit, 'operation-1')
        self.assertEqual(s.retry_verify_manifest(self.repo, self.parent, self.commit, 'operation-1')['commit'], self.commit)
        with patch.object(s, 'sync_file', side_effect=OSError('retry sync failure')):
            with self.assertRaises(OSError):
                s.retry_verify_manifest(self.repo, self.parent, self.commit, 'operation-1')

    def test_resource_limits_and_snapshot_sync(self):
        for name, value in [('MAX_TREE_BYTES', 1), ('MAX_ENTRIES', 1),
                            ('MAX_BLOB_BYTES', 1), ('MAX_TOTAL_BLOB_BYTES', 1)]:
            with self.subTest(name=name), patch.object(s, name, value):
                with self.assertRaises(s.SnapshotError):
                    self.build()
        with patch.object(s, 'GIT_TIMEOUT_SECONDS', 0):
            with self.assertRaises(s.SnapshotError):
                self.build()
        with patch.object(s, 'sync_file', side_effect=OSError('snapshot sync failure')):
            with self.assertRaises(OSError):
                self.build()
        with self.assertRaises(s.SnapshotError):
            s.retry_verify_manifest(self.repo, self.parent, self.commit, 'operation-1')

    def test_unexpected_hardlinks_and_owner(self):
        self.build()
        file = self.parent / 'snapshot/file'
        os.link(file, self.base / 'outside')
        with self.assertRaises(s.SnapshotError):
            s.retry_verify_manifest(self.repo, self.parent, self.commit, 'operation-1')
        (self.base / 'outside').unlink()
        with patch.object(s.os, 'geteuid', return_value=os.geteuid() + 1):
            with self.assertRaises(s.SnapshotError):
                s.retry_verify_manifest(self.repo, self.parent, self.commit, 'operation-1')
        (self.parent / 'extra').touch()
        with self.assertRaises(s.SnapshotError):
            s.retry_verify_manifest(self.repo, self.parent, self.commit, 'operation-1')

    def test_nested_unsafe_path_and_old_git(self):
        (self.repo / 'nested').mkdir()
        (self.repo / 'nested/.env.secret').write_text('secret')
        self.git('add', '-f', 'nested/.env.secret')
        self.git('commit', '-qm', 'unsafe')
        with self.assertRaises(s.SnapshotError):
            self.build(self.git('rev-parse', 'HEAD').strip())
        with patch.object(s, 'git', return_value=b'git version 2.51.0'):
            with self.assertRaises(s.SnapshotError):
                self.build()

    def test_private_parent_and_owner(self):
        self.parent.chmod(0o755)
        with self.assertRaises(s.SnapshotError):
            self.build()
        self.parent.chmod(0o700)
        with patch.object(s.os, 'geteuid', return_value=os.geteuid() + 1):
            with self.assertRaises(s.SnapshotError):
                self.build()


if __name__ == '__main__':
    unittest.main()
