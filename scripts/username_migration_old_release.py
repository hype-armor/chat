"""Rollback release protocol; no operational adapter or command execution.

The caller must hold the same exclusive deployment lock for every call here,
all database restores, all recovery decisions, and all paths that can expose
old credentials or ingress. The lock must span processes and survive for the
whole operation, including external effects. No out-of-band actor may expose
old writes or restore the database. The adapter must fail closed on errors.

The journal is persistent storage outside the restored database and volumes.
Its release record is monotonic, operation-specific, and never deleted or
rolled back. `record_release()` returns only after the record and its parent
metadata are durable. `release_recorded()` returns exactly True or False only
after an authoritative read; errors or uncertainty must raise. An implementation
must not treat a missing, corrupt, stale, or inaccessible journal as False.
The adapter must ensure the record identifies the correct deployment and that
an initial unreleased record was durably created before any rollback effects.

This module is a protocol primitive, not a complete deployment orchestrator.
"""


class OldReleaseError(Exception):
    """A safe, non-sensitive rollback protocol failure."""


class OldRelease:
    def __init__(self, adapter):
        self.adapter = adapter

    def _released(self):
        state = self.adapter.release_recorded()
        if state is not True and state is not False:
            raise OldReleaseError("Unknown release state")
        return state

    def restore(self):
        """Restore only before release; the adapter must verify all other fences."""
        try:
            if self._released():
                raise OldReleaseError("Restore forbidden after old release")
            self.adapter.restore_database()
        except OldReleaseError:
            raise
        except Exception:
            raise OldReleaseError("Restore failed or release state unknown") from None

    def release(self):
        """Persist the irreversible boundary before any old write path opens.

        After this point a failure requires alerting and retrying old startup;
        the orchestrator must never restore the database again. In particular,
        old_ready must not be recorded until health checks succeed. A crash
        after recording release but before startup is deliberately conservative.
        Each adapter action must be safe to retry after an interrupted call.
        """
        try:
            if not self._released():
                # This must check restored data, old image compatibility and all
                # write fences while old credentials and ingress remain closed.
                if self.adapter.verify_release_preconditions() is not True:
                    raise OldReleaseError("Release preconditions failed")
                self.adapter.record_release()
            if not self._released():
                raise OldReleaseError("Release record not durable")
            # Starting the database can itself expose the original password to
            # TCP clients. It is therefore already an irreversible effect.
            self.adapter.start_old_database()
            self.adapter.start_old_services()
            if self.adapter.old_health_check() is not True:
                raise OldReleaseError("Old service health check failed")
            self.adapter.record_old_ready()
        except OldReleaseError:
            raise
        except Exception:
            raise OldReleaseError("Old release failed; inspect durable state") from None
