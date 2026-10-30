//! The echo bot's side of a call (ADR-0030): a WebRTC peer (str0m) that
//! sends each received frame straight back. Frames arrive SFrame-encrypted
//! under the caller's key; the bot decrypts them and encrypts them again
//! under its own, as any participant would, since browsers accept no frame
//! back under their own key ID.

use std::{
    net::{IpAddr, SocketAddr},
    time::{Duration, Instant},
};

use chat_core::call::CallKeys;
use str0m::{
    Candidate, Event, IceConnectionState, Input, Output, Rtc, RtcConfig,
    change::SdpOffer,
    media::{MediaData, MediaKind},
    net::{Protocol, Receive},
};
use tokio::{net::UdpSocket, sync::mpsc};

/// A call ends by itself after this long.
pub const MAX_CALL: Duration = Duration::from_secs(10 * 60);
/// No media connection this soon after answering: give up.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(30);

/// What the media task tells the bot.
#[derive(Debug)]
pub enum MediaEvent {
    Answer { call_id: Vec<u8>, sdp: String },
    Ended { call_id: Vec<u8> },
}

/// Commands for a running call.
#[derive(Debug)]
pub enum MediaCommand {
    Candidate(String),
    Stop,
}

/// Installs str0m's crypto provider (once per process).
pub fn init() {
    str0m::crypto::from_feature_flags().install_process_default();
}

/// Leading bytes left readable by the sender (see web/src/core/media.ts):
/// VP8's payload header, 10 bytes on key frames (bit 0 of the first byte
/// clear) and 3 otherwise; nothing for audio.
pub fn clear_bytes(kind: MediaKind, frame: &[u8]) -> usize {
    match kind {
        MediaKind::Audio => 0,
        MediaKind::Video => {
            let key = frame.first().is_some_and(|b| b & 1 == 0);
            frame.len().min(if key { 10 } else { 3 })
        }
    }
}

/// Decrypts a frame from the caller and encrypts it under our own key.
pub fn reflect(keys: &mut CallKeys, kind: MediaKind, frame: &[u8]) -> Option<Vec<u8>> {
    let clear = clear_bytes(kind, frame);
    let plain = keys.decrypt(frame, clear).ok()?;
    keys.encrypt(&plain, clear).ok()
}

/// The address to offer as our host candidate: `ECHO_CALL_IP`, or the
/// address of the default route (browsers ignore loopback candidates).
pub fn host_ip() -> IpAddr {
    if let Some(ip) = std::env::var("ECHO_CALL_IP")
        .ok()
        .and_then(|v| v.parse().ok())
    {
        return ip;
    }
    let probe = std::net::UdpSocket::bind("0.0.0.0:0").and_then(|s| {
        // No packet is sent: connecting a UDP socket only picks a route.
        s.connect("192.0.2.1:9")?;
        s.local_addr()
    });
    probe
        .map(|a| a.ip())
        .unwrap_or(IpAddr::from([127, 0, 0, 1]))
}

/// Runs one call until it ends; sends the answer, then echoes media.
pub async fn run_call(
    call_id: Vec<u8>,
    offer: String,
    mut keys: CallKeys,
    host: IpAddr,
    mut commands: mpsc::Receiver<MediaCommand>,
    events: mpsc::UnboundedSender<MediaEvent>,
) {
    if let Err(e) = echo(&call_id, offer, &mut keys, host, &mut commands, &events).await {
        tracing::warn!("call ended: {e:#}");
    }
    let _ = events.send(MediaEvent::Ended { call_id });
}

