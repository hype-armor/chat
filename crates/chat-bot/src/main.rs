use std::{
    collections::{BTreeMap, BTreeSet, HashMap},
    path::PathBuf,
    time::Duration,
};

use aes_gcm::{
    Aes256Gcm, Key, Nonce,
    aead::{Aead, AeadCore, KeyInit, OsRng},
};
use anyhow::{Context, Result, bail};
use base64::{Engine as _, engine::general_purpose::STANDARD};
use chat_core::{
    client::{Client, Event as CoreEvent},
    mls::{JoinPackage, PendingDevice},
};
use chat_proto::v1::{
    Ack, Authenticate, ClientFrame, Content, Envelope, SendEnvelope, ServerFrame, client_frame,
    content, server_frame,
};
use futures_util::{SinkExt, StreamExt};
use prost::Message;
use rand::Rng;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt, BufReader},
    sync::mpsc,
    time::timeout,
};
use tokio_tungstenite::{connect_async, tungstenite::Message as WsMessage};
use uuid::Uuid;

const MAX_LINE: usize = 64 * 1024;
const MAX_EVENTS: usize = 256;
const MAX_JOURNAL: usize = 4096;
const MAX_SEEN_PER_BOT: usize = 65_536;
const KEY_PACKAGE_TARGET: usize = 20;
const NETWORK_TIMEOUT: Duration = Duration::from_secs(20);

enum SessionCommand {
    Frame(ClientFrame),
}
type WsTx = mpsc::Sender<SessionCommand>;
type FrameTx = mpsc::Sender<(String, ServerFrame)>;

#[derive(Clone, Serialize, Deserialize)]
struct Account {
    account_id: Uuid,
    device_id: Uuid,
    token: String,
    username: String,
    #[serde(default)]
    display_name: String,
    snapshot: Vec<u8>,
}
#[derive(Clone, Serialize, Deserialize)]
struct Outbox {
    bot_id: String,
    conversation_id: Vec<u8>,
    membership_key: String,
    envelope: Vec<u8>,
    recipients: Vec<Vec<u8>>,
    accepted: bool,
}
#[derive(Serialize, Deserialize, Default)]
struct Store {
    server: Option<String>,
    accounts: BTreeMap<String, Account>,
    fixtures: BTreeMap<String, Vec<u8>>,
    create_labels: BTreeMap<String, String>,
    create_names: BTreeMap<String, String>,
    blocked: BTreeSet<String>,
    epochs: BTreeMap<String, u64>,
    outbox: BTreeMap<String, Outbox>,
    unacked: Vec<Value>,
    seen: BTreeSet<String>,
}
#[derive(Deserialize)]
struct Command {
    id: Value,
    op: String,
    #[serde(flatten)]
    args: Value,
}
struct Lock(std::fs::File);
#[cfg(unix)]
impl Drop for Lock {
    fn drop(&mut self) {
        use std::os::fd::AsRawFd;
        unsafe {
            libc::flock(self.0.as_raw_fd(), libc::LOCK_UN);
        }
    }
}

struct App {
    dir: PathBuf,
    server: String,
    key: [u8; 32],
    http: reqwest::Client,
    store: Store,
    sessions: HashMap<String, WsTx>,
    connected: BTreeSet<String>,
    request_to_operation: HashMap<u64, String>,
    next_request: u64,
    event_tx: FrameTx,
    pending_events: Vec<Value>,
    fatal: bool,
    _lock: Lock,
}

