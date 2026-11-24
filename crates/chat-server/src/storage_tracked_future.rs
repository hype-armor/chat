//! Admission tracking for a single result-returning future.
//!
//! This module is not integrated with a storage client. An `Ok` result must
//! mean that the admitted work has ended; it does not prove remote durability
//! or completion of detached work. A returned value or detached task must not
//! start relevant work after success. Rejected factory captures can have `Drop`
//! side effects. Uncertainty does not prove that work has stopped.

use crate::storage_drain::{DrainError, StorageDrain, StorageGuard};
use std::future::Future;
use std::panic::{AssertUnwindSafe, catch_unwind, resume_unwind};
use std::pin::Pin;
use std::task::{Context, Poll};

/// Owns an admission guard from before future creation until its result.
#[must_use]
pub struct TrackedFuture<F> {
    future: Option<Pin<Box<F>>>,
    guard: Option<StorageGuard>,
}

/// Admits work before calling `factory`. A rejected admission never calls it.
/// A factory panic drops the guard without confirmation.
pub fn track<F, Make>(gate: &StorageDrain, factory: Make) -> Result<TrackedFuture<F>, DrainError>
where
    F: Future,
    Make: FnOnce() -> F,
{
    let guard = gate.admit()?;
    let future = Box::pin(factory());
    Ok(TrackedFuture {
        future: Some(future),
        guard: Some(guard),
    })
}

