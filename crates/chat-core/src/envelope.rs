//! Seals MLS messages into protocol [`Envelope`]s and opens them again.

use chat_proto::{
    PROTOCOL_VERSION,
    v1::{ContentType, Envelope},
};
use prost::Message;

use crate::{
    Error, Result,
    mls::{Conversation, Device, Received},
    padding,
};

/// Pads and encrypts `payload` for the conversation.
pub fn seal(
    conv: &mut Conversation,
    device: &Device,
    payload: &[u8],
    message_id: Vec<u8>,
) -> Result<Envelope> {
    let epoch = conv.epoch();
    Ok(Envelope {
        version: PROTOCOL_VERSION,
        conversation_id: conv.id(),
        epoch,
        content_type: ContentType::Application.into(),
        ciphertext: conv.encrypt(device, &padding::pad(payload))?,
        message_id,
    })
}

/// Decrypts an envelope. Application payloads come back unpadded.
pub fn open(conv: &mut Conversation, device: &Device, envelope: &Envelope) -> Result<Received> {
    if envelope.version != PROTOCOL_VERSION {
        return Err(Error::Malformed("unsupported protocol version"));
    }
    if envelope.conversation_id != conv.id() {
        return Err(Error::Malformed("envelope is for another conversation"));
    }
    match conv.receive(device, &envelope.ciphertext)? {
        Received::Application(padded) => {
            Ok(Received::Application(padding::unpad(&padded)?.to_vec()))
        }
        other => Ok(other),
    }
}

pub fn encode(envelope: &Envelope) -> Vec<u8> {
    envelope.encode_to_vec()
}

pub fn decode(bytes: &[u8]) -> Result<Envelope> {
    Ok(Envelope::decode(bytes)?)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn seal_encode_decode_open() {
        let alice = Device::new(b"alice").unwrap();
        let bob = Device::new(b"bob").unwrap();
        let mut a = Conversation::create(&alice).unwrap();
        let change = a
            .add_members(&alice, &[&bob.key_package().unwrap()])
            .unwrap();
        let mut b = Conversation::join(&bob, &change.welcome).unwrap();

        let env = seal(&mut a, &alice, b"padded hello", vec![1, 2, 3]).unwrap();
        assert!(
            env.ciphertext.len() > 256,
            "ciphertext should cover the padding bucket"
        );
        let wire = encode(&env);
        let opened = open(&mut b, &bob, &decode(&wire).unwrap()).unwrap();
        assert_eq!(opened, Received::Application(b"padded hello".to_vec()));
    }

    #[test]
    fn rejects_wrong_version_and_conversation() {
        let alice = Device::new(b"alice").unwrap();
        let mut a = Conversation::create(&alice).unwrap();
        let mut env = seal(&mut a, &alice, b"x", vec![]).unwrap();
        env.version = 99;
        assert!(open(&mut a, &alice, &env).is_err());
        env.version = PROTOCOL_VERSION;
        env.conversation_id = b"other".to_vec();
        assert!(open(&mut a, &alice, &env).is_err());
    }
}