impl App {
    async fn open(event_tx: FrameTx) -> Result<Self> {
        let dir = PathBuf::from(
            std::env::var("CHAT_BOT_STATE_DIR").unwrap_or_else(|_| "./chat-bot-state".into()),
        );
        let existed = dir.exists();
        tokio::fs::create_dir_all(&dir).await?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            if existed {
                if tokio::fs::metadata(&dir).await?.permissions().mode() & 0o077 != 0 {
                    bail!("state directory permissions are not private");
                }
            } else {
                tokio::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700)).await?;
            }
        }
        let lock_file = std::fs::OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .open(dir.join(".lock"))?;
        #[cfg(unix)]
        {
            use std::os::fd::AsRawFd;
            if unsafe { libc::flock(lock_file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 {
                bail!("state lock unavailable");
            }
            use std::os::unix::fs::PermissionsExt;
            tokio::fs::set_permissions(dir.join(".lock"), std::fs::Permissions::from_mode(0o600))
                .await?;
        }
        let bytes =
            STANDARD.decode(std::env::var("CHAT_BOT_STATE_KEY").context("missing state key")?)?;
        let key: [u8; 32] = bytes
            .try_into()
            .map_err(|_| anyhow::anyhow!("invalid state key length"))?;
        let server = std::env::var("CHAT_BOT_SERVER")
            .unwrap_or_else(|_| "http://127.0.0.1:8080".into())
            .trim_end_matches('/')
            .to_owned();
        let url = reqwest::Url::parse(&server)?;
        if (url.scheme() != "https"
            && !(url.scheme() == "http"
                && matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "::1"))))
            || !url.username().is_empty()
            || url.password().is_some()
            || url.query().is_some()
            || url.fragment().is_some()
        {
            bail!("insecure server URL");
        }
        let http = reqwest::Client::builder()
            .timeout(NETWORK_TIMEOUT)
            .redirect(reqwest::redirect::Policy::none())
            .build()?;
        let mut app = Self {
            dir,
            server: server.clone(),
            key,
            http,
            store: Store::default(),
            sessions: HashMap::new(),
            connected: BTreeSet::new(),
            request_to_operation: HashMap::new(),
            next_request: 10,
            event_tx,
            pending_events: Vec::new(),
            fatal: false,
            _lock: Lock(lock_file),
        };
        let path = app.dir.join("state.enc");
        if tokio::fs::try_exists(&path).await? {
            app.store = serde_json::from_slice(&decrypt(&app.key, &tokio::fs::read(path).await?)?)?;
            if app
                .store
                .server
                .as_deref()
                .is_some_and(|saved| saved != server)
            {
                bail!("state belongs to another server");
            }
            app.store.server = Some(server.clone());
            for acct in app.store.accounts.values() {
                Client::restore(&acct.snapshot).context("invalid core snapshot")?;
            }
            for (id, out) in &app.store.outbox {
                Envelope::decode(out.envelope.as_slice())
                    .with_context(|| format!("invalid outbox {id}"))?;
            }
            if app.store.unacked.len() > MAX_EVENTS {
                bail!("too many unacknowledged events");
            }
        } else {
            app.store.server = Some(server.clone());
        }
        Ok(app)
    }
    async fn persist(&self) -> Result<()> {
        let data = encrypt(&self.key, &serde_json::to_vec(&self.store)?)?;
        let tmp = self.dir.join(format!(".state-{}.tmp", Uuid::new_v4()));
        let mut opts = tokio::fs::OpenOptions::new();
        opts.create_new(true).write(true);
        #[cfg(unix)]
        opts.mode(0o600);
        let mut file = opts.open(&tmp).await?;
        file.write_all(&data).await?;
        file.sync_all().await?;
        drop(file);
        tokio::fs::rename(&tmp, self.dir.join("state.enc")).await?;
        tokio::fs::File::open(&self.dir).await?.sync_all().await?;
        Ok(())
    }
    fn enabled() -> bool {
        std::env::var("CHAT_BOTS_ENABLED").is_ok_and(|s| s == "true")
    }
    fn arg<'a>(v: &'a Value, k: &str) -> Option<&'a str> {
        v.get(k)?.as_str()
    }
    async fn command(&mut self, c: Command) -> Value {
        let id = c.id;
        let r = match c.op.as_str() {
            "status" => Ok(self.status()),
            "register" => self.register(&c.args).await,
            "connect" => self.connect(&c.args).await,
            "create" => self.create(&c.args).await,
            "members" => self.members(&c.args).await,
            "send" => self.send(&c.args).await,
            "ackEvent" => self.ack_event(&c.args).await,
            _ => Err("invalid_command"),
        };
        match r {
            Ok(v) => json!({"id":id,"ok":true,"result":v}),
            Err(e) => json!({"id":id,"ok":false,"error":e}),
        }
    }
    fn status(&self) -> Value {
        let accounts: Vec<_> = self.store.accounts.iter().map(|(bot,a)| json!({"botId":bot,"accountId":a.account_id,"deviceId":a.device_id,"username":a.username})).collect();
        let fixtures: Vec<_> = self
            .store
            .fixtures
            .iter()
            .map(|(k, v)| json!({"key":k,"conversationId":STANDARD.encode(v)}))
            .collect();
        json!({"accounts":accounts,"fixtures":fixtures,"connected":self.connected})
    }
    async fn register(&mut self, args: &Value) -> std::result::Result<Value, &'static str> {
        if !Self::enabled() {
            return Err("disabled");
        }
        let bot = Self::arg(args, "botId")
            .filter(|s| !s.is_empty() && s.len() <= 80)
            .ok_or("invalid_command")?;
        if let Some(a) = self.store.accounts.get(bot) {
            return Ok(
                json!({"accountId":a.account_id,"deviceId":a.device_id,"username":a.username}),
            );
        }
        let username = Self::arg(args, "username").ok_or("invalid_command")?;
        if !username.to_lowercase().contains("bot") {
            return Err("bot_label_required");
        }
        let pending = PendingDevice::generate().map_err(|_| "crypto_error")?;
        let mut body =
            json!({"username":username,"identity_key":STANDARD.encode(pending.public_key())});
        if let Some(inv) = Self::arg(args, "invite") {
            body["invite"] = json!(inv);
        }
        let res = timeout(
            NETWORK_TIMEOUT,
            self.http
                .post(format!("{}/v1/register", self.server))
                .json(&body)
                .send(),
        )
        .await
        .map_err(|_| "network_error")?
        .map_err(|_| "network_error")?;
        if res.status() == reqwest::StatusCode::UNAUTHORIZED {
            return Err("auth_error");
        }
        if !res.status().is_success() {
            return Err("registration_error");
        }
        #[derive(Deserialize)]
        struct Reg {
            account_id: Uuid,
            device_id: Uuid,
            token: String,
            username: String,
        }
        let r: Reg = res.json().await.map_err(|_| "protocol_error")?;
        let identity = [r.account_id.as_bytes().as_slice(), r.device_id.as_bytes()].concat();
        let client = Client::new(pending.into_device(&identity).map_err(|_| "crypto_error")?);
        let packages = client
            .key_packages(KEY_PACKAGE_TARGET)
            .map_err(|_| "crypto_error")?;
        let account = Account {
            account_id: r.account_id,
            device_id: r.device_id,
            token: r.token,
            username: r.username,
            display_name: Self::arg(args, "displayName")
                .filter(|s| s.to_lowercase().contains("ai bot"))
                .map(str::to_owned)
                .unwrap_or_else(|| format!("AI bot {bot}")),
            snapshot: client.snapshot().map_err(|_| "crypto_error")?,
        };
        self.store.accounts.insert(bot.into(), account.clone());
        self.persist().await.map_err(|_| "storage_error")?;
        let texts: Vec<_> = packages.iter().map(|p| STANDARD.encode(p)).collect();
        let upload = timeout(
            NETWORK_TIMEOUT,
            self.http
                .post(format!("{}/v1/keys", self.server))
                .bearer_auth(&account.token)
                .json(&json!({"key_packages":texts}))
                .send(),
        )
        .await
        .map_err(|_| "network_error")?
        .map_err(|_| "network_error")?;
        if upload.status() == reqwest::StatusCode::UNAUTHORIZED {
            return Err("auth_error");
        }
        if !upload.status().is_success() {
            return Err("network_error");
        }
        Ok(
            json!({"accountId":account.account_id,"deviceId":account.device_id,"username":account.username}),
        )
    }
    async fn connect(&mut self, args: &Value) -> std::result::Result<Value, &'static str> {
        if !Self::enabled() {
            return Err("disabled");
        }
        let bot = Self::arg(args, "botId").ok_or("invalid_command")?;
        let account = self.store.accounts.get(bot).cloned().ok_or("unknown_bot")?;
        if self.sessions.contains_key(bot) {
            return Ok(json!({"connecting":true}));
        }
        let (tx, rx) = mpsc::channel(128);
        self.sessions.insert(bot.to_owned(), tx);
        spawn_ws(
            bot.to_owned(),
            account.token,
            ws_url(&self.server),
            rx,
            self.event_tx.clone(),
        );
        Ok(json!({"connecting":true}))
    }
    async fn create(&mut self, args: &Value) -> std::result::Result<Value, &'static str> {
        if !Self::enabled() {
            return Err("disabled");
        }
        let bot = Self::arg(args, "botId").ok_or("invalid_command")?;
        let fixture = Self::arg(args, "fixtureConversationId").ok_or("invalid_command")?;
        let name = Self::arg(args, "name").ok_or("invalid_command")?;
        let display_name = self
            .store
            .accounts
            .get(bot)
            .map(|a| a.display_name.clone())
            .unwrap_or_else(|| format!("AI bot {bot}"));
        if !display_name.to_lowercase().contains("ai bot") {
            return Err("bot_label_required");
        }
        let other = args
            .get("memberBotIds")
            .and_then(Value::as_array)
            .filter(|a| !a.is_empty() && a.len() <= 49)
            .ok_or("invalid_command")?;
        let map_key = format!("{bot}:{fixture}");
        if let Some(id) = self.store.fixtures.get(&map_key).cloned() {
            let op = format!("create:{bot}:{fixture}");
            let accepted = self.store.outbox.get(&op).is_some_and(|o| o.accepted);
            if accepted {
                self.resume_bootstrap(bot).await?;
            } else {
                self.queue_outbox(&op)?;
            }
            return Ok(
                json!({"conversationId":STANDARD.encode(id),"name":name,"accepted":accepted}),
            );
        }
        if !self.connected.contains(bot) {
            return Err("not_connected");
        }
        if self.store.outbox.len() >= MAX_JOURNAL {
            return Err("state_capacity_operator_rollover_required");
        }
        let account = self.store.accounts.get(bot).cloned().ok_or("unknown_bot")?;
        let mut client = Client::restore(&account.snapshot).map_err(|_| "crypto_error")?;
        let mut target_ids = Vec::new();
        let mut identities = Vec::new();
        for item in other {
            let member = item.as_str().ok_or("invalid_command")?;
            if member == bot {
                return Err("invalid_command");
            }
            let peer = self.store.accounts.get(member).ok_or("unknown_bot")?;
            target_ids.push(peer.device_id);
            identities.push((member.to_owned(), peer.account_id, peer.device_id));
        }
        if identities
            .iter()
            .map(|x| x.2)
            .collect::<BTreeSet<_>>()
            .len()
            != identities.len()
        {
            return Err("invalid_command");
        }
        let claim = timeout(
            NETWORK_TIMEOUT,
            self.http
                .post(format!("{}/v1/keys/claim", self.server))
                .bearer_auth(&account.token)
                .json(&json!({"device_ids":target_ids}))
                .send(),
        )
        .await
        .map_err(|_| "network_error")?
        .map_err(|_| "network_error")?;
        if claim.status() == reqwest::StatusCode::UNAUTHORIZED {
            return Err("auth_error");
        }
        if !claim.status().is_success() {
            return Err("network_error");
        }
        #[derive(Deserialize)]
        struct Claimed {
            key_packages: HashMap<Uuid, String>,
        }
        let claimed: Claimed = claim.json().await.map_err(|_| "protocol_error")?;
        let mut key_packages = Vec::new();
        let mut expected = Vec::new();
        for (_, aid, did) in identities {
            let kp = claimed
                .key_packages
                .get(&did)
                .ok_or("key_package_unavailable")?;
            let bytes = STANDARD.decode(kp).map_err(|_| "protocol_error")?;
            let expected_id = [aid.as_bytes().as_slice(), did.as_bytes()].concat();
            if client
                .key_package_identity(&bytes)
                .map_err(|_| "crypto_error")?
                != expected_id
            {
                return Err("key_identity_mismatch");
            }
            expected.push(expected_id);
            key_packages.push(bytes);
        }
        let joins: Vec<_> = expected
            .iter()
            .zip(&key_packages)
            .map(|(identity, kp)| JoinPackage {
                identity,
                key_package: kp,
            })
            .collect();
        let started = client
            .start_conversation(&joins, random_id())
            .map_err(|_| "crypto_error")?;
        let conv = started.conversation_id.clone();
        let convkey = STANDARD.encode(&conv);
        let epoch = client.epoch(&conv).map_err(|_| "crypto_error")?;
        let recipients: Vec<_> = expected.iter().map(|i| i[16..].to_vec()).collect();
        let out = Outbox {
            bot_id: bot.into(),
            conversation_id: conv.clone(),
            membership_key: membership_key(
                epoch,
                &client.members(&conv).map_err(|_| "crypto_error")?,
            ),
            envelope: started.welcome.encode_to_vec(),
            recipients: recipients.clone(),
            accepted: false,
        };
        self.store.fixtures.insert(map_key.clone(), conv.clone());
        self.store.create_labels.insert(
            format!("create:{bot}:{fixture}"),
            format!("AI bot · {display_name}"),
        );
        self.store
            .create_names
            .insert(format!("create:{bot}:{fixture}"), name.to_owned());
        self.store.epochs.insert(convkey.clone(), epoch);
        self.store
            .accounts
            .get_mut(bot)
            .ok_or("unknown_bot")?
            .snapshot = client.snapshot().map_err(|_| "crypto_error")?;
        let op = format!("create:{bot}:{fixture}");
        self.store.outbox.insert(op.clone(), out);
        let members = client.members(&conv).map_err(|_| "crypto_error")?;
        let epoch = client.epoch(&conv).map_err(|_| "crypto_error")?;
        let event_id = format!("created:{bot}:{fixture}");
        let joined = json!({"event":"joined","eventId":event_id,"botId":bot,"conversationId":STANDARD.encode(&conv),"members":members_json(&members),"membershipKey":membership_key(epoch,&members)});
        if !self
            .store
            .unacked
            .iter()
            .any(|e| e.get("eventId").and_then(Value::as_str) == Some(event_id.as_str()))
        {
            self.store.unacked.push(joined.clone());
            self.pending_events.push(joined);
        }
        self.persist().await.map_err(|_| {
            self.fatal = true;
            "storage_error"
        })?;
        self.queue_outbox(&op)?;
        Ok(json!({"conversationId":STANDARD.encode(conv),"name":name,"accepted":false}))
    }
    async fn members(&mut self, args: &Value) -> std::result::Result<Value, &'static str> {
        let bot = Self::arg(args, "botId").ok_or("invalid_command")?;
        let conv = STANDARD
            .decode(Self::arg(args, "conversationId").ok_or("invalid_command")?)
            .map_err(|_| "invalid_command")?;
        if !self.connected.contains(bot) {
            return Err("not_connected");
        }
        let account = self.store.accounts.get(bot).ok_or("unknown_bot")?;
        let client = Client::restore(&account.snapshot).map_err(|_| "crypto_error")?;
        if self.store.blocked.contains(&STANDARD.encode(&conv)) {
            return Err("membership_unreconciled");
        }
        let members = client.members(&conv).map_err(|_| "unknown_conversation")?;
        let epoch = client.epoch(&conv).map_err(|_| "unknown_conversation")?;
        let mut list = Vec::new();
        for m in &members {
            if m.len() != 32 {
                return Err("protocol_error");
            }
            list.push(json!({"accountId":Uuid::from_slice(&m[..16]).map_err(|_|"protocol_error")?,"deviceId":Uuid::from_slice(&m[16..]).map_err(|_|"protocol_error")?}));
        }
        Ok(json!({"members":list,"membershipKey":membership_key(epoch,&members)}))
    }
    async fn send(&mut self, args: &Value) -> std::result::Result<Value, &'static str> {
        if !Self::enabled() {
            return Err("disabled");
        }
        let op = Self::arg(args, "operationId")
            .filter(|s| !s.is_empty() && s.len() <= 128)
            .ok_or("invalid_command")?;
        let bot = Self::arg(args, "botId").ok_or("invalid_command")?;
        if !self.connected.contains(bot) {
            return Err("not_connected");
        }
        let conv = STANDARD
            .decode(Self::arg(args, "conversationId").ok_or("invalid_command")?)
            .map_err(|_| "invalid_command")?;
        let expected = Self::arg(args, "expectedMembershipKey").ok_or("invalid_command")?;
        if self.store.blocked.contains(&STANDARD.encode(&conv)) {
            return Err("membership_unreconciled");
        }
        if self.store.unacked.iter().any(|e| {
            e.get("conversationId").and_then(Value::as_str) == Some(STANDARD.encode(&conv).as_str())
        }) {
            return Err("events_pending");
        }
        let account = self.store.accounts.get(bot).cloned().ok_or("unknown_bot")?;
        let mut client = Client::restore(&account.snapshot).map_err(|_| "crypto_error")?;
        let members = client.members(&conv).map_err(|_| "unknown_conversation")?;
        let epoch = client.epoch(&conv).map_err(|_| "unknown_conversation")?;
        let current = membership_key(epoch, &members);
        if current != expected {
            return Err("membership_changed");
        }
        if !self.store.outbox.contains_key(op) && self.store.outbox.len() >= MAX_JOURNAL {
            return Err("state_capacity_operator_rollover_required");
        }
        if let Some(saved) = self.store.outbox.get(op) {
            if saved.bot_id != bot
                || saved.conversation_id != conv
                || saved.membership_key != expected
            {
                return Err("operation_conflict");
            }
            if saved.accepted {
                return Ok(json!({"accepted":true,"operationId":op}));
            }
            self.queue_outbox(op)?;
            return Ok(json!({"accepted":false,"pending":true,"operationId":op}));
        }
        if !self.store.outbox.contains_key(op) && self.store.outbox.len() >= MAX_JOURNAL {
            return Err("state_capacity_operator_rollover_required");
        }
        let text = Self::arg(args, "text").ok_or("invalid_command")?;
        if text.len() > 16_000 {
            return Err("invalid_command");
        }
        let content = Content {
            sent_at_ms: now_ms(),
            reply_to: None,
            reply_to_hash: None,
            body: Some(content::Body::Text(chat_proto::v1::Text {
                body: text.into(),
            })),
        };
        let env = client
            .send(&conv, &content, random_id())
            .map_err(|_| "crypto_error")?;
        let recipients = members
            .iter()
            .filter(|m| **m != client.identity())
            .filter_map(|m| {
                if m.len() == 32 {
                    Some(m[16..].to_vec())
                } else {
                    None
                }
            })
            .collect();
        self.store
            .accounts
            .get_mut(bot)
            .ok_or("unknown_bot")?
            .snapshot = client.snapshot().map_err(|_| "crypto_error")?;
        self.store.outbox.insert(
            op.into(),
            Outbox {
                bot_id: bot.into(),
                conversation_id: conv,
                membership_key: current,
                envelope: env.encode_to_vec(),
                recipients,
                accepted: false,
            },
        );
        self.persist().await.map_err(|_| "storage_error")?;
        self.queue_outbox(op)?;
        Ok(json!({"accepted":false,"pending":true,"operationId":op}))
    }
    fn queue_outbox(&mut self, op: &str) -> std::result::Result<(), &'static str> {
        let out = self.store.outbox.get(op).ok_or("unknown_operation")?;
        let tx = self
            .sessions
            .get(&out.bot_id)
            .cloned()
            .ok_or("not_connected")?;
        let env = Envelope::decode(out.envelope.as_slice()).map_err(|_| "storage_error")?;
        self.next_request += 1;
        let request = self.next_request;
        tx.try_send(SessionCommand::Frame(ClientFrame {
            request_id: request,
            body: Some(client_frame::Body::Send(SendEnvelope {
                envelope: Some(env),
                recipient_devices: out.recipients.clone(),
                silent: false,
                ..Default::default()
            })),
        }))
        .map_err(|_| "transport_busy")?;
        self.request_to_operation.insert(request, op.into());
        Ok(())
    }
    async fn ack_event(&mut self, args: &Value) -> std::result::Result<Value, &'static str> {
        let event_id = Self::arg(args, "eventId").ok_or("invalid_command")?;
        let pos = self
            .store
            .unacked
            .iter()
            .position(|e| e.get("eventId").and_then(Value::as_str) == Some(event_id));
        if let Some(i) = pos {
            let ev = self.store.unacked.remove(i);
            let resume_bot = ev.get("botId").and_then(Value::as_str).map(str::to_owned);
            self.persist().await.map_err(|_| {
                self.fatal = true;
                "storage_error"
            })?;
            if let (Some(bot), Some(message_id)) = (
                ev.get("botId").and_then(Value::as_str),
                ev.get("messageId").and_then(Value::as_str),
            ) {
                let msg = STANDARD.decode(message_id).map_err(|_| "protocol_error")?;
                if let Some(tx) = self.sessions.get(bot) {
                    tx.try_send(SessionCommand::Frame(ClientFrame {
                        request_id: 0,
                        body: Some(client_frame::Body::Ack(Ack { message_id: msg })),
                    }))
                    .map_err(|_| "transport_busy")?;
                }
            }
            if let Some(bot) = resume_bot
                && self.connected.contains(&bot)
            {
                self.resume_bootstrap(&bot).await?;
            }
        }
        Ok(json!({"acknowledged":true}))
    }
    async fn frame(&mut self, bot: String, frame: ServerFrame) -> Vec<Value> {
        let mut output = Vec::new();
        match frame.body {
            Some(server_frame::Body::AuthResult(auth)) => {
                if auth.key_packages < 10 {
                    let Some(account) = self.store.accounts.get(&bot).cloned() else {
                        return output;
                    };
                    let Ok(client) = Client::restore(&account.snapshot) else {
                        return output;
                    };
                    let count = KEY_PACKAGE_TARGET
                        .saturating_sub(auth.key_packages as usize)
                        .min(20);
                    let Ok(packages) = client.key_packages(count) else {
                        return output;
                    };
                    let Ok(snapshot) = client.snapshot() else {
                        return output;
                    };
                    if let Some(saved) = self.store.accounts.get_mut(&bot) {
                        saved.snapshot = snapshot;
                    } else {
                        return output;
                    }
                    if self.persist().await.is_err() {
                        self.fatal = true;
                        return output;
                    }
                    let encoded: Vec<_> = packages.iter().map(|p| STANDARD.encode(p)).collect();
                    let response = timeout(
                        NETWORK_TIMEOUT,
                        self.http
                            .post(format!("{}/v1/keys", self.server))
                            .bearer_auth(&account.token)
                            .json(&json!({"key_packages":encoded}))
                            .send(),
                    )
                    .await;
                    if !matches!(response, Ok(Ok(ref r)) if r.status().is_success()) {
                        self.connected.remove(&bot);
                        self.sessions.remove(&bot);
                        output.push(json!({"event":"disconnected","eventId":Uuid::new_v4().to_string(),"botId":bot}));
                        return output;
                    }
                }
                // AuthResult is not readiness. The socket task waits for the post-backlog Pong barrier.
            }
            Some(server_frame::Body::Pong(_)) if frame.request_id == 2 => {
                self.connected.insert(bot.clone());
                if self.resume_bootstrap(&bot).await.is_err() {
                    self.fatal = true;
                    return output;
                }
                output.push(
                    json!({"event":"connected","eventId":Uuid::new_v4().to_string(),"botId":bot}),
                );
            }
            Some(server_frame::Body::DevicesChanged(_)) => {
                self.connected.remove(&bot);
                self.sessions.remove(&bot);
                self.request_to_operation
                    .retain(|_, op| self.store.outbox.get(op).is_none_or(|o| o.bot_id != bot));
                if let Some(account) = self.store.accounts.get(&bot).cloned() {
                    if let Ok(client) = Client::restore(&account.snapshot) {
                        for id in client.conversation_ids() {
                            self.store.blocked.insert(STANDARD.encode(id));
                        }
                        if self.persist().await.is_err() {
                            self.fatal = true;
                            return output;
                        }
                    } else {
                        self.fatal = true;
                        return output;
                    }
                }
                output.push(json!({"event":"disconnected","eventId":Uuid::new_v4().to_string(),"botId":bot,"requiresConsentReset":true}));
            }
            Some(server_frame::Body::Deliver(env)) => {
                if self.store.unacked.len() >= MAX_EVENTS {
                    self.fatal = true;
                    return output;
                }
                let msg_id = STANDARD.encode(&env.message_id);
                let event_id = dedup_id(&bot, &env);
                if self.store.seen.contains(&event_id) {
                    if !self
                        .store
                        .unacked
                        .iter()
                        .any(|e| e.get("eventId").and_then(Value::as_str) == Some(&event_id))
                    {
                        self.send_ack(&bot, env.message_id);
                    }
                    return output;
                }
                let seen_prefix = format!("{bot}:");
                if self
                    .store
                    .seen
                    .iter()
                    .filter(|id| id.starts_with(&seen_prefix))
                    .count()
                    >= MAX_SEEN_PER_BOT
                {
                    self.connected.remove(&bot);
                    self.fatal = true;
                    return output;
                }
                let Some(acct) = self.store.accounts.get(&bot).cloned() else {
                    return output;
                };
                let Ok(mut client) = Client::restore(&acct.snapshot) else {
                    return output;
                };
                let mut event_data = None;
                let mut joined_profile_op = None;
                match client.receive(&env) {
                    Ok(CoreEvent::Message {
                        conversation_id,
                        sender,
                        content,
                    }) => {
                        if let Some(content::Body::Text(t)) = content.body
                            && sender.len() == 32
                        {
                            event_data = Some(
                                json!({"event":"message","conversationId":STANDARD.encode(&conversation_id),"senderAccountId":Uuid::from_slice(&sender[..16]).ok(),"senderDeviceId":Uuid::from_slice(&sender[16..]).ok(),"text":t.body,"sentAtMs":content.sent_at_ms,"messageId":event_id}),
                            );
                        }
                    }
                    Ok(CoreEvent::Joined { conversation_id }) => {
                        let epoch = match client.epoch(&conversation_id) {
                            Ok(v) => v,
                            Err(_) => {
                                self.fatal = true;
                                return output;
                            }
                        };
                        self.store
                            .epochs
                            .insert(STANDARD.encode(&conversation_id), epoch);
                        joined_profile_op = match self.prepare_joined_profile(
                            &bot,
                            &conversation_id,
                            &mut client,
                        ) {
                            Ok(op) => Some(op),
                            Err(_) => {
                                self.fatal = true;
                                return output;
                            }
                        };
                        event_data = Some(
                            json!({"event":"joined","conversationId":STANDARD.encode(&conversation_id)}),
                        );
                    }
                    Ok(CoreEvent::EpochChanged {
                        conversation_id,
                        epoch,
                    }) => {
                        self.store
                            .epochs
                            .insert(STANDARD.encode(&conversation_id), epoch);
                        let removed = !client.is_active(&conversation_id).unwrap_or(false);
                        let conv_key = STANDARD.encode(&conversation_id);
                        if removed
                            || client
                                .has_pending_proposals(&conversation_id)
                                .unwrap_or(true)
                        {
                            self.store.blocked.insert(conv_key);
                        } else {
                            self.store.blocked.remove(&conv_key);
                        }
                        event_data = Some(
                            json!({"event":if removed {"removed"} else {"membership"},"conversationId":STANDARD.encode(&conversation_id)}),
                        );
                    }
                    Ok(CoreEvent::Proposal {
                        conversation_id, ..
                    }) => {
                        self.store.blocked.insert(STANDARD.encode(&conversation_id));
                        event_data = Some(
                            json!({"event":"membership","conversationId":STANDARD.encode(&conversation_id)}),
                        );
                    }
                    Ok(CoreEvent::Ignored) => {}
                    Err(_) => return output,
                }
                let snapshot = match client.snapshot() {
                    Ok(snapshot) => snapshot,
                    Err(_) => {
                        self.fatal = true;
                        return output;
                    }
                };
                if let Some(account) = self.store.accounts.get_mut(&bot) {
                    account.snapshot = snapshot;
                } else {
                    self.fatal = true;
                    return output;
                }
                self.store.seen.insert(event_id.clone());
                if let Some(mut ev) = event_data {
                    let members = match client.members(&env.conversation_id) {
                        Ok(v) => v,
                        Err(_) => {
                            self.fatal = true;
                            return Vec::new();
                        }
                    };
                    let epoch = match client.epoch(&env.conversation_id) {
                        Ok(v) => v,
                        Err(_) => {
                            self.fatal = true;
                            return Vec::new();
                        }
                    };
                    ev["eventId"] = json!(event_id);
                    ev["botId"] = json!(bot);
                    ev["messageId"] = json!(msg_id);
                    ev["members"] = members_json(&members);
                    ev["membershipKey"] = json!(membership_key(epoch, &members));
                    ev["sentAtMs"] = ev.get("sentAtMs").cloned().unwrap_or(json!(now_ms()));
                    if !self
                        .store
                        .unacked
                        .iter()
                        .any(|e| e.get("eventId").and_then(Value::as_str) == Some(&event_id))
                    {
                        if self.store.unacked.len() >= MAX_EVENTS {
                            return output;
                        }
                        self.store.unacked.push(ev.clone());
                    }
                    if self.persist().await.is_ok() {
                        if let Some(op) = joined_profile_op
                            && self.queue_outbox(&op).is_err()
                        {
                            self.fatal = true;
                            return Vec::new();
                        }
                        output.push(ev);
                    } else {
                        self.fatal = true;
                        return Vec::new();
                    }
                } else {
                    if self.persist().await.is_ok() {
                        self.send_ack(&bot, env.message_id);
                    } else {
                        self.fatal = true;
                    }
                }
            }
            Some(server_frame::Body::SendResult(r)) => {
                if let Some(op) = self.request_to_operation.remove(&frame.request_id)
                    && r.accepted
                {
                    if let Some(o) = self.store.outbox.get_mut(&op) {
                        o.accepted = true;
                    }
                    if self.persist().await.is_err() {
                        self.fatal = true;
                        return output;
                    }
                    if self.store.create_labels.contains_key(&op)
                        && self.resume_bootstrap(&bot).await.is_err()
                    {
                        self.fatal = true;
                        return output;
                    }
                }
            }
            Some(server_frame::Body::Error(error)) => {
                self.connected.remove(&bot);
                self.request_to_operation
                    .retain(|_, op| self.store.outbox.get(op).is_none_or(|o| o.bot_id != bot));
                if error.code == 401 {
                    self.sessions.remove(&bot);
                }
                output.push(json!({"event":"disconnected","eventId":Uuid::new_v4().to_string(),"botId":bot}));
            }
            _ => {}
        }
        output
    }
    fn prepare_joined_profile(
        &mut self,
        bot: &str,
        conversation_id: &[u8],
        client: &mut Client,
    ) -> std::result::Result<String, &'static str> {
        let op = format!("joined-profile:{bot}:{}", STANDARD.encode(conversation_id));
        if self.store.outbox.contains_key(&op) {
            return Ok(op);
        }
        if self.store.outbox.len() >= MAX_JOURNAL {
            return Err("state_capacity_operator_rollover_required");
        }
        let account = self.store.accounts.get(bot).cloned().ok_or("unknown_bot")?;
        let label = if account.display_name.to_lowercase().contains("ai bot") {
            account.display_name
        } else {
            format!("AI bot {}", account.username)
        };
        let members = client
            .members(conversation_id)
            .map_err(|_| "unknown_conversation")?;
        let epoch = client
            .epoch(conversation_id)
            .map_err(|_| "unknown_conversation")?;
        let recipients = members
            .iter()
            .filter(|m| **m != client.identity())
            .filter_map(|m| {
                if m.len() == 32 {
                    Some(m[16..].to_vec())
                } else {
                    None
                }
            })
            .collect();
        let content = Content {
            sent_at_ms: now_ms(),
            reply_to: None,
            reply_to_hash: None,
            body: Some(content::Body::Profile(chat_proto::v1::Profile {
                display_name: label,
                avatar: Vec::new(),
            })),
        };
        let envelope = client
            .send(conversation_id, &content, random_id())
            .map_err(|_| "crypto_error")?;
        self.store.outbox.insert(
            op.clone(),
            Outbox {
                bot_id: bot.to_owned(),
                conversation_id: conversation_id.to_vec(),
                membership_key: membership_key(epoch, &members),
                envelope: envelope.encode_to_vec(),
                recipients,
                accepted: false,
            },
        );
        Ok(op)
    }
    fn bootstrap_fresh(&self, op: &str) -> bool {
        let Some(out) = self.store.outbox.get(op) else {
            return false;
        };
        let key = STANDARD.encode(&out.conversation_id);
        if self.store.blocked.contains(&key)
            || self
                .store
                .unacked
                .iter()
                .any(|e| e.get("conversationId").and_then(Value::as_str) == Some(key.as_str()))
        {
            return false;
        }
        let Some(account) = self.store.accounts.get(&out.bot_id) else {
            return false;
        };
        let Ok(client) = Client::restore(&account.snapshot) else {
            return false;
        };
        let Ok(members) = client.members(&out.conversation_id) else {
            return false;
        };
        let Ok(epoch) = client.epoch(&out.conversation_id) else {
            return false;
        };
        membership_key(epoch, &members) == out.membership_key
    }
    async fn resume_bootstrap(&mut self, bot: &str) -> std::result::Result<(), &'static str> {
        if !self.connected.contains(bot) {
            return Ok(());
        }
        let creates: Vec<_> = self
            .store
            .create_labels
            .keys()
            .filter(|op| {
                self.store
                    .outbox
                    .get(*op)
                    .is_some_and(|o| o.bot_id == bot && o.accepted)
            })
            .cloned()
            .collect();
        for op in creates {
            self.ensure_create_followups(&op).await?;
        }
        let ops: Vec<_> = self
            .store
            .outbox
            .iter()
            .filter_map(|(op, o)| {
                let public_op = op.starts_with(&format!("joined-profile:{bot}:"))
                    || (op.starts_with(&format!("create:{bot}:"))
                        && (op.ends_with(":profile") || op.ends_with(":group")));
                let pending = self
                    .request_to_operation
                    .values()
                    .any(|current| current == op);
                (o.bot_id == bot
                    && !o.accepted
                    && public_op
                    && !pending
                    && self.bootstrap_fresh(op))
                .then(|| op.clone())
            })
            .collect();
        for op in ops {
            self.queue_outbox(&op)?;
        }
        Ok(())
    }
    async fn ensure_create_followups(&mut self, op: &str) -> std::result::Result<(), &'static str> {
        let Some(welcome) = self.store.outbox.get(op).cloned() else {
            return Err("unknown_operation");
        };
        if !self.bootstrap_fresh(op) {
            return Ok(());
        }
        let label = self
            .store
            .create_labels
            .get(op)
            .cloned()
            .ok_or("invalid_state")?;
        let room_name = self
            .store
            .create_names
            .get(op)
            .cloned()
            .ok_or("invalid_state")?;
        if self.store.outbox.len() > MAX_JOURNAL.saturating_sub(2) {
            return Err("state_capacity_operator_rollover_required");
        }
        let acct = self
            .store
            .accounts
            .get(&welcome.bot_id)
            .cloned()
            .ok_or("unknown_bot")?;
        let mut client = Client::restore(&acct.snapshot).map_err(|_| "crypto_error")?;
        let members = client
            .members(&welcome.conversation_id)
            .map_err(|_| "unknown_conversation")?;
        let epoch = client
            .epoch(&welcome.conversation_id)
            .map_err(|_| "unknown_conversation")?;
        let membership = membership_key(epoch, &members);
        let recipients: Vec<_> = members
            .iter()
            .filter(|m| **m != client.identity())
            .filter_map(|m| {
                if m.len() == 32 {
                    Some(m[16..].to_vec())
                } else {
                    None
                }
            })
            .collect();
        for (suffix, body) in [
            (
                "profile",
                content::Body::Profile(chat_proto::v1::Profile {
                    display_name: label,
                    avatar: Vec::new(),
                }),
            ),
            (
                "group",
                content::Body::GroupInfo(chat_proto::v1::GroupInfo {
                    name: room_name,
                    admins: vec![acct.account_id.as_bytes().to_vec()],
                }),
            ),
        ] {
            let id = format!("{op}:{suffix}");
            if let std::collections::btree_map::Entry::Vacant(entry) = self.store.outbox.entry(id) {
                let content = Content {
                    sent_at_ms: now_ms(),
                    reply_to: None,
                    reply_to_hash: None,
                    body: Some(body),
                };
                let envelope = client
                    .send(&welcome.conversation_id, &content, random_id())
                    .map_err(|_| "crypto_error")?;
                entry.insert(Outbox {
                    bot_id: welcome.bot_id.clone(),
                    conversation_id: welcome.conversation_id.clone(),
                    membership_key: membership.clone(),
                    envelope: envelope.encode_to_vec(),
                    recipients: recipients.clone(),
                    accepted: false,
                });
            }
        }
        self.store
            .accounts
            .get_mut(&welcome.bot_id)
            .ok_or("unknown_bot")?
            .snapshot = client.snapshot().map_err(|_| "crypto_error")?;
        self.persist().await.map_err(|_| {
            self.fatal = true;
            "storage_error"
        })?;
        Ok(())
    }
    fn send_ack(&self, bot: &str, message_id: Vec<u8>) {
        if let Some(tx) = self.sessions.get(bot) {
            let _ = tx.try_send(SessionCommand::Frame(ClientFrame {
                request_id: 0,
                body: Some(client_frame::Body::Ack(Ack { message_id })),
            }));
        }
    }
}

