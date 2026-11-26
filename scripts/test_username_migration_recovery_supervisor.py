import importlib.util
import os
import signal
import tempfile
import time
import unittest
import uuid
from pathlib import Path

spec = importlib.util.spec_from_file_location('supervisor', Path(__file__).with_name('username_migration_recovery_supervisor.py'))
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)


class Tests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.directory = self.tmp.name
        self.marker = Path(self.directory) / 'effect'

    def tearDown(self):
        self.tmp.cleanup()

    def recover(self, journal, decision):
        self.marker.write_text(decision)
        if decision == 'begin_rollback':
            journal.begin_rollback()

    def test_failure_reopens_and_recovers(self):
        def update(j):
            j.begin(str(uuid.uuid4()))
            raise ValueError()
        with self.assertRaises(m.SupervisorError):
            m.Supervisor(self.directory, update, self.recover).run()
        self.assertEqual(self.marker.read_text(), 'begin_rollback')

    def test_post_commit_never_recovers(self):
        def update(j):
            j.begin(str(uuid.uuid4()))
            for phase in ('fence', 'backup', 'migrate', 'start_new', 'committed'):
                j.advance(phase)
            raise ValueError()
        with self.assertRaises(m.SupervisorError):
            m.Supervisor(self.directory, update, self.recover).run()
        self.assertFalse(self.marker.exists())

    def test_killed_supervisor_worker_stops_and_restart_recovers(self):
        ready = Path(self.directory) / 'ready'
        late = Path(self.directory) / 'late'
        def update(j):
            j.begin(str(uuid.uuid4()))
            ready.touch()
            time.sleep(1)
            late.touch()
        pid = os.fork()
        if pid == 0:
            try:
                m.Supervisor(self.directory, update, self.recover).run()
            finally:
                os._exit(0)
        deadline = time.monotonic() + 5
        while not ready.exists() and time.monotonic() < deadline:
            time.sleep(.01)
        self.assertTrue(ready.exists())
        os.kill(pid, signal.SIGKILL)
        os.waitpid(pid, 0)
        deadline = time.monotonic() + 5
        while True:
            try:
                m.Supervisor(self.directory, update, self.recover).recover_pending()
                break
            except BlockingIOError:
                if time.monotonic() > deadline:
                    raise
                time.sleep(.01)
        time.sleep(1.1)
        self.assertFalse(late.exists())
        self.assertEqual(self.marker.read_text(), 'begin_rollback')

    def test_lock_contention_has_no_effect(self):
        with m._journal.Journal(self.directory):
            with self.assertRaises(BlockingIOError):
                m.Supervisor(self.directory, lambda j: self.marker.touch(), self.recover).run()
        self.assertFalse(self.marker.exists())


if __name__ == '__main__':
    unittest.main()
