#!/usr/bin/env python3
"""Linux test prototype. Not a production process supervisor.

The runner creates a CLOEXEC pipe, passes only its read end to this program,
keeps the write end open, and closes it to request cleanup. Runner death also
closes that end. No other process may inherit or duplicate the write end.
The watchdog starts one new-session child and prints its PID when ready.
It retains the unreaped group leader until after group cleanup, preventing PID
reuse during identity checks and signals. Escaped sessions are not contained.
Watchdog death, host failure, uninterruptible tasks, permissions, or procfs
failure can prevent cleanup. Identity or signal errors fail closed and can leave
processes running. A successful leader reap does not prove all descendants died.
Use an external containment mechanism in practice.
"""
import argparse
import os
import select
import signal
import subprocess
import sys
import time


def identity(pid):
    # comm can contain spaces and parentheses; fields after its last ')' are stable.
    with open(f'/proc/{pid}/stat', encoding='ascii') as f:
        fields = f.read().rsplit(')', 1)[1].split()
    return int(fields[2]), int(fields[3]), int(fields[19])  # pgrp, session, starttime


def run(control, command, grace=0.25, kill_wait=2.0):
    if not sys.platform.startswith('linux'):
        raise RuntimeError('Linux only')
    os.set_inheritable(control, False)
    child = subprocess.Popen(command, start_new_session=True, close_fds=True)
    try:
        initial = identity(child.pid)
        if initial[:2] != (child.pid, child.pid):
            raise RuntimeError('child is not a session and group leader')
        print(child.pid, flush=True)
        poller = select.poll()
        poller.register(control, select.POLLIN | select.POLLHUP | select.POLLERR)
        while True:
            # WNOWAIT preserves the leader PID even when it has exited.
            if os.waitid(os.P_PID, child.pid, os.WEXITED | os.WNOHANG | os.WNOWAIT):
                break
            if poller.poll(50):
                # Any input or EOF requests cleanup; the protocol carries no data.
                break
        def send(sig):
            if identity(child.pid) != initial or initial[:2] != (child.pid, child.pid):
                raise RuntimeError('child identity changed; refusing group signal')
            os.killpg(child.pid, sig)

        send(signal.SIGTERM)
        # Keep the leader unreaped for the entire grace interval, even if it exits.
        time.sleep(grace)
        send(signal.SIGKILL)
        deadline = time.monotonic() + kill_wait
        while time.monotonic() < deadline:
            if os.waitid(os.P_PID, child.pid, os.WEXITED | os.WNOHANG | os.WNOWAIT):
                child.wait()
                return 0
            time.sleep(0.02)
        raise RuntimeError('child did not exit within kill deadline')
    finally:
        os.close(control)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--control-fd', type=int, required=True)
    parser.add_argument('command', nargs=argparse.REMAINDER)
    args = parser.parse_args()
    if not args.command:
        parser.error('command required')
    try:
        return run(args.control_fd, args.command)
    except (OSError, RuntimeError) as exc:
        print(f'watchdog: {exc}', file=sys.stderr, flush=True)
        return 1


if __name__ == '__main__':
    sys.exit(main())
