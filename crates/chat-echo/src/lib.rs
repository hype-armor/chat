//! Echo test bot (development and testing only). A real client with its own
//! account and device keys: it decrypts what members send and sends the
//! same back, so one person can try every feature end to end. The server
//! sees only ciphertext, as with anyone else.
//!
//! What comes back:
//! - text, attachments (the same blob and key: no re-upload) and shared
//!   locations, as they arrived;
//! - live location: a session of its own that mirrors the sender's point;
//! - a read receipt for each echoed message.

use std::collections::HashMap;

use chat_core::client::{Client, Event};
use chat_proto::v1::{Content, Envelope, LiveLocation, Profile, Receipt, content, receipt};

pub const DISPLAY_NAME: &str = "Echo (test bot)";

/// An envelope to send, and to which devices.
#[derive(Debug)]
pub struct Outgoing {
    pub envelope: Envelope,
    /// 16-byte device ids.
    pub recipients: Vec<Vec<u8>>,
    /// No Web Push (receipts, live-location updates).
    pub silent: bool,
}

pub struct Echo {
    client: Client,
    name: String,
    /// Sender identity ‖ their live session id → our mirroring session id.
    live: HashMap<Vec<u8>, Vec<u8>>,
}

fn random_id() -> Vec<u8> {
    rand::random::<[u8; 16]>().to_vec()
}

impl Echo {
    pub fn new(client: Client, name: impl Into<String>) -> Self {
        Self {
            client,
            name: name.into(),
            live: HashMap::new(),
        }
    }

    pub fn client(&self) -> &Client {
        &self.client
    }

    pub fn client_mut(&mut self) -> &mut Client {
        &mut self.client
    }

    /// Processes one delivered envelope; returns what to send in reply.
    pub fn handle(&mut self, env: &Envelope, now_ms: u64) -> chat_core::Result<Vec<Outgoing>> {
        match self.client.receive(env)? {
            // Introduce ourselves so the conversation shows our name.
            Event::Joined { conversation_id } => Ok(vec![self.send(
                &conversation_id,
                content::Body::Profile(Profile {
                    display_name: self.name.clone(),
                }),
                now_ms,
                false,
            )?]),
            Event::Message {
                conversation_id,
                sender,
                content,
            } if sender != self.client.identity() => {
                let Some(body) = content.body else {
                    return Ok(Vec::new());
                };
                let (reply, silent, receipt) = match body {
                    b @ (content::Body::Text(_)
                    | content::Body::Attachment(_)
                    | content::Body::Location(_)) => (b, false, true),
                    content::Body::LiveLocation(l) => {
                        let key = [sender.as_slice(), &l.session_id].concat();
                        let started = !self.live.contains_key(&key);
                        let ours = self
                            .live
                            .entry(key.clone())
                            .or_insert_with(random_id)
                            .clone();
                        if l.stopped {
                            self.live.remove(&key);
                        }
                        let mirrored = LiveLocation {
                            session_id: ours,
                            ..l
                        };
                        (content::Body::LiveLocation(mirrored), !started, started)
                    }
                    // Profiles, group details, receipts, device sync: nothing to echo.
                    _ => return Ok(Vec::new()),
                };
                let mut out = Vec::new();
                if receipt {
                    out.push(self.send(
                        &conversation_id,
                        content::Body::Receipt(Receipt {
                            kind: receipt::Kind::Read.into(),
                            message_ids: vec![env.message_id.clone()],
                        }),
                        now_ms,
                        true,
                    )?);
                }
                out.push(self.send(&conversation_id, reply, now_ms, silent)?);
                Ok(out)
            }
            _ => Ok(Vec::new()),
        }
    }

    fn send(
        &mut self,
        conversation_id: &[u8],
        body: content::Body,
        now_ms: u64,
        silent: bool,
    ) -> chat_core::Result<Outgoing> {
        let content = Content {
            sent_at_ms: now_ms,
            body: Some(body),
        };
        let envelope = self.client.send(conversation_id, &content, random_id())?;
        let me = self.client.identity().to_vec();
        // Identities are account id ‖ device id (16 bytes each).
        let recipients = self
            .client
            .members(conversation_id)?
            .into_iter()
            .filter(|m| *m != me && m.len() == 32)
            .map(|m| m[16..].to_vec())
            .collect();
        Ok(Outgoing {
            envelope,
            recipients,
            silent,
        })
    }
}

#[cfg(test)]
mod tests {
    use chat_core::mls::Device;
    use chat_proto::v1::{Attachment, Location, Text};

