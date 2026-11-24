//! Local admission and drain coordination for storage work.
//!
//! A completed drain means every admitted guard reported confirmed completion.
//! It does not establish remote persistence or durability. Confirmation is valid
//! only when the remote task or abort semantics prove that work has ended.

use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DrainError {
    Closed,
    Poisoned,
    CapacityExceeded,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DrainOutcome {
    Completed,
    TimedOut,
    Uncertain,
}

#[derive(Debug, Default)]
struct State {
    closed: bool,
    active: usize,
    uncertain: bool,
}

#[derive(Default)]
struct Inner {
    state: Mutex<State>,
    changed: Condvar,
}

/// Clones share one admission gate. Closure is permanent.
#[derive(Clone, Default)]
pub struct StorageDrain {
    inner: Arc<Inner>,
}

/// Represents one admitted operation. Dropping it without confirmation records
/// uncertainty permanently, including during cancellation or unwinding.
#[must_use]
pub struct StorageGuard {
    inner: Arc<Inner>,
    confirmed: bool,
}

impl StorageDrain {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn admit(&self) -> Result<StorageGuard, DrainError> {
        let mut state = self.inner.state.lock().map_err(|_| DrainError::Poisoned)?;
        if state.closed {
            return Err(DrainError::Closed);
        }
        state.active = state
            .active
            .checked_add(1)
            .ok_or(DrainError::CapacityExceeded)?;
        Ok(StorageGuard {
            inner: Arc::clone(&self.inner),
            confirmed: false,
        })
    }

    /// Closes admission atomically and waits for guards with a timeout.
    /// Mutex contention can delay the return beyond the timeout. A drain can
    /// complete after the deadline if the final guard drops before inspection.
    /// This method blocks the calling thread. Async callers need a blocking worker.
    /// A timeout leaves admission closed. This method can be called again.
    /// `TimedOut` can coexist with recorded uncertainty while guards remain active.
    /// Callers must treat both `TimedOut` and `Uncertain` as failure to drain.
    /// Poison does not notify waiters; a blocked waiter may detect it only when
    /// the timeout expires or another notification occurs.
    pub fn close_and_wait(&self, timeout: Duration) -> Result<DrainOutcome, DrainError> {
        let start = Instant::now();
        let mut state = self.inner.state.lock().map_err(|_| DrainError::Poisoned)?;
        state.closed = true;
        loop {
            if state.active == 0 {
                return Ok(if state.uncertain {
                    DrainOutcome::Uncertain
                } else {
                    DrainOutcome::Completed
                });
            }
            let remaining = timeout.saturating_sub(start.elapsed());
            if remaining.is_zero() {
                return Ok(DrainOutcome::TimedOut);
            }
            let (next, _) = self
                .inner
                .changed
                .wait_timeout(state, remaining)
                .map_err(|_| DrainError::Poisoned)?;
            state = next;
        }
    }
}

impl StorageGuard {
    /// Confirms that the admitted work has ended. Call this only when remote
    /// task completion or successful abort semantics prove that no work remains.
    /// A failed abort or an unknown remote outcome must not be confirmed.
    pub fn confirm_completion(mut self) {
        self.confirmed = true;
    }

    /// Records an uncertain outcome, such as a failed remote abort.
    pub fn mark_uncertain(self) {
        drop(self);
    }
}

impl Drop for StorageGuard {
    fn drop(&mut self) {
        // Release the count even after a panic, but do not clear the poison.
        // Future admissions and drain calls must still fail closed.
        let mut state = self
            .inner
            .state
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        state.uncertain |= !self.confirmed || std::thread::panicking();
        state.active -= 1;
        if state.active == 0 {
            self.inner.changed.notify_all();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Barrier, mpsc};
    use std::thread;

    // These tests exercise guard ownership, not an object-store implementation.
    // The real integration must confirm only after the remote operation ends.
    #[tokio::test]
    async fn cancelled_future_cannot_confirm_its_guard() {
        let gate = StorageDrain::new();
        let guard = gate.admit().unwrap();
        let (started_tx, started_rx) = tokio::sync::oneshot::channel();
        let task = tokio::spawn(async move {
            let _guard = guard;
            let _ = started_tx.send(());
            std::future::pending::<()>().await;
        });
        started_rx.await.unwrap();
        task.abort();
        assert!(task.await.unwrap_err().is_cancelled());
        assert_eq!(
            gate.close_and_wait(Duration::ZERO),
            Ok(DrainOutcome::Uncertain)
        );
    }

    #[tokio::test]
    async fn simulated_remote_outcomes_require_confirmation() {
        for confirmed in [true, false] {
            let gate = StorageDrain::new();
            let guard = gate.admit().unwrap();
            let task = tokio::spawn(async move {
                // Model an awaited successful finish or abort, or a failure.
                tokio::task::yield_now().await;
                if confirmed {
                    guard.confirm_completion();
                }
            });
            task.await.unwrap();
            assert_eq!(
                gate.close_and_wait(Duration::ZERO),
                Ok(if confirmed {
                    DrainOutcome::Completed
                } else {
                    DrainOutcome::Uncertain
                })
            );
        }
    }

    #[test]
    fn empty_drain_closes_admission() {
        let gate = StorageDrain::new();
        assert_eq!(
            gate.close_and_wait(Duration::ZERO),
            Ok(DrainOutcome::Completed)
        );
        assert!(matches!(gate.admit(), Err(DrainError::Closed)));
    }

    #[test]
    fn cancellation_and_explicit_uncertainty_are_permanent() {
        for explicit in [false, true] {
            let gate = StorageDrain::new();
            let guard = gate.admit().unwrap();
            if explicit {
                guard.mark_uncertain(); // Includes a failed remote abort.
            } else {
                drop(guard); // Cancellation without confirmed completion.
            }
            gate.admit().unwrap().confirm_completion();
            assert_eq!(
                gate.close_and_wait(Duration::ZERO),
                Ok(DrainOutcome::Uncertain)
            );
            assert_eq!(
                gate.close_and_wait(Duration::ZERO),
                Ok(DrainOutcome::Uncertain)
            );
            assert!(matches!(gate.admit(), Err(DrainError::Closed)));
        }
    }

    #[test]
    fn uncertainty_racing_with_close_is_not_lost() {
        for _ in 0..200 {
            let gate = StorageDrain::new();
            let guard = gate.admit().unwrap();
            let barrier = Arc::new(Barrier::new(2));
            let worker_barrier = Arc::clone(&barrier);
            let worker = thread::spawn(move || {
                worker_barrier.wait();
                drop(guard);
            });
            barrier.wait();
            assert_eq!(
                gate.close_and_wait(Duration::from_secs(2)),
                Ok(DrainOutcome::Uncertain)
            );
            worker.join().unwrap();
        }
    }

    #[test]
    fn held_guards_timeout_then_drain_after_drop() {
        let gate = StorageDrain::new();
        let first = gate.admit().unwrap();
        let second = gate.admit().unwrap();
        assert_eq!(
            gate.close_and_wait(Duration::from_millis(10)),
            Ok(DrainOutcome::TimedOut)
        );
        assert!(matches!(gate.admit(), Err(DrainError::Closed)));
        first.confirm_completion();
        assert_eq!(
            gate.close_and_wait(Duration::ZERO),
            Ok(DrainOutcome::TimedOut)
        );
        second.confirm_completion();
        assert_eq!(
            gate.close_and_wait(Duration::ZERO),
            Ok(DrainOutcome::Completed)
        );
    }

    #[test]
    fn timeout_can_coexist_with_recorded_uncertainty() {
        let gate = StorageDrain::new();
        let uncertain = gate.admit().unwrap();
        let active = gate.admit().unwrap();
        uncertain.mark_uncertain();
        assert_eq!(
            gate.close_and_wait(Duration::ZERO),
            Ok(DrainOutcome::TimedOut)
        );
        active.confirm_completion();
        assert_eq!(
            gate.close_and_wait(Duration::ZERO),
            Ok(DrainOutcome::Uncertain)
        );
    }

    #[test]
    fn waiting_drain_wakes_when_guard_drops() {
        let gate = StorageDrain::new();
        let guard = gate.admit().unwrap();
        let waiter = gate.clone();
        let (tx, rx) = mpsc::channel();
        let handle = thread::spawn(move || {
            tx.send(waiter.close_and_wait(Duration::from_secs(2)))
                .unwrap();
        });
        guard.confirm_completion();
        assert_eq!(
            rx.recv_timeout(Duration::from_secs(3)).unwrap(),
            Ok(DrainOutcome::Completed)
        );
        handle.join().unwrap();
    }

    // Acquiring the mutex after closure proves that the waiter has released it
    // in the condition-variable wait. The deadline prevents a stalled test.
    fn wait_until_closed(gate: &StorageDrain) {
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            if gate.inner.state.lock().unwrap().closed {
                return;
            }
            assert!(Instant::now() < deadline, "waiter did not close the gate");
            thread::yield_now();
        }
    }

    #[test]
    fn multiple_waiters_complete_after_the_last_guard_drops() {
        let gate = StorageDrain::new();
        let guard = gate.admit().unwrap();
        let start = Arc::new(Barrier::new(4));
        let (tx, rx) = mpsc::channel();
        let handles: Vec<_> = (0..3)
            .map(|_| {
                let waiter = gate.clone();
                let start = Arc::clone(&start);
                let tx = tx.clone();
                thread::spawn(move || {
                    start.wait();
                    tx.send(waiter.close_and_wait(Duration::from_secs(5)))
                        .unwrap();
                })
            })
            .collect();
        start.wait();
        wait_until_closed(&gate);
        guard.confirm_completion();
        for _ in 0..3 {
            assert_eq!(
                rx.recv_timeout(Duration::from_secs(6)).unwrap(),
                Ok(DrainOutcome::Completed)
            );
        }
        for handle in handles {
            handle.join().unwrap();
        }
    }

    #[test]
    fn blocked_waiter_reports_poison_after_notification() {
        let gate = StorageDrain::new();
        let guard = gate.admit().unwrap();
        let waiter = gate.clone();
        let (tx, rx) = mpsc::channel();
        let handle = thread::spawn(move || {
            tx.send(waiter.close_and_wait(Duration::from_secs(5)))
                .unwrap();
        });
        wait_until_closed(&gate);
        let poisoner = gate.clone();
        assert!(
            thread::spawn(move || {
                let _lock = poisoner.inner.state.lock().unwrap();
                panic!("poison gate while waiter is blocked");
            })
            .join()
            .is_err()
        );
        gate.inner.changed.notify_all();
        assert_eq!(
            rx.recv_timeout(Duration::from_secs(6)).unwrap(),
            Err(DrainError::Poisoned)
        );
        handle.join().unwrap();
        drop(guard);
        assert_eq!(gate.inner.state.lock().unwrap_err().into_inner().active, 0);
    }

    #[test]
    fn blocked_waiter_detects_poison_without_notification_by_timeout() {
        let gate = StorageDrain::new();
        let guard = gate.admit().unwrap();
        let waiter = gate.clone();
        let (tx, rx) = mpsc::channel();
        let handle = thread::spawn(move || {
            tx.send(waiter.close_and_wait(Duration::from_millis(200)))
                .unwrap();
        });
        wait_until_closed(&gate);
        let poisoner = gate.clone();
        assert!(
            thread::spawn(move || {
                let _lock = poisoner.inner.state.lock().unwrap();
                panic!("poison gate without notification");
            })
            .join()
            .is_err()
        );
        assert_eq!(
            rx.recv_timeout(Duration::from_secs(3)).unwrap(),
            Err(DrainError::Poisoned)
        );
        handle.join().unwrap();
        drop(guard);
        assert_eq!(gate.inner.state.lock().unwrap_err().into_inner().active, 0);
    }

    #[test]
    fn guard_drop_during_unwind_records_uncertainty() {
        let gate = StorageDrain::new();
        let guard = gate.admit().unwrap();
        let result = thread::spawn(move || {
            let _guard = guard;
            panic!("unwind with admitted guard");
        })
        .join();
        assert!(result.is_err());
        assert_eq!(
            gate.close_and_wait(Duration::ZERO),
            Ok(DrainOutcome::Uncertain)
        );
    }

    #[test]
    fn racing_admission_is_either_counted_or_rejected() {
        for _ in 0..200 {
            let gate = StorageDrain::new();
            let worker = gate.clone();
            let barrier = Arc::new(Barrier::new(2));
            let worker_barrier = Arc::clone(&barrier);
            let (tx, rx) = mpsc::channel();
            let (release_tx, release_rx) = mpsc::channel();
            let handle = thread::spawn(move || {
                worker_barrier.wait();
                let guard = worker.admit();
                tx.send(guard.is_ok()).unwrap();
                if let Ok(guard) = guard {
                    release_rx.recv().unwrap();
                    guard.confirm_completion();
                }
            });
            barrier.wait();
            let result = gate.close_and_wait(Duration::from_millis(5)).unwrap();
            let admitted = rx.recv_timeout(Duration::from_secs(2)).unwrap();
            if admitted {
                assert_eq!(result, DrainOutcome::TimedOut);
                release_tx.send(()).unwrap();
            } else {
                assert_eq!(result, DrainOutcome::Completed);
            }
            handle.join().unwrap();
            assert_eq!(
                gate.close_and_wait(Duration::ZERO),
                Ok(DrainOutcome::Completed)
            );
        }
    }

    #[test]
    fn poisoned_gate_fails_closed_and_guard_still_releases() {
        let gate = StorageDrain::new();
        let guard = gate.admit().unwrap();
        let worker = gate.clone();
        let _ = thread::spawn(move || {
            let _lock = worker.inner.state.lock().unwrap();
            panic!("poison gate");
        })
        .join();
        drop(guard);
        assert_eq!(gate.inner.state.lock().unwrap_err().into_inner().active, 0);
        assert!(matches!(gate.admit(), Err(DrainError::Poisoned)));
        assert_eq!(
            gate.close_and_wait(Duration::ZERO),
            Err(DrainError::Poisoned)
        );
    }
}
