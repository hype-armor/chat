import os
import signal
import subprocess
import sys
import time
import unittest
from pathlib import Path
from unittest import mock

import disposable_watchdog_testonly as watchdog

SCRIPT = str(Path(__file__).with_name('disposable_watchdog_testonly.py'))


def running(pid):
    try:
        with open(f'/proc/{pid}/stat', encoding='ascii') as f:
            return f.read().rsplit(')', 1)[1].split()[0] != 'Z'
    except FileNotFoundError:
        return False


def wait_dead(pid):
    end = time.monotonic() + 4
    while time.monotonic() < end:
        if not running(pid):
            return
        time.sleep(.02)
    raise AssertionError(f'process {pid} still running')


@unittest.skipUnless(sys.platform.startswith('linux'), 'Linux only')
class WatchdogTest(unittest.TestCase):
    def test_runner_sigkill_and_unrelated_process(self):
        unrelated = subprocess.Popen(['sleep', '30'], start_new_session=True)
        runner = subprocess.Popen([sys.executable, '-c', '''
import os, subprocess, sys, time
r, w = os.pipe2(os.O_CLOEXEC)
p = subprocess.Popen([sys.executable, sys.argv[1], '--control-fd', str(r), sys.executable, '-c',
    'import signal,time; signal.signal(signal.SIGTERM, signal.SIG_IGN); time.sleep(30)'],
    pass_fds=(r,), stdout=subprocess.PIPE, text=True)
os.close(r)
pid = p.stdout.readline().strip()
print(p.pid, pid, flush=True)
time.sleep(30)
''', SCRIPT], stdout=subprocess.PIPE, text=True)
        leader = None
        try:
            watcher, leader = map(int, runner.stdout.readline().split())
            # The child has time to install its TERM handler before runner death.
            time.sleep(.15)
            runner.kill()
            runner.wait(timeout=3)
            wait_dead(leader)
            wait_dead(watcher)
            self.assertIsNone(unrelated.poll())
        finally:
            if runner.poll() is None:
                runner.kill()
                runner.wait()
            unrelated.terminate()
            unrelated.wait(timeout=3)
            runner.stdout.close()

    def test_normal_completion_and_reap(self):
        r, w = os.pipe2(os.O_CLOEXEC)
        p = subprocess.Popen([sys.executable, SCRIPT, '--control-fd', str(r),
                              sys.executable, '-c', 'pass'], pass_fds=(r,),
                             stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        os.close(r)
        try:
            out, err = p.communicate(timeout=4)
            self.assertEqual(p.returncode, 0, err)
            self.assertFalse(os.path.exists('/proc/' + out.strip()))
        finally:
            os.close(w)
            if p.poll() is None:
                p.kill()
                p.wait()

    def test_close_pipe_terminates_group_descendant(self):
        r, w = os.pipe2(os.O_CLOEXEC)
        code = ('import subprocess,sys,time; '
                'p=subprocess.Popen(["sleep","30"]); '
                'print(p.pid,flush=True); time.sleep(30)')
        p = subprocess.Popen([sys.executable, SCRIPT, '--control-fd', str(r),
                              sys.executable, '-c', code], pass_fds=(r,),
                             stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        os.close(r)
        try:
            leader = int(p.stdout.readline())
            descendant = int(p.stdout.readline())
            os.close(w)
            w = None
            _, err = p.communicate(timeout=4)
            self.assertEqual(p.returncode, 0, err)
            wait_dead(leader)
            wait_dead(descendant)
        finally:
            if w is not None:
                os.close(w)
            if p.poll() is None:
                p.kill()
                p.wait()

    def test_identity_failure_never_signals_group(self):
        r, w = os.pipe2(os.O_CLOEXEC)
        with mock.patch.object(watchdog, 'identity', return_value=(999, 999, 1)), \
             mock.patch.object(watchdog.os, 'killpg') as killpg, \
             mock.patch.object(watchdog.subprocess, 'Popen') as popen:
            popen.return_value.pid = 123
            with self.assertRaises(RuntimeError):
                watchdog.run(r, ['unused'])
            killpg.assert_not_called()
        os.close(w)


if __name__ == '__main__':
    unittest.main()