impl<F, T, E> Future for TrackedFuture<F>
where
    F: Future<Output = Result<T, E>>,
{
    type Output = Result<T, E>;

    fn poll(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Self::Output> {
        let this = self.get_mut();
        assert!(
            this.guard.is_some(),
            "tracked future polled after completion"
        );
        let polled = catch_unwind(AssertUnwindSafe(|| {
            this.future
                .as_mut()
                .expect("future is present")
                .as_mut()
                .poll(cx)
        }));
        if matches!(polled, Ok(Poll::Pending)) {
            return Poll::Pending;
        }
        // Keep the guard active until destruction ends, even if Drop panics.
        let destroyed = catch_unwind(AssertUnwindSafe(|| drop(this.future.take())));
        if let Err(panic) = destroyed {
            drop(this.guard.take());
            // Preserve the poll panic when both operations panic. Do not drop
            // its payload during unwinding: an arbitrary payload can panic too.
            if let Err(poll_panic) = polled {
                std::mem::forget(panic);
                resume_unwind(poll_panic);
            }
            resume_unwind(panic);
        }
        match polled {
            Ok(Poll::Pending) => unreachable!(),
            Ok(Poll::Ready(result)) => {
                let guard = this.guard.take().expect("guard is present");
                if result.is_ok() {
                    guard.confirm_completion();
                } else {
                    guard.mark_uncertain();
                }
                Poll::Ready(result)
            }
            Err(panic) => {
                // Record uncertainty even if the caller retains this wrapper.
                drop(this.guard.take());
                resume_unwind(panic)
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage_drain::DrainOutcome;
    use std::sync::Arc;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::task::{Wake, Waker};
    use std::time::Duration;

    struct Noop;
    impl Wake for Noop {
        fn wake(self: Arc<Self>) {}
    }

    fn poll<F: Future>(future: Pin<&mut F>) -> Poll<F::Output> {
        let waker = Waker::from(Arc::new(Noop));
        future.poll(&mut Context::from_waker(&waker))
    }

    fn outcome(gate: &StorageDrain) -> DrainOutcome {
        gate.close_and_wait(Duration::ZERO).unwrap()
    }

    #[test]
    fn unpolled_drop_is_uncertain() {
        let gate = StorageDrain::new();
        let future = track(&gate, || async { Ok::<_, ()>(()) }).unwrap();
        assert_eq!(outcome(&gate), DrainOutcome::TimedOut);
        drop(future);
        assert_eq!(outcome(&gate), DrainOutcome::Uncertain);
    }

    #[test]
    fn pending_drop_is_uncertain() {
        let gate = StorageDrain::new();
        let mut future = track(&gate, || std::future::pending::<Result<(), ()>>()).unwrap();
        assert!(poll(Pin::new(&mut future)).is_pending());
        assert_eq!(outcome(&gate), DrainOutcome::TimedOut);
        drop(future);
        assert_eq!(outcome(&gate), DrainOutcome::Uncertain);
    }

    #[test]
    fn success_confirms() {
        let gate = StorageDrain::new();
        let mut future = track(&gate, || async { Ok::<_, ()>(42) }).unwrap();
        assert_eq!(poll(Pin::new(&mut future)), Poll::Ready(Ok(42)));
        assert_eq!(outcome(&gate), DrainOutcome::Completed);
    }

    #[test]
    fn error_is_uncertain() {
        let gate = StorageDrain::new();
        let mut future = track(&gate, || async { Err::<(), _>("error") }).unwrap();
        assert_eq!(poll(Pin::new(&mut future)), Poll::Ready(Err("error")));
        assert_eq!(outcome(&gate), DrainOutcome::Uncertain);
    }

    #[test]
    fn factory_panic_is_uncertain() {
        let gate = StorageDrain::new();
        let result = catch_unwind(AssertUnwindSafe(|| {
            let _ = track(&gate, || -> std::future::Ready<Result<(), ()>> {
                panic!("factory panic")
            });
        }));
        assert!(result.is_err());
        assert_eq!(outcome(&gate), DrainOutcome::Uncertain);
    }

    #[test]
    fn poll_panic_is_uncertain_even_if_wrapper_is_retained() {
        let gate = StorageDrain::new();
        let mut future = track(&gate, || async {
            panic!("poll panic");
            #[allow(unreachable_code)]
            Ok::<(), ()>(())
        })
        .unwrap();
        assert!(catch_unwind(AssertUnwindSafe(|| poll(Pin::new(&mut future)))).is_err());
        assert_eq!(outcome(&gate), DrainOutcome::Uncertain);
    }

    struct DropObserved {
        entered: std::sync::mpsc::Sender<()>,
        release: std::sync::mpsc::Receiver<()>,
        poll_panics: bool,
        drop_panics: bool,
    }

    impl Future for DropObserved {
        type Output = Result<(), ()>;

        fn poll(self: Pin<&mut Self>, _: &mut Context<'_>) -> Poll<Self::Output> {
            assert!(!self.poll_panics, "poll panic");
            Poll::Ready(Ok(()))
        }
    }

    impl Drop for DropObserved {
        fn drop(&mut self) {
            self.entered.send(()).unwrap();
            self.release.recv().unwrap();
            assert!(!self.drop_panics, "drop panic");
        }
    }

    fn check_destructor(poll_panics: bool, drop_panics: bool) {
        let gate = StorageDrain::new();
        let (entered_tx, entered_rx) = std::sync::mpsc::channel();
        let (release_tx, release_rx) = std::sync::mpsc::channel();
        let mut future = track(&gate, || DropObserved {
            entered: entered_tx,
            release: release_rx,
            poll_panics,
            drop_panics,
        })
        .unwrap();
        let worker = std::thread::spawn(move || {
            let result = catch_unwind(AssertUnwindSafe(|| poll(Pin::new(&mut future))));
            // Keep the wrapper alive until after the caller catches a panic.
            (result, future)
        });
        entered_rx.recv_timeout(Duration::from_secs(5)).unwrap();
        assert_eq!(outcome(&gate), DrainOutcome::TimedOut);
        release_tx.send(()).unwrap();
        let (result, future) = worker.join().unwrap();
        assert_eq!(result.is_err(), poll_panics || drop_panics);
        assert_eq!(
            outcome(&gate),
            if poll_panics || drop_panics {
                DrainOutcome::Uncertain
            } else {
                DrainOutcome::Completed
            }
        );
        drop(future);
    }

    #[test]
    fn guard_stays_active_through_successful_destruction() {
        check_destructor(false, false);
    }

    #[test]
    fn destructor_panic_is_uncertain() {
        check_destructor(false, true);
    }

    #[test]
    fn poll_panic_keeps_guard_through_destruction() {
        check_destructor(true, false);
    }

    #[test]
    fn poll_and_destructor_panic_are_uncertain() {
        check_destructor(true, true);
    }

    #[test]
    fn closed_admission_does_not_call_factory() {
        let gate = StorageDrain::new();
        assert_eq!(outcome(&gate), DrainOutcome::Completed);
        let called = AtomicBool::new(false);
        let result = track(&gate, || {
            called.store(true, Ordering::SeqCst);
            async { Ok::<_, ()>(()) }
        });
        assert!(matches!(result, Err(DrainError::Closed)));
        assert!(!called.load(Ordering::SeqCst));
    }
}