fn spawn_ws(
    bot: String,
    token: String,
    url: String,
    mut rx: mpsc::Receiver<SessionCommand>,
    frames: FrameTx,
) {
    tokio::spawn(async move {
        let mut delay = Duration::from_secs(1);
        loop {
            while rx.try_recv().is_ok() {} // Never replay queued writes after reconnect.
            let connection = timeout(NETWORK_TIMEOUT, connect_async(&url)).await;
            let Ok(Ok((socket, _))) = connection else {
                tokio::time::sleep(delay).await;
                delay = (delay * 2).min(Duration::from_secs(30));
                continue;
            };
            let (mut sink, mut stream) = socket.split();
            let auth = ClientFrame {
                request_id: 1,
                body: Some(client_frame::Body::Authenticate(Authenticate {
                    token: token.clone(),
                })),
            };
            if !matches!(
                timeout(
                    NETWORK_TIMEOUT,
                    sink.send(WsMessage::Binary(auth.encode_to_vec().into()))
                )
                .await,
                Ok(Ok(_))
            ) {
                continue;
            }
            let first = timeout(Duration::from_secs(10), stream.next()).await;
            let Ok(Some(Ok(WsMessage::Binary(bytes)))) = first else {
                continue;
            };
            let Ok(auth_frame) = ServerFrame::decode(bytes.as_ref()) else {
                continue;
            };
            let authenticated = matches!(auth_frame.body, Some(server_frame::Body::AuthResult(_)));
            let auth_failed = matches!(auth_frame.body, Some(server_frame::Body::Error(_)));
            let _ = frames.send((bot.clone(), auth_frame)).await;
            if auth_failed {
                return;
            }
            let mut barrier = false;
            if authenticated {
                // The server flushes its initial queue before it reads this application Ping.
                let ping = ClientFrame {
                    request_id: 2,
                    body: Some(client_frame::Body::Ping(chat_proto::v1::Ping {})),
                };
                if !matches!(
                    timeout(
                        NETWORK_TIMEOUT,
                        sink.send(WsMessage::Binary(ping.encode_to_vec().into()))
                    )
                    .await,
                    Ok(Ok(_))
                ) {
                    continue;
                }
                while !barrier {
                    tokio::select! {
                        command=rx.recv()=>match command {
                            Some(SessionCommand::Frame(f)) if matches!(f.body,Some(client_frame::Body::Ack(_)))=>{let _=sink.send(WsMessage::Binary(f.encode_to_vec().into())).await;},
                            Some(_)=>{},None=>return
                        },
                        incoming=stream.next()=>match incoming {
                            Some(Ok(WsMessage::Binary(data)))=>if let Ok(f)=ServerFrame::decode(data.as_ref()) {
                                let done=f.request_id==2&&matches!(f.body,Some(server_frame::Body::Pong(_)));
                                if done {
                                    while let Ok(SessionCommand::Frame(ack))=rx.try_recv(){if matches!(ack.body,Some(client_frame::Body::Ack(_))){let _=sink.send(WsMessage::Binary(ack.encode_to_vec().into())).await;}}
                                    let _=frames.send((bot.clone(),f)).await;barrier=true;
                                } else {let denied=matches!(f.body,Some(server_frame::Body::Error(ref e))if e.code==401);let _=frames.send((bot.clone(),f)).await;if denied{return;}}
                            },
                            Some(Ok(WsMessage::Ping(p)))=>{let _=sink.send(WsMessage::Pong(p)).await;},_=>break
                        }
                    }
                }
            }
            if authenticated && !barrier {
                while rx.try_recv().is_ok() {}
                let error = chat_proto::v1::Error {
                    code: 503,
                    message: String::new(),
                };
                let _ = frames
                    .send((
                        bot.clone(),
                        ServerFrame {
                            request_id: 0,
                            body: Some(server_frame::Body::Error(error)),
                        },
                    ))
                    .await;
                tokio::time::sleep(delay).await;
                delay = (delay * 2).min(Duration::from_secs(30));
                continue;
            }
            if authenticated {
                delay = Duration::from_secs(1);
                loop {
                    tokio::select! {
                        outgoing=rx.recv()=>match outgoing {Some(SessionCommand::Frame(f))=>if !matches!(timeout(NETWORK_TIMEOUT,sink.send(WsMessage::Binary(f.encode_to_vec().into()))).await,Ok(Ok(_))){break},None=>return},
                        incoming=stream.next()=>match incoming {Some(Ok(WsMessage::Binary(data)))=>if let Ok(f)=ServerFrame::decode(data.as_ref()){let denied=matches!(f.body,Some(server_frame::Body::Error(ref e))if e.code==401);let _=frames.send((bot.clone(),f)).await;if denied{return;}},Some(Ok(WsMessage::Ping(p)))=>{let _=sink.send(WsMessage::Pong(p)).await;},Some(Ok(_))=>{},_=>break}
                    }
                }
                while rx.try_recv().is_ok() {}
                let error = chat_proto::v1::Error {
                    code: 503,
                    message: String::new(),
                };
                let _ = frames
                    .send((
                        bot.clone(),
                        ServerFrame {
                            request_id: 0,
                            body: Some(server_frame::Body::Error(error)),
                        },
                    ))
                    .await;
            }
            tokio::time::sleep(delay).await;
            delay = (delay * 2).min(Duration::from_secs(30));
        }
    });
}
fn ws_url(server: &str) -> String {
    format!(
        "{}/v1/ws",
        server
            .replacen("https://", "wss://", 1)
            .replacen("http://", "ws://", 1)
    )
}
fn dedup_id(bot: &str, envelope: &Envelope) -> String {
    let mut digest = Sha256::new();
    digest.update(b"chat.bot.event.v1\\0");
    digest.update((bot.len() as u64).to_le_bytes());
    digest.update(bot.as_bytes());
    digest.update((envelope.conversation_id.len() as u64).to_le_bytes());
    digest.update(&envelope.conversation_id);
    digest.update((envelope.message_id.len() as u64).to_le_bytes());
    digest.update(&envelope.message_id);
    digest.update(&envelope.ciphertext);
    format!("{bot}:{}", STANDARD.encode(digest.finalize()))
}
fn random_id() -> Vec<u8> {
    let mut id = [0u8; 16];
    rand::rng().fill_bytes(&mut id);
    id.to_vec()
}
fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as u64)
}
fn membership_key(epoch: u64, members: &[Vec<u8>]) -> String {
    let mut ids: Vec<_> = members.iter().map(|m| STANDARD.encode(m)).collect();
    ids.sort();
    format!("{epoch}:{}", ids.join(","))
}
fn members_json(members: &[Vec<u8>]) -> Value {
    let mut out = Vec::new();
    for m in members {
        if m.len() == 32
            && let (Ok(a), Ok(d)) = (Uuid::from_slice(&m[..16]), Uuid::from_slice(&m[16..]))
        {
            out.push(json!({"accountId":a,"deviceId":d}));
        }
    }
    json!(out)
}
fn encrypt(key: &[u8; 32], clear: &[u8]) -> Result<Vec<u8>> {
    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(key));
    let nonce = Aes256Gcm::generate_nonce(&mut OsRng);
    let cipher_text = cipher
        .encrypt(&nonce, clear)
        .map_err(|_| anyhow::anyhow!("encrypt error"))?;
    let mut out = b"CBOT\x01".to_vec();
    out.extend_from_slice(&nonce);
    out.extend_from_slice(&cipher_text);
    Ok(out)
}
fn decrypt(key: &[u8; 32], data: &[u8]) -> Result<Vec<u8>> {
    if data.len() < 33 || &data[..5] != b"CBOT\x01" {
        bail!("invalid encrypted state");
    }
    Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(key))
        .decrypt(Nonce::from_slice(&data[5..17]), &data[17..])
        .map_err(|_| anyhow::anyhow!("state authentication failed"))
}

