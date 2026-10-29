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

/// Why a session is woken.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Wake {
    /// New envelopes are queued for the device.
    Deliveries,
    /// A member's devices changed (restore, link, removal, deletion): the
    /// client re-checks its groups (ADR-0022).
    DevicesChanged,
}

type Sessions = HashMap<Uuid, Vec<(u64, mpsc::Sender<Wake>)>>;

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
    pub fn register(&self, device: Uuid) -> (Registration, mpsc::Receiver<Wake>) {
        // Small: pending wake-ups already cover later ones of the same kind.
        let (tx, rx) = mpsc::channel(4);
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

    /// Ends the device's sessions (it was removed): their wake channels
    /// close, and each session closes its socket.
    pub fn disconnect(&self, device: &Uuid) {
        self.lock().remove(device);
    }

    /// Tells the devices' open sessions that a member's devices changed.
    pub fn devices_changed(&self, devices: &[Uuid]) {
        let sessions = self.lock();
        for device in devices {
            for (_, tx) in sessions.get(device).into_iter().flatten() {
                let _ = tx.try_send(Wake::DevicesChanged);
            }
        }
    }

    /// Wakes the device's sessions; false if it has none (it's offline).
    pub fn wake(&self, device: &Uuid) -> bool {
        match self.lock().get(device) {
            Some(sessions) => {
                for (_, tx) in sessions {
                    let _ = tx.try_send(Wake::Deliveries);
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
        for _ in 0..10 {
            hub.wake(&device);
        }
        hub.devices_changed(&[device, Uuid::new_v4()]);
        // A burst queues a bounded number of wake-ups.
        let mut woken = Vec::new();
        while let Ok(wake) = rx.try_recv() {
            woken.push(wake);
        }
        assert_eq!(woken, [Wake::Deliveries; 4]);
        hub.devices_changed(&[device]);
        assert_eq!(rx.recv().await, Some(Wake::DevicesChanged));
        drop(reg);
        assert!(hub.lock().is_empty());
    }
}
