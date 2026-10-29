//! In-process wake-ups for connected devices. A send stores envelopes in
//! PostgreSQL first, then wakes the recipients' sessions, which read their
//! queues. With more than one server replica this becomes PostgreSQL
//! LISTEN/NOTIFY or Valkey pub/sub.

use std::{
    collections::HashMap,
    sync::{
        Arc, Mutex,
        atomic::{AtomicU64, Ordering},
    },
};

use tokio::sync::mpsc;
use uuid::Uuid;

type Sessions = HashMap<Uuid, Vec<(u64, mpsc::Sender<()>)>>;

#[derive(Clone, Default)]
pub struct Hub {
    sessions: Arc<Mutex<Sessions>>,
    next_id: Arc<AtomicU64>,
}

/// Removes the session from the hub when dropped.
pub struct Registration {
    hub: Hub,
    device: Uuid,
    id: u64,
}

impl Hub {
    pub fn register(&self, device: Uuid) -> (Registration, mpsc::Receiver<()>) {
        // Capacity 1: a pending wake-up already covers any later ones.
        let (tx, rx) = mpsc::channel(1);
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        self.lock().entry(device).or_default().push((id, tx));
        (
            Registration {
                hub: self.clone(),
                device,
                id,
            },
            rx,
        )
    }

    /// Wakes the device's sessions; false if it has none (it's offline).
    pub fn wake(&self, device: &Uuid) -> bool {
        match self.lock().get(device) {
            Some(sessions) => {
                for (_, tx) in sessions {
                    let _ = tx.try_send(());
                }
                true
            }
            None => false,
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Sessions> {
        self.sessions.lock().unwrap_or_else(|e| e.into_inner())
    }
}

impl Drop for Registration {
    fn drop(&mut self) {
        let mut sessions = self.hub.lock();
        if let Some(list) = sessions.get_mut(&self.device) {
            list.retain(|(id, _)| *id != self.id);
            if list.is_empty() {
                sessions.remove(&self.device);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn wakes_registered_sessions_and_cleans_up() {
        let hub = Hub::default();
        let device = Uuid::new_v4();
        let (reg, mut rx) = hub.register(device);
        hub.wake(&device);
        hub.wake(&device); // coalesced
        assert!(rx.recv().await.is_some());
        assert!(rx.try_recv().is_err());
        drop(reg);
        assert!(hub.lock().is_empty());
    }
}
