//! Echo test bot (development and testing only). A real client with its own
//! account and device keys: it decrypts what members send and sends the
//! same back, so one person can try every feature end to end. The server
//! sees only ciphertext, as with anyone else.
//!
//! What comes back:
//! - text, attachments (the same blob and key: no re-upload) and shared
//!   locations, as they arrived;
//! - live location: a session of its own that mirrors the sender's point;
//! - a read receipt for each echoed message;
//! - calls: it answers and sends your audio and video back (`media`), one
//!   call at a time; others get "busy".

pub mod media;

use std::collections::HashMap;

use chat_core::{
    call::CallKeys,
    client::{Client, Event},
};
use chat_proto::v1::{
    Call, Content, Envelope, LiveLocation, Profile, Receipt, call, content, receipt,
};

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

/// What the media side should do about a call.
pub enum CallCommand {
    /// Answer `offer` (SDP); frames are re-encrypted with `keys`.
    Start {
        call_id: Vec<u8>,
        offer: String,
        keys: CallKeys,
    },
    /// A trickled ICE candidate (`RTCIceCandidateInit` JSON).
    Candidate {
        call_id: Vec<u8>,
        candidate: String,
    },
    Stop {
        call_id: Vec<u8>,
    },
}

/// The call being echoed.
struct ActiveCall {
    id: Vec<u8>,
    conversation_id: Vec<u8>,
    /// The caller's device (16 bytes).
    peer_device: Vec<u8>,
}

/// Offers older than this (sender's clock) are not answered.
const STALE_OFFER_MS: u64 = 120_000;