    use super::*;

    fn identity(account: u8, device: u8) -> Vec<u8> {
        [[account; 16], [device; 16]].concat()
    }

    /// Alice starts a conversation with the bot; returns both and its id.
    fn setup() -> (Client, Echo, Vec<u8>) {
        let mut alice = Client::new(Device::new(&identity(1, 1)).unwrap());
        let mut echo = Echo::new(Client::new(Device::new(&identity(2, 2)).unwrap()), "Echo");
        let kp = echo.client().key_packages(1).unwrap().remove(0);
        let started = alice.start_conversation(&[&kp], vec![9]).unwrap();
        let out = echo.handle(&started.welcome, 1).unwrap();
        // Joining: the bot introduces itself, to Alice's device only.
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].recipients, vec![vec![1u8; 16]]);
        match alice.receive(&out[0].envelope).unwrap() {
            Event::Message { content, .. } => assert!(matches!(
                content.body,
                Some(content::Body::Profile(Profile { ref display_name })) if display_name == "Echo"
            )),
            other => panic!("expected a profile, got {other:?}"),
        }
        (alice, echo, started.conversation_id)
    }

    fn say(alice: &mut Client, id: &[u8], body: content::Body) -> Envelope {
        let content = Content {
            sent_at_ms: 5,
            body: Some(body),
        };
        alice.send(id, &content, random_id()).unwrap()
    }

    fn bodies(alice: &mut Client, out: Vec<Outgoing>) -> Vec<content::Body> {
        out.into_iter()
            .map(|o| match alice.receive(&o.envelope).unwrap() {
                Event::Message { content, .. } => content.body.unwrap(),
                other => panic!("expected a message, got {other:?}"),
            })
            .collect()
    }

    #[test]
    fn echoes_text_attachments_and_locations_with_a_read_receipt() {
        let (mut alice, mut echo, id) = setup();
        let attachment = Attachment {
            blob_id: vec![3; 16],
            key: vec![4; 32],
            digest: vec![5; 32],
            size: 1234,
            mime: "image/jpeg".into(),
            name: "a.jpg".into(),
            ..Attachment::default()
        };
        let location = Location {
            latitude: 48.8584,
            longitude: 2.2945,
            accuracy_m: 12.0,
            label: String::new(),
        };
        for body in [
            content::Body::Text(Text {
                body: "hello".into(),
            }),
            content::Body::Attachment(attachment),
            content::Body::Location(location),
        ] {
            let env = say(&mut alice, &id, body.clone());
            let out = echo.handle(&env, 10).unwrap();
            assert!(out[0].silent && !out[1].silent);
            let got = bodies(&mut alice, out);
            assert!(matches!(
                &got[0],
                content::Body::Receipt(r) if r.message_ids == vec![env.message_id.clone()]
            ));
            assert_eq!(got[1], body);
        }
    }

    #[test]
    fn mirrors_a_live_location_session() {
        let (mut alice, mut echo, id) = setup();
        let point = |lat| Location {
            latitude: lat,
            longitude: 2.0,
            accuracy_m: 5.0,
            label: String::new(),
        };
        let live = |lat: Option<f64>| {
            content::Body::LiveLocation(LiveLocation {
                session_id: vec![7; 16],
                expires_at_ms: 900_000,
                location: lat.map(point),
                stopped: lat.is_none(),
            })
        };
        let mut session = None;
        for (lat, silent) in [(Some(1.0), false), (Some(2.0), true), (None, true)] {
            let env = say(&mut alice, &id, live(lat));
            let out = echo.handle(&env, 10).unwrap();
            assert_eq!(out.last().unwrap().silent, silent);
            let got = bodies(&mut alice, out);
            let content::Body::LiveLocation(l) = got.last().unwrap() else {
                panic!("expected live location");
            };
            // One session of the bot's own, not the sender's id.
            assert_ne!(l.session_id, vec![7; 16]);
            assert_eq!(*session.get_or_insert(l.session_id.clone()), l.session_id);
            assert_eq!(l.location.as_ref().map(|p| p.latitude), lat);
            assert_eq!(l.stopped, lat.is_none());
        }
    }

    #[test]
    fn ignores_its_own_messages_and_receipts() {
        let (mut alice, mut echo, id) = setup();
        let receipt = content::Body::Receipt(Receipt {
            kind: receipt::Kind::Read.into(),
            message_ids: vec![vec![1; 16]],
        });
        let env = say(&mut alice, &id, receipt);
        assert!(echo.handle(&env, 10).unwrap().is_empty());
    }
}
