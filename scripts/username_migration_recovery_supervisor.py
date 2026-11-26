"""Experimental recovery supervisor for trusted, single-process callbacks.

Deployment integration is disabled: there is no complete physical backend.
Callbacks MUST NOT fork, exec, start asynchronous work, or return before effects
finish. This restriction is not enforced. The journal directory and lock file
must not be replaced. Linux fork and pidfds are required. A service manager must
restart after SIGKILL and call recover_pending before any new operation.

A production implementation also needs an independently verified containment
boundary for all descendant and remote effects. This module is not that boundary.
"""
import importlib.util
import os
import select
import signal
from pathlib import Path

_spec = importlib.util.spec_from_file_location('migration_journal', Path(__file__).with_name('username-migration-journal.py'))
_journal = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_journal)


class SupervisorError(RuntimeError):
    pass


class Interrupted(SupervisorError):
    pass


class Supervisor:
    """The callback receives the locked Journal and must use durable ordering.

    Recovery must be retry-safe. The supervisor never calls a recovery worker
    after committed or old_ready. All participants must use the same journal lock.
    """
    def __init__(self, directory, update, recover):
        self.directory = directory
        self.update = update
        self.recover = recover

    @staticmethod
    def _worker(journal, callback):
        # Open before fork: the watcher cannot accidentally observe a reparent.
        parentfd = os.pidfd_open(os.getpid())
        readfd, writefd = os.pipe2(os.O_CLOEXEC)
        try:
            watcher = os.fork()
        except BaseException:
            os.close(parentfd)
            os.close(readfd)
            os.close(writefd)
            raise
        if watcher == 0:
            os.close(writefd)
            try:
                for sig in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
                    signal.signal(sig, signal.SIG_IGN)
                worker = os.fork()
                if worker == 0:
                    os.close(readfd)
                    for sig in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
                        signal.signal(sig, signal.SIG_DFL)
                    try:
                        callback(journal)
                        os._exit(0)
                    except BaseException:
                        os._exit(1)
                workerfd = os.pidfd_open(worker)
                poller = select.poll()
                poller.register(parentfd, select.POLLIN)
                poller.register(readfd, select.POLLHUP)
                poller.register(workerfd, select.POLLIN)
                events = poller.poll()
                if any(fd in (parentfd, readfd) for fd, _ in events):
                    try:
                        signal.pidfd_send_signal(workerfd, signal.SIGKILL)
                    except ProcessLookupError:
                        pass
                _, status = os.waitpid(worker, 0)
                os._exit(0 if status == 0 else 1)
            except BaseException:
                # If setup fails after fork, stop and reap the direct worker.
                if 'worker' in locals() and worker > 0:
                    try:
                        os.kill(worker, signal.SIGKILL)
                        os.waitpid(worker, 0)
                    except (ProcessLookupError, ChildProcessError):
                        pass
                os._exit(1)
        os.close(parentfd)
        os.close(readfd)
        try:
            _, status = os.waitpid(watcher, 0)
        except BaseException:
            os.close(writefd)
            os.waitpid(watcher, 0)
            raise
        os.close(writefd)
        if status != 0:
            raise SupervisorError('worker or watcher failed')

    def _recovery_locked(self, journal):
        decision = journal.recovery_decision()
        if decision in ('no_operation', 'leave_new'):
            return
        if decision == 'resume_old':
            # Old writers might already have accepted new state. The generic
            # rollback worker must not run and automatic release is unavailable.
            raise SupervisorError('old runtime release requires operator resolution')
        if decision not in ('begin_rollback', 'restore_old', 'recover_old_runtime'):
            raise SupervisorError('unsupported recovery decision')
        self._worker(journal, lambda j: self.recover(j, decision))

    def recover_pending(self):
        with _journal.Journal(self.directory) as journal:
            self._recovery_locked(journal)

    def run(self):
        # Signal handlers must be installed by a single-threaded entry point.
        def interrupted(signum, frame):
            raise Interrupted('signal %s' % signum)
        previous = {sig: signal.signal(sig, interrupted) for sig in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP)}
        try:
            try:
                with _journal.Journal(self.directory) as journal:
                    self._recovery_locked(journal)
                    if journal.recovery_decision() != 'no_operation':
                        raise SupervisorError('existing journal prevents a new operation')
                    self._worker(journal, self.update)
                    if journal.recovery_decision() not in ('leave_new', 'no_operation'):
                        raise SupervisorError('update exited without a committed journal')
            except Exception:
                self.recover_pending()  # Reopen after ordinary worker failure.
                raise
        finally:
            for sig, handler in previous.items():
                signal.signal(sig, handler)
