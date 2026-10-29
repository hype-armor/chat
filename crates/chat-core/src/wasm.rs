//! JavaScript bindings used by the web client's core worker.

use wasm_bindgen::prelude::*;

use crate::mls::{Conversation, Device, Received};

fn js_err(e: crate::Error) -> JsError {
    JsError::new(&e.to_string())
}

#[wasm_bindgen]
pub fn core_version() -> String {
    env!("CARGO_PKG_VERSION").to_owned()
}

/// Two in-memory devices create a conversation and exchange a message.
/// Proves MLS works in this browser (Phase 0 spike a).
#[wasm_bindgen]
pub fn self_test() -> Result<bool, JsError> {
    let alice = Device::new(b"alice").map_err(js_err)?;
    let bob = Device::new(b"bob").map_err(js_err)?;
    let mut a = Conversation::create(&alice).map_err(js_err)?;
    let change = a
        .add_members(&alice, &[&bob.key_package().map_err(js_err)?])
        .map_err(js_err)?;
    let mut b = Conversation::join(&bob, &change.welcome).map_err(js_err)?;
    let ct = a.encrypt(&alice, b"ping").map_err(js_err)?;
    Ok(b.receive(&bob, &ct).map_err(js_err)? == Received::Application(b"ping".to_vec()))
}

/// Builds an N-member group so JavaScript can time membership commits
/// (NFR-PERF-5: < 200 ms for 50 members on a mid-range phone).
#[wasm_bindgen]
pub struct GroupBench {
    creator: Device,
    conv: Conversation,
}

#[wasm_bindgen]
impl GroupBench {
    #[wasm_bindgen(constructor)]
    pub fn new(members: u32) -> Result<GroupBench, JsError> {
        let creator = Device::new(b"creator").map_err(js_err)?;
        let others = (1..members.max(1))
            .map(|i| Device::new(format!("m{i}").as_bytes()))
            .collect::<crate::Result<Vec<_>>>()
            .map_err(js_err)?;
        let kps = others
            .iter()
            .map(Device::key_package)
            .collect::<crate::Result<Vec<_>>>()
            .map_err(js_err)?;
        let refs: Vec<&[u8]> = kps.iter().map(Vec::as_slice).collect();
        let mut conv = Conversation::create(&creator).map_err(js_err)?;
        if !refs.is_empty() {
            conv.add_members(&creator, &refs).map_err(js_err)?;
        }
        Ok(GroupBench { creator, conv })
    }

    #[wasm_bindgen(js_name = memberCount)]
    pub fn member_count(&self) -> u32 {
        self.conv.member_count() as u32
    }

    /// Creates and applies one self-update commit; returns its size in bytes.
    #[wasm_bindgen(js_name = commitUpdate)]
    pub fn commit_update(&mut self) -> Result<u32, JsError> {
        Ok(self.conv.self_update(&self.creator).map_err(js_err)?.len() as u32)
    }
}