async fn read_bounded_line<R: tokio::io::AsyncRead + Unpin>(
    reader: &mut R,
    buf: &mut Vec<u8>,
) -> std::io::Result<usize> {
    buf.clear();
    let mut oversized = false;
    loop {
        match reader.read_u8().await {
            Ok(b'\n') => return Ok(if oversized { MAX_LINE + 1 } else { buf.len() }),
            Ok(byte) => {
                if !oversized && buf.len() < MAX_LINE {
                    buf.push(byte);
                } else {
                    oversized = true;
                }
            }
            Err(e) if e.kind() == std::io::ErrorKind::UnexpectedEof => {
                return Ok(if buf.is_empty() && !oversized {
                    0
                } else if oversized {
                    MAX_LINE + 1
                } else {
                    buf.len()
                });
            }
            Err(e) => return Err(e),
        }
    }
}

#[tokio::main]
async fn main() -> Result<()> {
    let (tx, mut frames) = mpsc::channel(256);
    let mut app = App::open(tx).await?;
    // Re-emit durable unacked events before processing new commands. Outbox sends are never replayed here.
    let pending = app.store.unacked.clone();
    let mut stdout = tokio::io::stdout();
    for ev in pending {
        let mut b = serde_json::to_vec(&ev)?;
        b.push(b'\n');
        stdout.write_all(&b).await?;
    }
    stdout.flush().await?;
    let mut stdin = BufReader::new(tokio::io::stdin());
    let mut line = Vec::new();
    loop {
        tokio::select! {
            read=read_bounded_line(&mut stdin,&mut line)=>{let n=read?;if n==0{break;}else if n>MAX_LINE{stdout.write_all(b"{\"ok\":false,\"error\":\"input_too_large\"}\n").await?;continue;}
                while let Ok((bot, frame)) = frames.try_recv() { for ev in app.frame(bot, frame).await { let mut b=serde_json::to_vec(&ev)?; b.push(b'\n'); stdout.write_all(&b).await?; } }
                if app.fatal { bail!("durable state write failed"); }
                let reply=match serde_json::from_slice::<Command>(&line){Ok(c)=>app.command(c).await,Err(_)=>json!({"ok":false,"error":"invalid_json"})};line.clear();
                if app.fatal || reply.get("error").and_then(Value::as_str)==Some("storage_error") { bail!("durable state write failed"); }
                for event in std::mem::take(&mut app.pending_events) { let mut b=serde_json::to_vec(&event)?; b.push(b'\n'); stdout.write_all(&b).await?; }
                let mut b=serde_json::to_vec(&reply)?;b.push(b'\n');stdout.write_all(&b).await?;stdout.flush().await?;
            }
            Some((bot,frame))=frames.recv()=>{for ev in app.frame(bot,frame).await{let mut b=serde_json::to_vec(&ev)?;b.push(b'\n');stdout.write_all(&b).await?;}stdout.flush().await?;if app.fatal { bail!("durable state write failed"); }}
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn encrypted_state_round_trip_and_authentication() {
        let key: [u8; 32] = Aes256Gcm::generate_key(&mut OsRng).into();
        let mut sealed = encrypt(&key, b"state").unwrap();
        let independently_sealed = encrypt(&key, b"state").unwrap();
        assert_ne!(&sealed[5..17], &independently_sealed[5..17]);
        assert_eq!(decrypt(&key, &independently_sealed).unwrap(), b"state");
        assert_eq!(decrypt(&key, &sealed).unwrap(), b"state");
        *sealed.last_mut().unwrap() ^= 1;
        assert!(decrypt(&key, &sealed).is_err());
    }
    #[test]
    fn membership_key_is_order_independent_but_epoch_bound() {
        assert_eq!(
            membership_key(2, &[vec![1], vec![2]]),
            membership_key(2, &[vec![2], vec![1]])
        );
        assert_ne!(
            membership_key(2, &[vec![1], vec![2]]),
            membership_key(3, &[vec![1], vec![2]])
        );
    }
    #[test]
    fn event_deduplication_is_bot_conversation_and_ciphertext_scoped() {
        let env = Envelope {
            conversation_id: vec![1],
            message_id: vec![2],
            ciphertext: vec![3],
            ..Default::default()
        };
        let first = dedup_id("bot-a", &env);
        assert_ne!(first, dedup_id("bot-b", &env));
        let mut other = env.clone();
        other.conversation_id = vec![4];
        assert_ne!(first, dedup_id("bot-a", &other));
        other = env.clone();
        other.ciphertext = vec![5];
        assert_ne!(first, dedup_id("bot-a", &other));
    }
    #[tokio::test]
    async fn input_reader_caps_memory_and_discards_oversized_line() {
        let (mut writer, mut reader) = tokio::io::duplex(MAX_LINE + 32);
        let mut data = vec![b'x'; MAX_LINE + 10];
        data.push(b'\n');
        writer.write_all(&data).await.unwrap();
        drop(writer);
        let mut line = Vec::new();
        assert_eq!(
            read_bounded_line(&mut reader, &mut line).await.unwrap(),
            MAX_LINE + 1
        );
        assert!(line.len() <= MAX_LINE);
    }
}