async fn echo(
    call_id: &[u8],
    offer: String,
    keys: &mut CallKeys,
    host: IpAddr,
    commands: &mut mpsc::Receiver<MediaCommand>,
    events: &mpsc::UnboundedSender<MediaEvent>,
) -> anyhow::Result<()> {
    let socket = UdpSocket::bind(SocketAddr::new(host, 0)).await?;
    let local = socket.local_addr()?;
    let mut rtc: Rtc = RtcConfig::new().build(Instant::now());
    rtc.add_local_candidate(Candidate::host(local, "udp")?);
    let answer = rtc
        .sdp_api()
        .accept_offer(SdpOffer::from_sdp_string(&offer)?)?;
    events.send(MediaEvent::Answer {
        call_id: call_id.to_vec(),
        sdp: answer.to_sdp_string(),
    })?;
    tracing::info!(%local, "answered a call");

    let started = Instant::now();
    let mut connected = false;
    let mut buf = vec![0u8; 2000];
    loop {
        // Everything str0m wants to do now, up to its next deadline.
        let deadline = loop {
            match rtc.poll_output()? {
                Output::Timeout(t) => break t,
                Output::Transmit(t) => {
                    socket.send_to(&t.contents, t.destination).await?;
                }
                Output::Event(event) => match event {
                    Event::Connected => connected = true,
                    Event::IceConnectionStateChange(IceConnectionState::Disconnected) => {
                        return Ok(());
                    }
                    Event::MediaData(data) => send_back(&mut rtc, keys, data),
                    Event::KeyframeRequest(req) => {
                        // The caller's decoder wants a key frame: ask the caller's encoder.
                        if let Some(mut writer) = rtc.writer(req.mid) {
                            let _ = writer.request_keyframe(req.rid, req.kind);
                        }
                    }
                    _ => {}
                },
            }
        };
        let now = Instant::now();
        if now - started > MAX_CALL || (!connected && now - started > CONNECT_TIMEOUT) {
            return Ok(());
        }
        let wait = deadline
            .saturating_duration_since(now)
            .min(Duration::from_millis(100));
        tokio::select! {
            received = socket.recv_from(&mut buf) => {
                let (n, source) = received?;
                if let Ok(contents) = buf[..n].try_into() {
                    rtc.handle_input(Input::Receive(
                        Instant::now(),
                        Receive { proto: Protocol::Udp, source, destination: local, contents },
                    ))?;
                }
            }
            command = commands.recv() => match command {
                Some(MediaCommand::Candidate(json)) => {
                    if let Some(c) = parse_candidate(&json) {
                        rtc.add_remote_candidate(c);
                    }
                }
                Some(MediaCommand::Stop) | None => return Ok(()),
            },
            _ = tokio::time::sleep(wait) => rtc.handle_input(Input::Timeout(Instant::now()))?,
        }
    }
}

fn send_back(rtc: &mut Rtc, keys: &mut CallKeys, data: MediaData) {
    let Some(kind) = rtc.media(data.mid).map(|m| m.kind()) else {
        return;
    };
    let Some(frame) = reflect(keys, kind, &data.data) else {
        return;
    };
    if let Some(writer) = rtc.writer(data.mid)
        && let Err(e) = writer.write(data.pt, data.network_time, data.time, frame)
    {
        tracing::debug!("echoing a frame failed: {e}");
    }
}

/// The `candidate` line of an `RTCIceCandidateInit` (JSON).
fn parse_candidate(json: &str) -> Option<Candidate> {
    let init: serde_json::Value = serde_json::from_str(json).ok()?;
    let line = init.get("candidate")?.as_str()?;
    if line.is_empty() {
        return None;
    }
    Candidate::from_sdp_string(line).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn video_keeps_the_vp8_header_clear() {
        assert_eq!(clear_bytes(MediaKind::Audio, &[0; 50]), 0);
        // Bit 0 clear: a key frame.
        assert_eq!(clear_bytes(MediaKind::Video, &[0x10; 50]), 10);
        assert_eq!(clear_bytes(MediaKind::Video, &[0x11; 50]), 3);
        assert_eq!(clear_bytes(MediaKind::Video, &[0x10; 4]), 4);
    }

    #[test]
    fn frames_come_back_under_the_bots_key() {
        let base = [5u8; 32];
        let (mut caller, mut bot) = (CallKeys::new(), CallKeys::new());
        caller.install(&base, 1, 0, &[1]).unwrap();
        bot.install(&base, 1, 1, &[0]).unwrap();
        let frame = [0x10u8; 40];
        let sent = caller.encrypt(&frame, 10).unwrap();
        let back = reflect(&mut bot, MediaKind::Video, &sent).unwrap();
        assert_ne!(back, sent);
        assert_eq!(caller.decrypt(&back, 10).unwrap(), frame);
        // Garbage is dropped, not echoed.
        assert!(reflect(&mut bot, MediaKind::Audio, b"not sframe").is_none());
    }

    #[test]
    fn candidates_parse_from_browser_json() {
        let json = r#"{"candidate":"candidate:1 1 udp 2113929471 203.0.113.100 10100 typ host","sdpMid":"0"}"#;
        assert!(parse_candidate(json).is_some());
        assert!(parse_candidate(r#"{"candidate":""}"#).is_none());
    }
}
