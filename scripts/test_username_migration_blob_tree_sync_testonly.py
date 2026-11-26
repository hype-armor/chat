import os
from pathlib import Path
import tempfile
import unittest
from unittest import mock

from username_migration_blob_tree_sync_testonly import TreeSyncError, sync_synthetic_tree as raw_sync
import username_migration_mount_check_testonly as mount_check


def sync_synthetic_tree(root, fence, **kwargs):
    root_fd = os.open(root, os.O_RDONLY | os.O_DIRECTORY)
    try:
        root_mount_id = mount_check.mount_id(root_fd)
    finally:
        os.close(root_fd)
    limits = dict(root_mount_id=root_mount_id, max_entries=100, max_depth=10, max_path_bytes=1000)
    limits.update(kwargs)
    return raw_sync(root, fence, **limits)


class TreeSyncTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name) / "root"
        self.root.mkdir()
        (self.root / "sub").mkdir()
        (self.root / "sub" / "b").write_text("b")
        (self.root / "a").write_text("a")

    def test_order_and_retry(self):
        seen = []
        def sync(fd):
            seen.append(os.readlink(f"/proc/self/fd/{fd}"))
            os.fsync(fd)
        for _ in range(2):
            seen.clear()
            sync_synthetic_tree(self.root, lambda: None, fsync=sync)
            self.assertEqual(seen, [str(self.root / "a"), str(self.root / "sub" / "b"),
                                    str(self.root / "sub"), str(self.root)])

    def test_limits_and_retry(self):
        # Three entries: a, sub, and sub/b. Their path lengths total 9.
        for limit, value, message in (("max_entries", 2, "entry"),
                                      ("max_depth", 1, "depth"),
                                      ("max_path_bytes", 8, "path-byte")):
            with self.subTest(limit=limit):
                with self.assertRaisesRegex(TreeSyncError, message):
                    sync_synthetic_tree(self.root, lambda: None, **{limit: value})
                sync_synthetic_tree(self.root, lambda: None, max_entries=3,
                                    max_depth=2, max_path_bytes=9)

    def test_limits_are_explicit_and_valid(self):
        with self.assertRaises(TypeError):
            raw_sync(self.root, lambda: None)
        for name, value in (("max_entries", -1), ("max_depth", 129),
                            ("max_path_bytes", float("inf")), ("max_entries", True)):
            with self.subTest(name=name, value=value):
                with self.assertRaises(ValueError):
                    sync_synthetic_tree(self.root, lambda: None, **{name: value})

    def test_links_rejected(self):
        for kind in ("symlink", "hardlink"):
            link = self.root / "link"
            if kind == "symlink":
                link.symlink_to(self.root / "a")
            else:
                os.link(self.root / "a", link)
            with self.assertRaises(TreeSyncError):
                sync_synthetic_tree(self.root, lambda: None)
            link.unlink()

    def test_mount_drift_and_unsupported_then_retry(self):
        for target in (self.root, self.root / 'a', self.root / 'sub', self.root / 'sub' / 'b'):
            for failure in ('mismatch', 'unsupported'):
                with self.subTest(target=target, failure=failure):
                    def mount_id(fd):
                        if os.readlink(f'/proc/self/fd/{fd}') == str(target):
                            if failure == 'unsupported':
                                raise mount_check.Unsupported('no statx')
                            return 43
                        return 42
                    # Pass the intent value explicitly to avoid deriving it under the mock.
                    with mock.patch.object(mount_check, 'mount_id', side_effect=mount_id):
                        with self.assertRaises((TreeSyncError, mount_check.Unsupported)):
                            raw_sync(self.root, lambda: None, root_mount_id=42,
                                     max_entries=100, max_depth=10, max_path_bytes=1000)
                    sync_synthetic_tree(self.root, lambda: None)

    def test_fsync_failure_then_retry(self):
        def fail(fd):
            raise OSError("injected")
        with self.assertRaises(TreeSyncError):
            sync_synthetic_tree(self.root, lambda: None, fsync=fail)
        sync_synthetic_tree(self.root, lambda: None)

    def test_fence_failure(self):
        calls = 0
        def fence():
            nonlocal calls
            calls += 1
            if calls == 5:
                raise RuntimeError("fence lost")
        with self.assertRaisesRegex(RuntimeError, "fence lost"):
            sync_synthetic_tree(self.root, fence)
        sync_synthetic_tree(self.root, lambda: None)

    def test_identity_drift(self):
        def mutate(fd):
            if os.readlink(f"/proc/self/fd/{fd}") == str(self.root / "a"):
                (self.root / "a").write_text("changed")
            os.fsync(fd)
        with self.assertRaises(TreeSyncError):
            sync_synthetic_tree(self.root, lambda: None, fsync=mutate)

    def test_fifo_and_root_symlink_rejected(self):
        os.mkfifo(self.root / "fifo")
        with self.assertRaises(TreeSyncError):
            sync_synthetic_tree(self.root, lambda: None)
        link = Path(self.tmp.name) / "root-link"
        link.symlink_to(self.root, target_is_directory=True)
        with self.assertRaises(TreeSyncError):
            sync_synthetic_tree(link, lambda: None)

    def test_cross_device_rejected(self):
        real_stat = os.stat
        def fake_stat(path, *args, **kwargs):
            result = real_stat(path, *args, **kwargs)
            if path == "a" and kwargs.get("dir_fd") is not None:
                values = list(result)
                values[2] += 1
                return os.stat_result(values)
            return result
        with mock.patch("username_migration_blob_tree_sync_testonly.os.stat", side_effect=fake_stat):
            with self.assertRaisesRegex(TreeSyncError, "cross-device"):
                sync_synthetic_tree(self.root, lambda: None)


if __name__ == "__main__":
    unittest.main()
