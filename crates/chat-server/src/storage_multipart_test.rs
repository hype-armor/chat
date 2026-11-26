//! Test-only multipart admission experiment. It is not installed in the server.
//! Successful local completion does not establish remote durability.
//! Successful backend futures must guarantee that no detached work remains.
//! The `object_store` trait alone does not establish that guarantee.

use crate::storage_drain::{StorageDrain, StorageGuard};
use crate::storage_tracked_future::track;
use object_store::{MultipartUpload, PutPayload, PutResult, UploadPart};
use std::future::Future;
use std::pin::Pin;
use std::sync::{
    Arc,
    atomic::{AtomicUsize, Ordering},
};
use std::task::{Context, Poll};

type BoxResult<'a, T> = Pin<Box<dyn Future<Output = object_store::Result<T>> + Send + 'a>>;

fn rejected() -> object_store::Error {
    object_store::Error::Generic {
        store: "multipart admission",
        source: "storage admission is closed or unavailable".into(),
    }
}

#[derive(Debug)]
struct Parts(AtomicUsize);

struct PartFuture {
    inner: UploadPart,
    _count: CountOnPanic,
}
impl Future for PartFuture {
    type Output = object_store::Result<()>;
    fn poll(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Self::Output> {
        self.inner.as_mut().poll(cx)
    }
}
struct CountOnPanic(Option<Arc<Parts>>);
impl Drop for CountOnPanic {
    fn drop(&mut self) {
        if let Some(parts) = self.0.take() {
            parts.0.fetch_sub(1, Ordering::SeqCst);
        }
    }
}

struct TrackedUpload<U> {
    // Field order keeps the guard alive during implicit handle destruction.
    inner: Option<U>,
    gate: StorageDrain,
    lifetime: Option<StorageGuard>,
    parts: Arc<Parts>,
    uncertain: bool,
}
impl<U: std::fmt::Debug> std::fmt::Debug for TrackedUpload<U> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("TrackedUpload")
            .field("inner", &self.inner)
            .finish_non_exhaustive()
    }
}
impl<U> TrackedUpload<U> {
    async fn new<F, Fut>(gate: StorageDrain, factory: F) -> object_store::Result<Self>
    where
        F: FnOnce() -> Fut,
        Fut: Future<Output = object_store::Result<U>>,
    {
        let lifetime = gate.admit().map_err(|_| rejected())?;
        let inner = factory().await?;
        Ok(Self {
            inner: Some(inner),
            gate,
            lifetime: Some(lifetime),
            parts: Arc::new(Parts(AtomicUsize::new(0))),
            uncertain: false,
        })
    }