pub struct Echo {
    client: Client,
    name: String,
    /// Sender identity ‖ their live session id → our mirroring session id.
    live: HashMap<Vec<u8>, Vec<u8>>,
    call: Option<ActiveCall>,
    commands: Vec<CallCommand>,
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
            call: None,
            commands: Vec::new(),
        }
    }

    pub fn client(&self) -> &Client {
        &self.client
    }

    pub fn client_mut(&mut self) -> &mut Client {
        &mut self.client
    }

    /// What the media side should do since the last call.
    pub fn take_call_commands(&mut self) -> Vec<CallCommand> {
        std::mem::take(&mut self.commands)
    }

    /// The answer for the call being echoed, once the media side has it.
    pub fn answer(
        &mut self,
        call_id: &[u8],
        sdp: String,
        now_ms: u64,
    ) -> chat_core::Result<Option<Outgoing>> {
        let Some(active) = self.call.as_ref().filter(|c| c.id == call_id) else {
            return Ok(None);
        };
        let (conversation_id, to_device) =
            (active.conversation_id.clone(), active.peer_device.clone());
        let body = call_body(call_id, call::Kind::Answer, sdp, to_device);
        Ok(Some(self.send(&conversation_id, body, now_ms, true)?))
    }

    /// The media side ended the call (no media, or too long): hang up.
    pub fn hang_up(&mut self, call_id: &[u8], now_ms: u64) -> chat_core::Result<Option<Outgoing>> {
        let Some(active) = self.call.take_if(|c| c.id == call_id) else {
            return Ok(None);
        };
        let body = call_body(call_id, call::Kind::Hangup, String::new(), Vec::new());
        Ok(Some(self.send(
            &active.conversation_id,
            body,
            now_ms,
            true,
        )?))
    }

    /// A call signal from someone (not ourselves).
    fn on_call(
        &mut self,
        conversation_id: &[u8],
        sender: &[u8],
        sent_at_ms: u64,
        c: Call,
        now_ms: u64,
    ) -> chat_core::Result<Vec<Outgoing>> {
        let device = sender.get(16..32).unwrap_or_default().to_vec();
        let for_us = c.to_device.is_empty() || c.to_device == self.client.identity()[16..];
        let ours = |a: &Option<ActiveCall>| a.as_ref().is_some_and(|a| a.id == c.call_id);
        match c.kind() {
            call::Kind::Offer => {
                if now_ms.saturating_sub(sent_at_ms) > STALE_OFFER_MS || c.sdp.is_empty() {
                    return Ok(Vec::new());
                }
                if self.call.is_some() {
                    // One call at a time; tell only the calling device.
                    let body =
                        call_body(&c.call_id, call::Kind::Busy, String::new(), device.clone());
                    let mut out = self.send(conversation_id, body, now_ms, true)?;
                    out.recipients = vec![device];
                    return Ok(vec![out]);
                }
                let mut keys = CallKeys::new();
                self.client
                    .install_call_keys(conversation_id, &c.call_id, &mut keys)?;
                self.call = Some(ActiveCall {
                    id: c.call_id.clone(),
                    conversation_id: conversation_id.to_vec(),
                    peer_device: device,
                });
                self.commands.push(CallCommand::Start {
                    call_id: c.call_id,
                    offer: c.sdp,
                    keys,
                });
            }
            call::Kind::Candidate if for_us && ours(&self.call) => {
                self.commands.push(CallCommand::Candidate {
                    call_id: c.call_id,
                    candidate: c.candidate,
                })
            }
            call::Kind::Hangup if ours(&self.call) => {
                self.call = None;
                self.commands.push(CallCommand::Stop { call_id: c.call_id });
            }
            _ => {}
        }
        Ok(Vec::new())
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
                if let content::Body::Call(c) = body {
                    return self.on_call(&conversation_id, &sender, content.sent_at_ms, c, now_ms);
                }
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

    pub fn send(
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

fn call_body(call_id: &[u8], kind: call::Kind, sdp: String, to_device: Vec<u8>) -> content::Body {
    content::Body::Call(Call {
        call_id: call_id.to_vec(),
        kind: kind.into(),
        sdp,
        to_device,
        ..Call::default()
    })
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

    fn signal(kind: call::Kind, id: u8, sdp: &str) -> content::Body {
        content::Body::Call(Call {
            call_id: vec![id; 16],
            kind: kind.into(),
            sdp: sdp.into(),
            ..Call::default()
        })
    }

    #[test]
    fn answers_one_call_at_a_time_and_hangs_up() {
        let (mut alice, mut echo, id) = setup();
        // Sent "now" by Alice's clock (say() stamps 5 ms).
        let offer = say(&mut alice, &id, signal(call::Kind::Offer, 1, "v=0 offer"));
        assert!(echo.handle(&offer, 10).unwrap().is_empty());
        let commands = echo.take_call_commands();
        assert!(
            matches!(&commands[..], [CallCommand::Start { offer, .. }] if offer == "v=0 offer")
        );

        // The media side's answer goes to Alice's calling device.
        let answer = echo
            .answer(&[1; 16], "v=0 answer".into(), 20)
            .unwrap()
            .unwrap();
        let got = bodies(&mut alice, vec![answer]);
        assert!(matches!(
            &got[0],
            content::Body::Call(c) if c.kind() == call::Kind::Answer && c.sdp == "v=0 answer" && c.to_device == vec![1u8; 16]
        ));

        // A second call while busy: "busy", to the caller's device only.
        let second = say(&mut alice, &id, signal(call::Kind::Offer, 2, "v=0"));
        let out = echo.handle(&second, 30).unwrap();
        assert_eq!(out[0].recipients, vec![vec![1u8; 16]]);
        assert!(
            matches!(&bodies(&mut alice, out)[0], content::Body::Call(c) if c.kind() == call::Kind::Busy)
        );

        let hangup = say(&mut alice, &id, signal(call::Kind::Hangup, 1, ""));
        echo.handle(&hangup, 40).unwrap();
        assert!(matches!(
            &echo.take_call_commands()[..],
            [CallCommand::Stop { .. }]
        ));
        // Ended: nothing left to hang up or answer.
        assert!(echo.hang_up(&[1; 16], 50).unwrap().is_none());
        assert!(echo.answer(&[1; 16], "late".into(), 50).unwrap().is_none());
    }

    #[test]
    fn stale_offers_are_not_answered() {
        let (mut alice, mut echo, id) = setup();
        let offer = say(&mut alice, &id, signal(call::Kind::Offer, 1, "v=0"));
        echo.handle(&offer, 10 * 60_000).unwrap();
        assert!(echo.take_call_commands().is_empty());
    }
}
