"""Mock-only tests. These tests do not access Docker or PostgreSQL."""
import importlib.util
import os
from pathlib import Path
import tempfile
import unittest
from unittest import mock

spec = importlib.util.spec_from_file_location('writer_fence', Path(__file__).with_name('writer-fence.py'))
fence = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fence)
IMAGE = 'sha256:' + 'a' * 64


class Backend:
    TEST_ONLY = True
    def __init__(self, fail=False):
        self.effects = []
        self.fail = fail
    def preflight(self, image, volume, role):
        if self.fail:
            raise RuntimeError('preflight failed')
    def rotate(self, state):
        self.effects.append(state.copy())


class Tests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        os.chmod(self.tmp.name, 0o700)
        self.addCleanup(self.tmp.cleanup)

    def test_intent_precedes_effect_and_is_reused_after_uncertain_effect(self):
        class CrashBackend(Backend):
            def rotate(inner, state):
                with open(Path(self.tmp.name) / 'writer-fence-intent.json', encoding='ascii') as f:
                    self.assertIn(state['secret'], f.read())
                inner.effects.append(state.copy())
                raise RuntimeError('effect outcome uncertain')
        first = CrashBackend()
        with fence.Intent(self.tmp.name) as intent:
            with self.assertRaisesRegex(RuntimeError, 'uncertain'):
                fence.test_only_rotate(intent, first, IMAGE, 'compose_postgres', 'chat')
        second = Backend()
        with fence.Intent(self.tmp.name) as intent:
            fence.test_only_rotate(intent, second, IMAGE, 'compose_postgres', 'chat')
        self.assertEqual(first.effects, second.effects)
        self.assertEqual(os.stat(Path(self.tmp.name) / 'writer-fence-intent.json').st_mode & 0o777, 0o600)

    def test_preflight_failure_has_no_intent_or_effect(self):
        backend = Backend(fail=True)
        with fence.Intent(self.tmp.name) as intent:
            with self.assertRaises(RuntimeError):
                fence.test_only_rotate(intent, backend, IMAGE, 'compose_postgres', 'chat')
            self.assertIsNone(intent.load())
        self.assertEqual(backend.effects, [])

    def test_reject_mutable_image_and_target_change(self):
        with fence.Intent(self.tmp.name) as intent:
            with self.assertRaises(fence.FenceError):
                intent.prepare('postgres:18', 'compose_postgres', 'chat')
            intent.prepare(IMAGE, 'compose_postgres', 'chat')
            with self.assertRaises(fence.FenceError):
                intent.prepare(IMAGE, 'other', 'chat')

    def test_fail_closed_on_partial_intent(self):
        path = Path(self.tmp.name) / 'writer-fence-intent.json'
        path.write_text('{', encoding='ascii')
        os.chmod(path, 0o600)
        with fence.Intent(self.tmp.name) as intent:
            with self.assertRaises(fence.FenceError):
                intent.prepare(IMAGE, 'compose_postgres', 'chat')

    def test_failed_fsync_blocks_effect_and_current_instance(self):
        backend = Backend()
        with fence.Intent(self.tmp.name) as intent:
            with mock.patch.object(fence.os, 'fsync', side_effect=OSError('sync failed')):
                with self.assertRaises(OSError):
                    fence.test_only_rotate(intent, backend, IMAGE, 'compose_postgres', 'chat')
            with self.assertRaises(fence.FenceError):
                intent.load()
        self.assertEqual(backend.effects, [])

    def test_retry_requires_successful_intent_sync(self):
        with fence.Intent(self.tmp.name) as intent:
            intent.prepare(IMAGE, 'compose_postgres', 'chat')
        backend = Backend()
        with fence.Intent(self.tmp.name) as intent:
            with mock.patch.object(fence.os, 'fsync', side_effect=OSError('sync failed')):
                with self.assertRaises(OSError):
                    fence.test_only_rotate(intent, backend, IMAGE, 'compose_postgres', 'chat')
            with self.assertRaises(fence.FenceError):
                intent.load()
        self.assertEqual(backend.effects, [])

    def test_reject_untrusted_directory_and_live_backend(self):
        os.chmod(self.tmp.name, 0o755)
        with self.assertRaises(fence.FenceError):
            with fence.Intent(self.tmp.name):
                pass
        os.chmod(self.tmp.name, 0o700)
        with fence.Intent(self.tmp.name) as intent:
            with self.assertRaises(fence.FenceError):
                fence.test_only_rotate(intent, object(), IMAGE, 'compose_postgres', 'chat')

    def test_lock_excludes_second_instance(self):
        with fence.Intent(self.tmp.name):
            with self.assertRaises(BlockingIOError):
                with fence.Intent(self.tmp.name):
                    pass


if __name__ == '__main__':
    unittest.main()