    fn finish(&mut self, clean: bool) {
        let destroyed = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            drop(self.inner.take());
        }));
        let guard = self.lifetime.take().expect("upload lifetime");
        if clean && destroyed.is_ok() {
            guard.confirm_completion();
        } else {
            guard.mark_uncertain();
        }
        if let Err(panic) = destroyed {
            std::panic::resume_unwind(panic);
        }
    }
}
impl<U: MultipartUpload> MultipartUpload for TrackedUpload<U> {
    fn put_part(&mut self, data: PutPayload) -> UploadPart {
        if self.lifetime.is_none() {
            return Box::pin(async { Err(rejected()) });
        }
        let parts = Arc::clone(&self.parts);
        match track(&self.gate, || {
            parts.0.fetch_add(1, Ordering::SeqCst);
            let rollback = CountOnPanic(Some(Arc::clone(&parts)));
            let inner = self.inner.as_mut().expect("upload handle").put_part(data);
            PartFuture {
                inner,
                _count: rollback,
            }
        }) {
            Ok(future) => Box::pin(future),
            Err(_) => Box::pin(async { Err(rejected()) }),
        }
    }
    fn complete<'a, 'async_trait>(&'a mut self) -> BoxResult<'async_trait, PutResult>
    where
        'a: 'async_trait,
        Self: 'async_trait,
    {
        if self.lifetime.is_none() {
            return Box::pin(async { Err(rejected()) });
        }
        let clean = !self.uncertain && self.parts.0.load(Ordering::SeqCst) == 0;
        // Set before returning the future so an unpolled drop is uncertain.
        self.uncertain = true;
        Box::pin(async move {
            let result = self.inner.as_mut().expect("upload handle").complete().await;
            if result.is_ok() {
                self.finish(clean && self.parts.0.load(Ordering::SeqCst) == 0);
            }
            result
        })
    }
    fn abort<'a, 'async_trait>(&'a mut self) -> BoxResult<'async_trait, ()>
    where
        'a: 'async_trait,
        Self: 'async_trait,
    {
        if self.lifetime.is_none() {
            return Box::pin(async { Err(rejected()) });
        }
        let clean = !self.uncertain && self.parts.0.load(Ordering::SeqCst) == 0;
        self.uncertain = true;
        Box::pin(async move {
            let result = self.inner.as_mut().expect("upload handle").abort().await;
            if result.is_ok() {
                self.finish(clean && self.parts.0.load(Ordering::SeqCst) == 0);
            }
            result
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage_drain::DrainOutcome;
    use std::time::Duration;

    #[derive(Debug)]
    struct Fake;
    impl MultipartUpload for Fake {
        fn put_part(&mut self, _: PutPayload) -> UploadPart {
            Box::pin(async { Ok(()) })
        }
        fn complete<'a, 'async_trait>(&'a mut self) -> BoxResult<'async_trait, PutResult>
        where
            'a: 'async_trait,
            Self: 'async_trait,
        {
            Box::pin(async {
                Ok(PutResult {
                    e_tag: None,
                    version: None,
                    extensions: Default::default(),
                })
            })
        }
        fn abort<'a, 'async_trait>(&'a mut self) -> BoxResult<'async_trait, ()>
        where
            'a: 'async_trait,
            Self: 'async_trait,
        {
            Box::pin(async { Ok(()) })
        }
    }
    fn outcome(gate: &StorageDrain) -> DrainOutcome {
        gate.close_and_wait(Duration::ZERO).unwrap()
    }

    #[tokio::test]
    async fn part_creation_and_unpolled_drop() {
        let gate = StorageDrain::new();
        let mut upload = TrackedUpload::new(gate.clone(), || async { Ok(Fake) })
            .await
            .unwrap();
        let part = upload.put_part(Vec::new().into());
        drop(part);
        upload.abort().await.unwrap();
        assert_eq!(outcome(&gate), DrainOutcome::Uncertain);
    }
    #[tokio::test]
    async fn abort_does_not_fence_held_part() {
        let gate = StorageDrain::new();
        let mut upload = TrackedUpload::new(gate.clone(), || async { Ok(Fake) })
            .await
            .unwrap();
        let part = upload.put_part(Vec::new().into());
        upload.abort().await.unwrap();
        assert_eq!(outcome(&gate), DrainOutcome::TimedOut);
        part.await.unwrap();
        assert_eq!(outcome(&gate), DrainOutcome::Uncertain);
    }
    #[tokio::test]
    async fn successful_upload_and_unfinished_handle() {
        let gate = StorageDrain::new();
        let mut upload = TrackedUpload::new(gate.clone(), || async { Ok(Fake) })
            .await
            .unwrap();
        upload.put_part(Vec::new().into()).await.unwrap();
        upload.complete().await.unwrap();
        assert_eq!(outcome(&gate), DrainOutcome::Completed);
        let gate = StorageDrain::new();
        let upload = TrackedUpload::new(gate.clone(), || async { Ok(Fake) })
            .await
            .unwrap();
        drop(upload);
        assert_eq!(outcome(&gate), DrainOutcome::Uncertain);
    }
    #[tokio::test]
    async fn factory_admission_and_cancellation() {
        use std::sync::atomic::AtomicBool;
        let gate = StorageDrain::new();
        assert_eq!(outcome(&gate), DrainOutcome::Completed);
        let called = AtomicBool::new(false);
        let result = TrackedUpload::new(gate, || {
            called.store(true, Ordering::SeqCst);
            async { Ok(Fake) }
        })
        .await;
        assert!(result.is_err());
        assert!(!called.load(Ordering::SeqCst));

        let gate = StorageDrain::new();
        let mut creation = Box::pin(TrackedUpload::<Fake>::new(gate.clone(), || async {
            std::future::pending::<object_store::Result<Fake>>().await
        }));
        std::future::poll_fn(|cx| {
            assert!(creation.as_mut().poll(cx).is_pending());
            Poll::Ready(())
        })
        .await;
        assert_eq!(outcome(&gate), DrainOutcome::TimedOut);
        drop(creation);
        assert_eq!(outcome(&gate), DrainOutcome::Uncertain);

        let gate = StorageDrain::new();
        let task = tokio::spawn(TrackedUpload::<Fake>::new(gate.clone(), || async {
            panic!("factory panic");
            #[allow(unreachable_code)]
            Ok(Fake)
        }));
        assert!(task.await.unwrap_err().is_panic());
        assert_eq!(outcome(&gate), DrainOutcome::Uncertain);
    }

    #[tokio::test]
    async fn cleanup_after_close_and_held_parts() {
        for complete in [false, true] {
            for held in [false, true] {
                let gate = StorageDrain::new();
                let mut upload = TrackedUpload::new(gate.clone(), || async { Ok(Fake) })
                    .await
                    .unwrap();
                let part = held.then(|| upload.put_part(Vec::new().into()));
                assert_eq!(outcome(&gate), DrainOutcome::TimedOut);
                if complete {
                    upload.complete().await.unwrap();
                } else {
                    upload.abort().await.unwrap();
                }
                if let Some(part) = part {
                    assert_eq!(outcome(&gate), DrainOutcome::TimedOut);
                    part.await.unwrap();
                }
                assert_eq!(
                    outcome(&gate),
                    if held {
                        DrainOutcome::Uncertain
                    } else {
                        DrainOutcome::Completed
                    }
                );
            }
        }
    }

    #[derive(Debug)]
    struct DropHandle {
        entered: std::sync::mpsc::Sender<()>,
        release: std::sync::mpsc::Receiver<()>,
        panic: bool,
    }
    impl Drop for DropHandle {
        fn drop(&mut self) {
            self.entered.send(()).unwrap();
            self.release.recv().unwrap();
            assert!(!self.panic, "handle drop panic");
        }
    }
    impl MultipartUpload for DropHandle {
        fn put_part(&mut self, _: PutPayload) -> UploadPart {
            Box::pin(async { Ok(()) })
        }
        fn complete<'a, 'async_trait>(&'a mut self) -> BoxResult<'async_trait, PutResult>
        where
            'a: 'async_trait,
            Self: 'async_trait,
        {
            Box::pin(async {
                Ok(PutResult {
                    e_tag: None,
                    version: None,
                    extensions: Default::default(),
                })
            })
        }
        fn abort<'a, 'async_trait>(&'a mut self) -> BoxResult<'async_trait, ()>
        where
            'a: 'async_trait,
            Self: 'async_trait,
        {
            Box::pin(async { Ok(()) })
        }
    }

    #[tokio::test]
    async fn terminal_handle_destructor_is_fenced() {
        for panic in [false, true] {
            let gate = StorageDrain::new();
            let (entered, entered_rx) = std::sync::mpsc::channel();
            let (release, release_rx) = std::sync::mpsc::channel();
            let mut upload = TrackedUpload::new(gate.clone(), || async move {
                Ok(DropHandle {
                    entered,
                    release: release_rx,
                    panic,
                })
            })
            .await
            .unwrap();
            let worker = std::thread::spawn(move || {
                let runtime = tokio::runtime::Builder::new_current_thread()
                    .build()
                    .unwrap();
                std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    runtime.block_on(upload.abort())
                }))
            });
            entered_rx.recv_timeout(Duration::from_secs(5)).unwrap();
            assert_eq!(outcome(&gate), DrainOutcome::TimedOut);
            release.send(()).unwrap();
            assert_eq!(worker.join().unwrap().is_err(), panic);
            assert_eq!(
                outcome(&gate),
                if panic {
                    DrainOutcome::Uncertain
                } else {
                    DrainOutcome::Completed
                }
            );
        }
    }

    #[derive(Debug)]
    struct PanicPart(bool);
    impl MultipartUpload for PanicPart {
        fn put_part(&mut self, _: PutPayload) -> UploadPart {
            assert!(!self.0, "part factory panic");
            Box::pin(async { panic!("part poll panic") })
        }
        fn complete<'a, 'async_trait>(&'a mut self) -> BoxResult<'async_trait, PutResult>
        where
            'a: 'async_trait,
            Self: 'async_trait,
        {
            Box::pin(async {
                Ok(PutResult {
                    e_tag: None,
                    version: None,
                    extensions: Default::default(),
                })
            })
        }
        fn abort<'a, 'async_trait>(&'a mut self) -> BoxResult<'async_trait, ()>
        where
            'a: 'async_trait,
            Self: 'async_trait,
        {
            Box::pin(async { Ok(()) })
        }
    }

    #[tokio::test]
    async fn part_factory_and_poll_panics_are_uncertain() {
        for factory_panic in [true, false] {
            let gate = StorageDrain::new();
            let mut upload =
                TrackedUpload::new(gate.clone(), || async { Ok(PanicPart(factory_panic)) })
                    .await
                    .unwrap();
            if factory_panic {
                assert!(
                    std::panic::catch_unwind(std::panic::AssertUnwindSafe(
                        || upload.put_part(Vec::new().into())
                    ))
                    .is_err()
                );
            } else {
                let part = upload.put_part(Vec::new().into());
                assert!(tokio::spawn(part).await.unwrap_err().is_panic());
            }
            upload.abort().await.unwrap();
            assert_eq!(outcome(&gate), DrainOutcome::Uncertain);
        }
    }

    #[derive(Debug, Clone, Copy)]
    enum Behavior {
        Pending,
        Error,
        Panic,
    }

    #[derive(Debug)]
    struct TerminalFake {
        behavior: Behavior,
        calls: Arc<AtomicUsize>,
    }
    impl MultipartUpload for TerminalFake {
        fn put_part(&mut self, _: PutPayload) -> UploadPart {
            self.calls.fetch_add(1, Ordering::SeqCst);
            Box::pin(async { Ok(()) })
        }
        fn complete<'a, 'async_trait>(&'a mut self) -> BoxResult<'async_trait, PutResult>
        where
            'a: 'async_trait,
            Self: 'async_trait,
        {
            let behavior = self.behavior;
            Box::pin(async move {
                match behavior {
                    Behavior::Pending => std::future::pending().await,
                    Behavior::Error => Err(rejected()),
                    Behavior::Panic => panic!("terminal poll panic"),
                }
            })
        }
        fn abort<'a, 'async_trait>(&'a mut self) -> BoxResult<'async_trait, ()>
        where
            'a: 'async_trait,
            Self: 'async_trait,
        {
            let behavior = self.behavior;
            Box::pin(async move {
                match behavior {
                    Behavior::Pending => std::future::pending().await,
                    Behavior::Error => Err(rejected()),
                    Behavior::Panic => panic!("terminal poll panic"),
                }
            })
        }
    }

    #[tokio::test]
    async fn terminal_pending_error_and_panic_are_uncertain() {
        for complete in [false, true] {
            for behavior in [Behavior::Pending, Behavior::Error, Behavior::Panic] {
                let gate = StorageDrain::new();
                let mut upload = TrackedUpload::new(gate.clone(), || async {
                    Ok(TerminalFake {
                        behavior,
                        calls: Arc::new(AtomicUsize::new(0)),
                    })
                })
                .await
                .unwrap();
                let mut terminal: Pin<Box<dyn Future<Output = ()> + Send + '_>> = if complete {
                    Box::pin(async {
                        let _ = upload.complete().await;
                    })
                } else {
                    Box::pin(async {
                        let _ = upload.abort().await;
                    })
                };
                let polled = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    let waker = std::task::Waker::noop();
                    terminal.as_mut().poll(&mut Context::from_waker(waker))
                }));
                match behavior {
                    Behavior::Pending => assert!(polled.unwrap().is_pending()),
                    Behavior::Error => assert!(polled.unwrap().is_ready()),
                    Behavior::Panic => assert!(polled.is_err()),
                }
                assert_eq!(outcome(&gate), DrainOutcome::TimedOut);
                drop(terminal);
                drop(upload);
                assert_eq!(outcome(&gate), DrainOutcome::Uncertain);
            }
        }
    }

    #[tokio::test]
    async fn rejected_part_never_calls_backend() {
        let gate = StorageDrain::new();
        let calls = Arc::new(AtomicUsize::new(0));
        let mut upload = TrackedUpload::new(gate.clone(), || async {
            Ok(TerminalFake {
                behavior: Behavior::Error,
                calls: calls.clone(),
            })
        })
        .await
        .unwrap();
        assert_eq!(outcome(&gate), DrainOutcome::TimedOut);
        assert!(upload.put_part(Vec::new().into()).await.is_err());
        assert_eq!(calls.load(Ordering::SeqCst), 0);
        drop(upload);
        assert_eq!(outcome(&gate), DrainOutcome::Uncertain);
    }

    struct PendingDrop<T> {
        entered: std::sync::mpsc::Sender<()>,
        release: std::sync::mpsc::Receiver<()>,
        panic: bool,
        output: std::marker::PhantomData<T>,
    }
    impl<T> Future for PendingDrop<T> {
        type Output = object_store::Result<T>;
        fn poll(self: Pin<&mut Self>, _: &mut Context<'_>) -> Poll<Self::Output> {
            Poll::Pending
        }
    }
    impl<T> Drop for PendingDrop<T> {
        fn drop(&mut self) {
            self.entered.send(()).unwrap();
            self.release.recv().unwrap();
            assert!(!self.panic, "future destructor panic");
        }
    }
    #[derive(Debug)]
    struct DropFutureBackend {
        channels: Option<(
            std::sync::mpsc::Sender<()>,
            std::sync::mpsc::Receiver<()>,
            bool,
        )>,
    }
    impl DropFutureBackend {
        fn pending<T>(&mut self) -> PendingDrop<T> {
            let (entered, release, panic) = self.channels.take().unwrap();
            PendingDrop {
                entered,
                release,
                panic,
                output: std::marker::PhantomData,
            }
        }
    }
    impl MultipartUpload for DropFutureBackend {
        fn put_part(&mut self, _: PutPayload) -> UploadPart {
            Box::pin(self.pending())
        }
        fn complete<'a, 'async_trait>(&'a mut self) -> BoxResult<'async_trait, PutResult>
        where
            'a: 'async_trait,
            Self: 'async_trait,
        {
            Box::pin(self.pending())
        }
        fn abort<'a, 'async_trait>(&'a mut self) -> BoxResult<'async_trait, ()>
        where
            'a: 'async_trait,
            Self: 'async_trait,
        {
            Box::pin(self.pending())
        }
    }

    #[test]
    fn pending_future_destructors_are_fenced() {
        for kind in 0..4 {
            for panic in [false, true] {
                let gate = StorageDrain::new();
                let worker_gate = gate.clone();
                let (entered, entered_rx) = std::sync::mpsc::channel();
                let (release, release_rx) = std::sync::mpsc::channel();
                let (ready, ready_rx) = std::sync::mpsc::channel();
                let worker = std::thread::spawn(move || {
                    let rt = tokio::runtime::Builder::new_current_thread()
                        .build()
                        .unwrap();
                    std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                        rt.block_on(async move {
                            if kind == 0 {
                                let mut creation =
                                    Box::pin(TrackedUpload::new(worker_gate, || PendingDrop::<
                                        DropFutureBackend,
                                    > {
                                        entered,
                                        release: release_rx,
                                        panic,
                                        output: std::marker::PhantomData,
                                    }));
                                std::future::poll_fn(|cx| {
                                    assert!(creation.as_mut().poll(cx).is_pending());
                                    Poll::Ready(())
                                })
                                .await;
                                ready.send(()).unwrap();
                                drop(creation);
                            } else {
                                let mut upload = TrackedUpload::new(worker_gate, || async {
                                    Ok(DropFutureBackend {
                                        channels: Some((entered, release_rx, panic)),
                                    })
                                })
                                .await
                                .unwrap();
                                let mut future: Pin<Box<dyn Future<Output = ()> + Send + '_>> =
                                    match kind {
                                        1 => {
                                            let part = upload.put_part(Vec::new().into());
                                            Box::pin(async move {
                                                let _ = part.await;
                                            })
                                        }
                                        2 => Box::pin(async {
                                            let _ = upload.complete().await;
                                        }),
                                        _ => Box::pin(async {
                                            let _ = upload.abort().await;
                                        }),
                                    };
                                std::future::poll_fn(|cx| {
                                    assert!(future.as_mut().poll(cx).is_pending());
                                    Poll::Ready(())
                                })
                                .await;
                                ready.send(()).unwrap();
                                drop(future);
                            }
                        })
                    }))
                });
                ready_rx.recv_timeout(Duration::from_secs(5)).unwrap();
                entered_rx.recv_timeout(Duration::from_secs(5)).unwrap();
                assert_eq!(outcome(&gate), DrainOutcome::TimedOut);
                release.send(()).unwrap();
                assert_eq!(worker.join().unwrap().is_err(), panic);
                assert_eq!(outcome(&gate), DrainOutcome::Uncertain);
            }
        }
    }

    #[tokio::test]
    async fn admission_before_close_fences_factory() {
        let gate = StorageDrain::new();
        let worker_gate = gate.clone();
        let (entered, entered_rx) = std::sync::mpsc::channel();
        let (release, release_rx) = std::sync::mpsc::channel();
        let worker = std::thread::spawn(move || {
            let rt = tokio::runtime::Builder::new_current_thread()
                .build()
                .unwrap();
            rt.block_on(TrackedUpload::new(worker_gate, || {
                entered.send(()).unwrap();
                release_rx.recv().unwrap();
                async { Ok(Fake) }
            }))
            .unwrap()
        });
        entered_rx.recv_timeout(Duration::from_secs(5)).unwrap();
        assert_eq!(outcome(&gate), DrainOutcome::TimedOut);
        release.send(()).unwrap();
        let mut upload = worker.join().unwrap();
        upload.abort().await.unwrap();
        assert_eq!(outcome(&gate), DrainOutcome::Completed);
    }

    #[derive(Debug)]
    struct BlockingPart {
        entered: std::sync::mpsc::Sender<()>,
        release: std::sync::mpsc::Receiver<()>,
    }
    impl MultipartUpload for BlockingPart {
        fn put_part(&mut self, _: PutPayload) -> UploadPart {
            self.entered.send(()).unwrap();
            self.release.recv().unwrap();
            Box::pin(async { Ok(()) })
        }
        fn complete<'a, 'async_trait>(&'a mut self) -> BoxResult<'async_trait, PutResult>
        where
            'a: 'async_trait,
            Self: 'async_trait,
        {
            Box::pin(async {
                Ok(PutResult {
                    e_tag: None,
                    version: None,
                    extensions: Default::default(),
                })
            })
        }
        fn abort<'a, 'async_trait>(&'a mut self) -> BoxResult<'async_trait, ()>
        where
            'a: 'async_trait,
            Self: 'async_trait,
        {
            Box::pin(async { Ok(()) })
        }
    }

    #[tokio::test]
    async fn part_admission_before_close_fences_factory() {
        let gate = StorageDrain::new();
        let (entered, entered_rx) = std::sync::mpsc::channel();
        let (release, release_rx) = std::sync::mpsc::channel();
        let mut upload = TrackedUpload::new(gate.clone(), || async {
            Ok(BlockingPart {
                entered,
                release: release_rx,
            })
        })
        .await
        .unwrap();
        let worker = std::thread::spawn(move || {
            let part = upload.put_part(Vec::new().into());
            (upload, part)
        });
        entered_rx.recv_timeout(Duration::from_secs(5)).unwrap();
        assert_eq!(outcome(&gate), DrainOutcome::TimedOut);
        release.send(()).unwrap();
        let (mut upload, part) = worker.join().unwrap();
        part.await.unwrap();
        upload.abort().await.unwrap();
        assert_eq!(outcome(&gate), DrainOutcome::Completed);
    }

    #[tokio::test]
    async fn implicit_handle_destructor_is_fenced() {
        for panic in [false, true] {
            let gate = StorageDrain::new();
            let (entered, entered_rx) = std::sync::mpsc::channel();
            let (release, release_rx) = std::sync::mpsc::channel();
            let upload = TrackedUpload::new(gate.clone(), || async move {
                Ok(DropHandle {
                    entered,
                    release: release_rx,
                    panic,
                })
            })
            .await
            .unwrap();
            let worker = std::thread::spawn(move || {
                std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| drop(upload)))
            });
            entered_rx.recv_timeout(Duration::from_secs(5)).unwrap();
            assert_eq!(outcome(&gate), DrainOutcome::TimedOut);
            release.send(()).unwrap();
            assert_eq!(worker.join().unwrap().is_err(), panic);
            assert_eq!(outcome(&gate), DrainOutcome::Uncertain);
        }
    }

    #[tokio::test]
    async fn cancelled_terminal_future_is_uncertain() {
        let gate = StorageDrain::new();
        let mut upload = TrackedUpload::new(gate.clone(), || async { Ok(Fake) })
            .await
            .unwrap();
        drop(upload.abort());
        upload.abort().await.unwrap();
        assert_eq!(outcome(&gate), DrainOutcome::Uncertain);
    }
}
