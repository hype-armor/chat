/* tslint:disable */
/* eslint-disable */

export class AddedView {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    /**
     * SHA-256 of the commit ciphertext (compare with `/v1/groups/epoch`).
     */
    commitHash: Uint8Array;
    /**
     * Encoded handshake `Envelope` for the existing members.
     */
    commit: Uint8Array;
    /**
     * Encoded welcome `Envelope` for the new devices.
     */
    welcome: Uint8Array;
}

/**
 * Decrypts and checks a downloaded file piece by piece (ADR-0024).
 */
export class AttachmentOpener {
    free(): void;
    [Symbol.dispose](): void;
    /**
     * The last plaintext bytes; throws unless the whole file checks out.
     */
    finish(): Uint8Array;
    constructor(key: Uint8Array, size: number, digest: Uint8Array);
    push(data: Uint8Array): Uint8Array;
}

/**
 * Encrypts a file piece by piece for upload (ADR-0024).
 */
export class AttachmentSealer {
    free(): void;
    [Symbol.dispose](): void;
    finish(): SealedView;
    /**
     * `key`: 32 random bytes.
     */
    constructor(key: Uint8Array);
    push(data: Uint8Array): Uint8Array;
}

/**
 * An `Attachment` message body (ADR-0024).
 */
export class AttachmentView {
    free(): void;
    [Symbol.dispose](): void;
    constructor(blob_id: Uint8Array, key: Uint8Array, digest: Uint8Array, size: number, mime: string, name: string, width: number, height: number, thumbnail: Uint8Array, caption: string, duration_ms: number, voice_note: boolean);
    blobId: Uint8Array;
    caption: string;
    digest: Uint8Array;
    durationMs: number;
    height: number;
    key: Uint8Array;
    mime: string;
    name: string;
    size: number;
    thumbnail: Uint8Array;
    voiceNote: boolean;
    width: number;
}

/**
 * One call's SFrame keys and frame counter (ADR-0030). Keys are installed
 * by `CoreClient.installCallKeys`; frames never leave the core worker
 * unencrypted for long.
 */
export class CallMedia {
    free(): void;
    [Symbol.dispose](): void;
    decrypt(frame: Uint8Array, clear: number): Uint8Array;
    /**
     * `clear`: leading bytes left readable (and authenticated) for the packetizer.
     */
    encrypt(frame: Uint8Array, clear: number): Uint8Array;
    constructor();
}

/**
 * A `Call` signalling message (ADR-0028). `kind`: 0 offer, 1 answer,
 * 2 candidate, 3 hang up, 4 decline, 5 busy.
 */
export class CallView {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    callId: Uint8Array;
    candidate: string;
    group: boolean;
    kind: number;
    sdp: string;
    toDevice: Uint8Array;
    video: boolean;
}

export class CoreClient {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    /**
     * `identities`: one 32-byte `account ‖ device` id per key package, in
     * the same order. A package whose identity differs is refused.
     */
    addMembers(conversation_id: Uint8Array, identities: Array<any>, key_packages: Array<any>, commit_id: Uint8Array, welcome_id: Uint8Array): AddedView;
    /**
     * Stages a commit of received proposals (members leaving).
     */
    commitProposals(conversation_id: Uint8Array, commit_id: Uint8Array): StagedView;
    confirmCommit(conversation_id: Uint8Array): void;
    conversationIds(): Array<any>;
    discardCommit(conversation_id: Uint8Array): void;
    hasPendingProposals(conversation_id: Uint8Array): boolean;
    identity(): Uint8Array;
    /**
     * Installs a call's SFrame keys for the current epoch (ADR-0030).
     */
    installCallKeys(conversation_id: Uint8Array, call_id: Uint8Array, media: CallMedia): void;
    isActive(conversation_id: Uint8Array): boolean;
    /**
     * The identity a key package claims, so the worker can check it against
     * the device it asked the directory for before staging an add (H1).
     */
    keyPackageIdentity(key_package: Uint8Array): Uint8Array;
    keyPackages(count: number): Array<any>;
    /**
     * Returns the encoded `Envelope` of a proposal removing this device.
     */
    leave(conversation_id: Uint8Array, message_id: Uint8Array): Uint8Array;
    /**
     * Stages adding devices; see `Client::add_members`. Returns encoded
     * commit and welcome envelopes.
     * `[identity, signatureKey]` pairs, in leaf order (ADR-0020).
     */
    memberKeys(conversation_id: Uint8Array): Array<any>;
    members(conversation_id: Uint8Array): Array<any>;
    /**
     * Decrypts an encoded `Envelope`.
     */
    receive(envelope: Uint8Array): EventView;
    /**
     * Stages removing all devices of the given account ids.
     */
    removeMembers(conversation_id: Uint8Array, accounts: Array<any>, commit_id: Uint8Array): StagedView;
    static restore(snapshot: Uint8Array): CoreClient;
    /**
     * Returns the encoded `Envelope`.
     */
    sendAttachment(conversation_id: Uint8Array, attachment: AttachmentView, sent_at_ms: number, message_id: Uint8Array, reply_to?: Uint8Array | null, reply_to_hash?: Uint8Array | null): Uint8Array;
    /**
     * A call signalling message (ADR-0028). Returns the encoded `Envelope`.
     */
    sendCall(conversation_id: Uint8Array, call_id: Uint8Array, kind: number, sdp: string, candidate: string, video: boolean, to_device: Uint8Array, group: boolean, sent_at_ms: number, message_id: Uint8Array): Uint8Array;
    /**
     * Deletes only authenticated own-account content. Original verification and
     * the inclusive 1-hour eligibility window remain the worker's responsibility.
     */
    sendDeletion(conversation_id: Uint8Array, target: Uint8Array, target_hash: Uint8Array, target_author: Uint8Array, sent_at_ms: number, message_id: Uint8Array): Uint8Array;
    /**
     * For the account's self conversation only (ADR-0019).
     */
    sendDeviceSync(conversation_id: Uint8Array, state: Uint8Array, sent_at_ms: number, message_id: Uint8Array): Uint8Array;
    /**
     * `admins`: account ids (16 bytes each) in priority order.
     */
    sendGroupInfo(conversation_id: Uint8Array, name: string, admins: Array<any>, sent_at_ms: number, message_id: Uint8Array): Uint8Array;
    /**
     * A live-location start or update (`point` true) or stop. Until-stopped
     * sessions renew their 8-hour lease. Returns the encoded `Envelope`.
     */
    sendLiveLocation(conversation_id: Uint8Array, session_id: Uint8Array, expires_at_ms: number, until_stopped: boolean, point: boolean, latitude: number, longitude: number, accuracy_m: number, sent_at_ms: number, message_id: Uint8Array): Uint8Array;
    /**
     * Send coarse locality through MLS, independently of names and avatar bytes.
     */
    sendLocality(conversation_id: Uint8Array, city: string, region: string, country: string, expires_at_ms: number, sent_at_ms: number, message_id: Uint8Array): Uint8Array;
    /**
     * Returns the encoded `Envelope`.
     */
    sendLocation(conversation_id: Uint8Array, latitude: number, longitude: number, accuracy_m: number, label: string, sent_at_ms: number, message_id: Uint8Array, reply_to?: Uint8Array | null, reply_to_hash?: Uint8Array | null): Uint8Array;
    sendProfile(conversation_id: Uint8Array, display_name: string, avatar: Uint8Array, sent_at_ms: number, message_id: Uint8Array): Uint8Array;
    /**
     * Durable reaction updates use the existing MLS envelope and sender authentication.
     */
    sendReaction(conversation_id: Uint8Array, target: Uint8Array, target_hash: Uint8Array, target_author: Uint8Array, emoji: string, sent_at_ms: number, message_id: Uint8Array): Uint8Array;
    /**
     * `read`: read receipt, else delivered. Ids are 16-byte message ids.
     */
    sendReceipt(conversation_id: Uint8Array, read: boolean, message_ids: Array<any>, sent_at_ms: number, message_id: Uint8Array): Uint8Array;
    /**
     * Returns the encoded `Envelope`. The optional reply id must have 16 bytes.
     */
    sendText(conversation_id: Uint8Array, body: string, sent_at_ms: number, message_id: Uint8Array, reply_to?: Uint8Array | null, reply_to_hash?: Uint8Array | null): Uint8Array;
    /**
     * Ephemeral typing state. The worker must drop stale or superseded events.
     */
    sendTyping(conversation_id: Uint8Array, active: boolean, sent_at_ms: number, expires_at_ms: number, message_id: Uint8Array): Uint8Array;
    /**
     * Contains private keys: encrypt before storing.
     */
    snapshot(): Uint8Array;
    /**
     * `identities`: one 32-byte `account ‖ device` id per key package, in
     * the same order (audit H1).
     */
    startConversation(identities: Array<any>, key_packages: Array<any>, message_id: Uint8Array): StartedView;
    /**
     * Read immediately after a successful serialized visible-message send.
     */
    readonly lastSentContentHash: Uint8Array | undefined;
}

/**
 * A received envelope, flattened for JavaScript. `kind` is one of
 * `message`, `joined`, `epoch`, `proposal`, `ignored`.
 */
export class EventView {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    get attachment(): AttachmentView | undefined;
    set attachment(value: AttachmentView | null | undefined);
    /**
     * A `Profile`'s photo (JPEG), if the sender has one.
     */
    get avatar(): Uint8Array | undefined;
    /**
     * A `Profile`'s photo (JPEG), if the sender has one.
     */
    set avatar(value: Uint8Array | null | undefined);
    get call(): CallView | undefined;
    set call(value: CallView | null | undefined);
    get contentHash(): Uint8Array | undefined;
    set contentHash(value: Uint8Array | null | undefined);
    conversationId: Uint8Array;
    get deletionTargetAuthor(): Uint8Array | undefined;
    set deletionTargetAuthor(value: Uint8Array | null | undefined);
    get deletionTargetHash(): Uint8Array | undefined;
    set deletionTargetHash(value: Uint8Array | null | undefined);
    get deletionTarget(): Uint8Array | undefined;
    set deletionTarget(value: Uint8Array | null | undefined);
    /**
     * `DeviceSync` state from one of the account's own devices.
     */
    get deviceSync(): Uint8Array | undefined;
    /**
     * `DeviceSync` state from one of the account's own devices.
     */
    set deviceSync(value: Uint8Array | null | undefined);
    get displayName(): string | undefined;
    set displayName(value: string | null | undefined);
    /**
     * Admin account ids from a `GroupInfo`, 16 bytes each, concatenated.
     */
    groupAdmins: Uint8Array;
    get groupName(): string | undefined;
    set groupName(value: string | null | undefined);
    kind: string;
    get live(): LiveLocationView | undefined;
    set live(value: LiveLocationView | null | undefined);
    get locality(): LocalityView | undefined;
    set locality(value: LocalityView | null | undefined);
    get location(): LocationView | undefined;
    set location(value: LocationView | null | undefined);
    get reaction(): Uint8Array | undefined;
    set reaction(value: Uint8Array | null | undefined);
    /**
     * Receipted message ids, 16 bytes each, concatenated.
     */
    receiptIds: Uint8Array;
    /**
     * Receipts: 0 delivered, 1 read.
     */
    get receiptKind(): number | undefined;
    /**
     * Receipts: 0 delivered, 1 read.
     */
    set receiptKind(value: number | null | undefined);
    get replyToHash(): Uint8Array | undefined;
    set replyToHash(value: Uint8Array | null | undefined);
    /**
     * Original message id, only for valid user-visible reply references.
     */
    get replyTo(): Uint8Array | undefined;
    /**
     * Original message id, only for valid user-visible reply references.
     */
    set replyTo(value: Uint8Array | null | undefined);
    sender: Uint8Array;
    sentAtMs: number;
    get text(): string | undefined;
    set text(value: string | null | undefined);
    get typingActive(): boolean | undefined;
    set typingActive(value: boolean | null | undefined);
    get typingExpiresAtMs(): number | undefined;
    set typingExpiresAtMs(value: number | null | undefined);
}

/**
 * Builds an N-member group so JavaScript can time membership commits
 * (NFR-PERF-5: < 200 ms for 50 members on a mid-range phone).
 */
export class GroupBench {
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Creates and applies one self-update commit; returns its size in bytes.
     */
    commitUpdate(): number;
    memberCount(): number;
    constructor(members: number);
}

/**
 * A `LiveLocation` body; until-stopped sessions renew their 8-hour lease.
 */
export class LiveLocationView {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    expiresAtMs: number;
    get location(): LocationView | undefined;
    set location(value: LocationView | null | undefined);
    sessionId: Uint8Array;
    stopped: boolean;
    untilStopped: boolean;
}

/**
 * Coarse locality only. An empty city is a revocation (ADR-0041).
 */
export class LocalityView {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    city: string;
    country: string;
    expiresAtMs: number;
    region: string;
}

/**
 * A `Location` message body.
 */
export class LocationView {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    accuracyM: number;
    label: string;
    latitude: number;
    longitude: number;
}

/**
 * A signing key awaiting registration: send `publicKey` to the server,
 * then turn it into a client with the identity the server assigns.
 */
export class PendingClient {
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Consumes the pending key. `identity` is account id ‖ device id.
     */
    intoClient(identity: Uint8Array): CoreClient;
    constructor();
    publicKey(): Uint8Array;
}

/**
 * A QR code's modules: `size` × `size`, row-major, 1 for dark.
 */
export class QrView {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    modules: Uint8Array;
    size: number;
}

/**
 * What `AttachmentSealer.finish` returns.
 */
export class SealedView {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    digest: Uint8Array;
    size: number;
    /**
     * The last ciphertext bytes.
     */
    tail: Uint8Array;
}

/**
 * A decoded `ServerFrame`. `kind` is one of `auth`, `deliver`, `devices_changed`,
 * `send_result`, `pong`, `error`, `empty`.
 */
export class ServerFrameView {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    accepted: boolean;
    /**
     * Conversation of a delivered envelope.
     */
    conversationId: Uint8Array;
    deviceId: Uint8Array;
    /**
     * Encoded `Envelope` for `deliver`.
     */
    envelope: Uint8Array;
    epochConflict: boolean;
    errorCode: number;
    errorMessage: string;
    /**
     * `auth`: this device's available key packages.
     */
    keyPackages: number;
    kind: string;
    messageId: Uint8Array;
    requestId: number;
    /**
     * Whether a delivered envelope is an MLS welcome.
     */
    welcome: boolean;
}

/**
 * A staged commit without new members.
 */
export class StagedView {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    commitHash: Uint8Array;
    /**
     * Encoded handshake `Envelope` for every current member.
     */
    commit: Uint8Array;
}

export class StartedView {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    conversationId: Uint8Array;
    /**
     * Encoded welcome `Envelope` for the invited devices.
     */
    welcome: Uint8Array;
}

export function core_version(): string;

/**
 * Reads the first QR code in an RGBA image (e.g. a camera frame).
 */
export function decodeQr(rgba: Uint8Array, width: number, height: number): string | undefined;

export function decodeServerFrame(bytes: Uint8Array): ServerFrameView;

export function encodeAck(request_id: number, message_id: Uint8Array): Uint8Array;

export function encodeAuthenticate(request_id: number, token: string): Uint8Array;

export function encodePing(request_id: number): Uint8Array;

export function encodeQr(text: string): QrView;

/**
 * `members`: for a commit that changes membership, the devices that are
 * members afterwards (ADR-0035); empty for every other frame.
 */
export function encodeSend(request_id: number, envelope: Uint8Array, recipients: Array<any>, silent: boolean, members: Array<any>): Uint8Array;

/**
 * A commit plus the welcome for the members it adds; the server accepts
 * both together (ADR-0017).
 */
export function encodeSendWithWelcome(request_id: number, commit: Uint8Array, recipients: Array<any>, welcome: Uint8Array, welcome_recipients: Array<any>, members: Array<any>): Uint8Array;

/**
 * Safety number for two accounts' device signature keys (ADR-0020).
 */
export function safetyNumber(my_account: Uint8Array, my_keys: Array<any>, their_account: Uint8Array, their_keys: Array<any>): string;

/**
 * Ciphertext size of a file of `len` bytes, padding included.
 */
export function sealedLength(len: number): number;

/**
 * Two in-memory devices create a conversation and exchange a message.
 * Proves MLS works in this browser (Phase 0 spike a).
 */
export function self_test(): boolean;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly __wbg_addedview_free: (a: number, b: number) => void;
    readonly __wbg_attachmentopener_free: (a: number, b: number) => void;
    readonly __wbg_attachmentsealer_free: (a: number, b: number) => void;
    readonly __wbg_attachmentview_free: (a: number, b: number) => void;
    readonly __wbg_callmedia_free: (a: number, b: number) => void;
    readonly __wbg_callview_free: (a: number, b: number) => void;
    readonly __wbg_coreclient_free: (a: number, b: number) => void;
    readonly __wbg_eventview_free: (a: number, b: number) => void;
    readonly __wbg_get_addedview_commit: (a: number) => [number, number];
    readonly __wbg_get_addedview_commitHash: (a: number) => [number, number];
    readonly __wbg_get_addedview_welcome: (a: number) => [number, number];
    readonly __wbg_get_attachmentview_blobId: (a: number) => [number, number];
    readonly __wbg_get_attachmentview_caption: (a: number) => [number, number];
    readonly __wbg_get_attachmentview_digest: (a: number) => [number, number];
    readonly __wbg_get_attachmentview_durationMs: (a: number) => number;
    readonly __wbg_get_attachmentview_height: (a: number) => number;
    readonly __wbg_get_attachmentview_key: (a: number) => [number, number];
    readonly __wbg_get_attachmentview_mime: (a: number) => [number, number];
    readonly __wbg_get_attachmentview_name: (a: number) => [number, number];
    readonly __wbg_get_attachmentview_size: (a: number) => number;
    readonly __wbg_get_attachmentview_thumbnail: (a: number) => [number, number];
    readonly __wbg_get_attachmentview_voiceNote: (a: number) => number;
    readonly __wbg_get_attachmentview_width: (a: number) => number;
    readonly __wbg_get_callview_callId: (a: number) => [number, number];
    readonly __wbg_get_callview_candidate: (a: number) => [number, number];
    readonly __wbg_get_callview_group: (a: number) => number;
    readonly __wbg_get_callview_kind: (a: number) => number;
    readonly __wbg_get_callview_sdp: (a: number) => [number, number];
    readonly __wbg_get_callview_toDevice: (a: number) => [number, number];
    readonly __wbg_get_callview_video: (a: number) => number;
    readonly __wbg_get_eventview_attachment: (a: number) => number;
    readonly __wbg_get_eventview_avatar: (a: number) => [number, number];
    readonly __wbg_get_eventview_call: (a: number) => number;
    readonly __wbg_get_eventview_contentHash: (a: number) => [number, number];
    readonly __wbg_get_eventview_conversationId: (a: number) => [number, number];
    readonly __wbg_get_eventview_deletionTarget: (a: number) => [number, number];
    readonly __wbg_get_eventview_deletionTargetAuthor: (a: number) => [number, number];
    readonly __wbg_get_eventview_deletionTargetHash: (a: number) => [number, number];
    readonly __wbg_get_eventview_deviceSync: (a: number) => [number, number];
    readonly __wbg_get_eventview_displayName: (a: number) => [number, number];
    readonly __wbg_get_eventview_groupAdmins: (a: number) => [number, number];
    readonly __wbg_get_eventview_groupName: (a: number) => [number, number];
    readonly __wbg_get_eventview_kind: (a: number) => [number, number];
    readonly __wbg_get_eventview_live: (a: number) => number;
    readonly __wbg_get_eventview_locality: (a: number) => number;
    readonly __wbg_get_eventview_location: (a: number) => number;
    readonly __wbg_get_eventview_reaction: (a: number) => [number, number];
    readonly __wbg_get_eventview_receiptIds: (a: number) => [number, number];
    readonly __wbg_get_eventview_receiptKind: (a: number) => number;
    readonly __wbg_get_eventview_replyTo: (a: number) => [number, number];
    readonly __wbg_get_eventview_replyToHash: (a: number) => [number, number];
    readonly __wbg_get_eventview_sender: (a: number) => [number, number];
    readonly __wbg_get_eventview_sentAtMs: (a: number) => number;
    readonly __wbg_get_eventview_text: (a: number) => [number, number];
    readonly __wbg_get_eventview_typingActive: (a: number) => number;
    readonly __wbg_get_eventview_typingExpiresAtMs: (a: number) => [number, number];
    readonly __wbg_get_livelocationview_expiresAtMs: (a: number) => number;
    readonly __wbg_get_livelocationview_location: (a: number) => number;
    readonly __wbg_get_livelocationview_sessionId: (a: number) => [number, number];
    readonly __wbg_get_livelocationview_stopped: (a: number) => number;
    readonly __wbg_get_livelocationview_untilStopped: (a: number) => number;
    readonly __wbg_get_localityview_city: (a: number) => [number, number];
    readonly __wbg_get_localityview_country: (a: number) => [number, number];
    readonly __wbg_get_localityview_expiresAtMs: (a: number) => number;
    readonly __wbg_get_localityview_region: (a: number) => [number, number];
    readonly __wbg_get_locationview_accuracyM: (a: number) => number;
    readonly __wbg_get_locationview_label: (a: number) => [number, number];
    readonly __wbg_get_locationview_latitude: (a: number) => number;
    readonly __wbg_get_locationview_longitude: (a: number) => number;
    readonly __wbg_get_qrview_modules: (a: number) => [number, number];
    readonly __wbg_get_qrview_size: (a: number) => number;
    readonly __wbg_get_sealedview_digest: (a: number) => [number, number];
    readonly __wbg_get_sealedview_size: (a: number) => number;
    readonly __wbg_get_sealedview_tail: (a: number) => [number, number];
    readonly __wbg_get_serverframeview_accepted: (a: number) => number;
    readonly __wbg_get_serverframeview_conversationId: (a: number) => [number, number];
    readonly __wbg_get_serverframeview_deviceId: (a: number) => [number, number];
    readonly __wbg_get_serverframeview_envelope: (a: number) => [number, number];
    readonly __wbg_get_serverframeview_epochConflict: (a: number) => number;
    readonly __wbg_get_serverframeview_errorCode: (a: number) => number;
    readonly __wbg_get_serverframeview_errorMessage: (a: number) => [number, number];
    readonly __wbg_get_serverframeview_keyPackages: (a: number) => number;
    readonly __wbg_get_serverframeview_kind: (a: number) => [number, number];
    readonly __wbg_get_serverframeview_messageId: (a: number) => [number, number];
    readonly __wbg_get_serverframeview_requestId: (a: number) => number;
    readonly __wbg_get_serverframeview_welcome: (a: number) => number;
    readonly __wbg_get_stagedview_commit: (a: number) => [number, number];
    readonly __wbg_get_stagedview_commitHash: (a: number) => [number, number];
    readonly __wbg_get_startedview_conversationId: (a: number) => [number, number];
    readonly __wbg_get_startedview_welcome: (a: number) => [number, number];
    readonly __wbg_groupbench_free: (a: number, b: number) => void;
    readonly __wbg_livelocationview_free: (a: number, b: number) => void;
    readonly __wbg_localityview_free: (a: number, b: number) => void;
    readonly __wbg_locationview_free: (a: number, b: number) => void;
    readonly __wbg_pendingclient_free: (a: number, b: number) => void;
    readonly __wbg_qrview_free: (a: number, b: number) => void;
    readonly __wbg_sealedview_free: (a: number, b: number) => void;
    readonly __wbg_serverframeview_free: (a: number, b: number) => void;
    readonly __wbg_set_addedview_commit: (a: number, b: number, c: number) => void;
    readonly __wbg_set_addedview_commitHash: (a: number, b: number, c: number) => void;
    readonly __wbg_set_addedview_welcome: (a: number, b: number, c: number) => void;
    readonly __wbg_set_attachmentview_blobId: (a: number, b: number, c: number) => void;
    readonly __wbg_set_attachmentview_caption: (a: number, b: number, c: number) => void;
    readonly __wbg_set_attachmentview_digest: (a: number, b: number, c: number) => void;
    readonly __wbg_set_attachmentview_durationMs: (a: number, b: number) => void;
    readonly __wbg_set_attachmentview_height: (a: number, b: number) => void;
    readonly __wbg_set_attachmentview_key: (a: number, b: number, c: number) => void;
    readonly __wbg_set_attachmentview_mime: (a: number, b: number, c: number) => void;
    readonly __wbg_set_attachmentview_name: (a: number, b: number, c: number) => void;
    readonly __wbg_set_attachmentview_size: (a: number, b: number) => void;
    readonly __wbg_set_attachmentview_thumbnail: (a: number, b: number, c: number) => void;
    readonly __wbg_set_attachmentview_voiceNote: (a: number, b: number) => void;
    readonly __wbg_set_attachmentview_width: (a: number, b: number) => void;
    readonly __wbg_set_callview_callId: (a: number, b: number, c: number) => void;
    readonly __wbg_set_callview_candidate: (a: number, b: number, c: number) => void;
    readonly __wbg_set_callview_group: (a: number, b: number) => void;
    readonly __wbg_set_callview_kind: (a: number, b: number) => void;
    readonly __wbg_set_callview_sdp: (a: number, b: number, c: number) => void;
    readonly __wbg_set_callview_toDevice: (a: number, b: number, c: number) => void;
    readonly __wbg_set_callview_video: (a: number, b: number) => void;
    readonly __wbg_set_eventview_attachment: (a: number, b: number) => void;
    readonly __wbg_set_eventview_avatar: (a: number, b: number, c: number) => void;
    readonly __wbg_set_eventview_call: (a: number, b: number) => void;
    readonly __wbg_set_eventview_contentHash: (a: number, b: number, c: number) => void;
    readonly __wbg_set_eventview_conversationId: (a: number, b: number, c: number) => void;
    readonly __wbg_set_eventview_deletionTarget: (a: number, b: number, c: number) => void;
    readonly __wbg_set_eventview_deletionTargetAuthor: (a: number, b: number, c: number) => void;
    readonly __wbg_set_eventview_deletionTargetHash: (a: number, b: number, c: number) => void;
    readonly __wbg_set_eventview_deviceSync: (a: number, b: number, c: number) => void;
    readonly __wbg_set_eventview_displayName: (a: number, b: number, c: number) => void;
    readonly __wbg_set_eventview_groupAdmins: (a: number, b: number, c: number) => void;
    readonly __wbg_set_eventview_groupName: (a: number, b: number, c: number) => void;
    readonly __wbg_set_eventview_kind: (a: number, b: number, c: number) => void;
    readonly __wbg_set_eventview_live: (a: number, b: number) => void;
    readonly __wbg_set_eventview_locality: (a: number, b: number) => void;
    readonly __wbg_set_eventview_location: (a: number, b: number) => void;
    readonly __wbg_set_eventview_reaction: (a: number, b: number, c: number) => void;
    readonly __wbg_set_eventview_receiptIds: (a: number, b: number, c: number) => void;
    readonly __wbg_set_eventview_receiptKind: (a: number, b: number) => void;
    readonly __wbg_set_eventview_replyTo: (a: number, b: number, c: number) => void;
    readonly __wbg_set_eventview_replyToHash: (a: number, b: number, c: number) => void;
    readonly __wbg_set_eventview_sender: (a: number, b: number, c: number) => void;
    readonly __wbg_set_eventview_sentAtMs: (a: number, b: number) => void;
    readonly __wbg_set_eventview_text: (a: number, b: number, c: number) => void;
    readonly __wbg_set_eventview_typingActive: (a: number, b: number) => void;
    readonly __wbg_set_eventview_typingExpiresAtMs: (a: number, b: number, c: number) => void;
    readonly __wbg_set_livelocationview_expiresAtMs: (a: number, b: number) => void;
    readonly __wbg_set_livelocationview_location: (a: number, b: number) => void;
    readonly __wbg_set_livelocationview_sessionId: (a: number, b: number, c: number) => void;
    readonly __wbg_set_livelocationview_stopped: (a: number, b: number) => void;
    readonly __wbg_set_livelocationview_untilStopped: (a: number, b: number) => void;
    readonly __wbg_set_localityview_city: (a: number, b: number, c: number) => void;
    readonly __wbg_set_localityview_country: (a: number, b: number, c: number) => void;
    readonly __wbg_set_localityview_expiresAtMs: (a: number, b: number) => void;
    readonly __wbg_set_localityview_region: (a: number, b: number, c: number) => void;
    readonly __wbg_set_locationview_accuracyM: (a: number, b: number) => void;
    readonly __wbg_set_locationview_label: (a: number, b: number, c: number) => void;
    readonly __wbg_set_locationview_latitude: (a: number, b: number) => void;
    readonly __wbg_set_locationview_longitude: (a: number, b: number) => void;
    readonly __wbg_set_qrview_modules: (a: number, b: number, c: number) => void;
    readonly __wbg_set_qrview_size: (a: number, b: number) => void;
    readonly __wbg_set_sealedview_digest: (a: number, b: number, c: number) => void;
    readonly __wbg_set_sealedview_size: (a: number, b: number) => void;
    readonly __wbg_set_sealedview_tail: (a: number, b: number, c: number) => void;
    readonly __wbg_set_serverframeview_accepted: (a: number, b: number) => void;
    readonly __wbg_set_serverframeview_conversationId: (a: number, b: number, c: number) => void;
    readonly __wbg_set_serverframeview_deviceId: (a: number, b: number, c: number) => void;
    readonly __wbg_set_serverframeview_envelope: (a: number, b: number, c: number) => void;
    readonly __wbg_set_serverframeview_epochConflict: (a: number, b: number) => void;
    readonly __wbg_set_serverframeview_errorCode: (a: number, b: number) => void;
    readonly __wbg_set_serverframeview_errorMessage: (a: number, b: number, c: number) => void;
    readonly __wbg_set_serverframeview_keyPackages: (a: number, b: number) => void;
    readonly __wbg_set_serverframeview_kind: (a: number, b: number, c: number) => void;
    readonly __wbg_set_serverframeview_messageId: (a: number, b: number, c: number) => void;
    readonly __wbg_set_serverframeview_requestId: (a: number, b: number) => void;
    readonly __wbg_set_serverframeview_welcome: (a: number, b: number) => void;
    readonly __wbg_set_stagedview_commit: (a: number, b: number, c: number) => void;
    readonly __wbg_set_stagedview_commitHash: (a: number, b: number, c: number) => void;
    readonly __wbg_set_startedview_conversationId: (a: number, b: number, c: number) => void;
    readonly __wbg_set_startedview_welcome: (a: number, b: number, c: number) => void;
    readonly __wbg_stagedview_free: (a: number, b: number) => void;
    readonly __wbg_startedview_free: (a: number, b: number) => void;
    readonly attachmentopener_finish: (a: number) => [number, number, number, number];
    readonly attachmentopener_new: (a: number, b: number, c: number, d: number, e: number) => [number, number, number];
    readonly attachmentopener_push: (a: number, b: number, c: number) => [number, number, number, number];
    readonly attachmentsealer_finish: (a: number) => [number, number, number];
    readonly attachmentsealer_new: (a: number, b: number) => [number, number, number];
    readonly attachmentsealer_push: (a: number, b: number, c: number) => [number, number, number, number];
    readonly attachmentview_new: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number, k: number, l: number, m: number, n: number, o: number, p: number, q: number, r: number, s: number) => number;
    readonly callmedia_decrypt: (a: number, b: number, c: number, d: number) => [number, number, number, number];
    readonly callmedia_encrypt: (a: number, b: number, c: number, d: number) => [number, number, number, number];
    readonly callmedia_new: () => number;
    readonly core_version: () => [number, number];
    readonly coreclient_addMembers: (a: number, b: number, c: number, d: any, e: any, f: number, g: number, h: number, i: number) => [number, number, number];
    readonly coreclient_commitProposals: (a: number, b: number, c: number, d: number, e: number) => [number, number, number];
    readonly coreclient_confirmCommit: (a: number, b: number, c: number) => [number, number];
    readonly coreclient_conversationIds: (a: number) => any;
    readonly coreclient_discardCommit: (a: number, b: number, c: number) => [number, number];
    readonly coreclient_hasPendingProposals: (a: number, b: number, c: number) => [number, number, number];
    readonly coreclient_identity: (a: number) => [number, number];
    readonly coreclient_installCallKeys: (a: number, b: number, c: number, d: number, e: number, f: number) => [number, number];
    readonly coreclient_isActive: (a: number, b: number, c: number) => [number, number, number];
    readonly coreclient_keyPackageIdentity: (a: number, b: number, c: number) => [number, number, number, number];
    readonly coreclient_keyPackages: (a: number, b: number) => [number, number, number];
    readonly coreclient_lastSentContentHash: (a: number) => [number, number];
    readonly coreclient_leave: (a: number, b: number, c: number, d: number, e: number) => [number, number, number, number];
    readonly coreclient_memberKeys: (a: number, b: number, c: number) => [number, number, number];
    readonly coreclient_members: (a: number, b: number, c: number) => [number, number, number];
    readonly coreclient_receive: (a: number, b: number, c: number) => [number, number, number];
    readonly coreclient_removeMembers: (a: number, b: number, c: number, d: any, e: number, f: number) => [number, number, number];
    readonly coreclient_restore: (a: number, b: number) => [number, number, number];
    readonly coreclient_sendAttachment: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number, k: number) => [number, number, number, number];
    readonly coreclient_sendCall: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number, k: number, l: number, m: number, n: number, o: number, p: number, q: number) => [number, number, number, number];
    readonly coreclient_sendDeletion: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number, k: number, l: number) => [number, number, number, number];
    readonly coreclient_sendDeviceSync: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number) => [number, number, number, number];
    readonly coreclient_sendGroupInfo: (a: number, b: number, c: number, d: number, e: number, f: any, g: number, h: number, i: number) => [number, number, number, number];
    readonly coreclient_sendLiveLocation: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number, k: number, l: number, m: number, n: number) => [number, number, number, number];
    readonly coreclient_sendLocality: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number, k: number, l: number, m: number) => [number, number, number, number];
    readonly coreclient_sendLocation: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number, k: number, l: number, m: number, n: number, o: number) => [number, number, number, number];
    readonly coreclient_sendProfile: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number) => [number, number, number, number];
    readonly coreclient_sendReaction: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number, k: number, l: number, m: number, n: number) => [number, number, number, number];
    readonly coreclient_sendReceipt: (a: number, b: number, c: number, d: number, e: any, f: number, g: number, h: number) => [number, number, number, number];
    readonly coreclient_sendText: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number, k: number, l: number) => [number, number, number, number];
    readonly coreclient_sendTyping: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number) => [number, number, number, number];
    readonly coreclient_snapshot: (a: number) => [number, number, number, number];
    readonly coreclient_startConversation: (a: number, b: any, c: any, d: number, e: number) => [number, number, number];
    readonly decodeQr: (a: number, b: number, c: number, d: number) => [number, number];
    readonly decodeServerFrame: (a: number, b: number) => [number, number, number];
    readonly encodeAck: (a: number, b: number, c: number) => [number, number];
    readonly encodeAuthenticate: (a: number, b: number, c: number) => [number, number];
    readonly encodePing: (a: number) => [number, number];
    readonly encodeQr: (a: number, b: number) => [number, number, number];
    readonly encodeSend: (a: number, b: number, c: number, d: any, e: number, f: any) => [number, number, number, number];
    readonly encodeSendWithWelcome: (a: number, b: number, c: number, d: any, e: number, f: number, g: any, h: any) => [number, number, number, number];
    readonly groupbench_commitUpdate: (a: number) => [number, number, number];
    readonly groupbench_memberCount: (a: number) => number;
    readonly groupbench_new: (a: number) => [number, number, number];
    readonly pendingclient_intoClient: (a: number, b: number, c: number) => [number, number, number];
    readonly pendingclient_new: () => [number, number, number];
    readonly pendingclient_publicKey: (a: number) => [number, number, number, number];
    readonly safetyNumber: (a: number, b: number, c: any, d: number, e: number, f: any) => [number, number];
    readonly sealedLength: (a: number) => number;
    readonly self_test: () => [number, number, number];
    readonly __wbindgen_exn_store: (a: number) => void;
    readonly __externref_table_alloc: () => number;
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __externref_table_dealloc: (a: number) => void;
    readonly __wbindgen_free: (a: number, b: number, c: number) => void;
    readonly __wbindgen_malloc: (a: number, b: number) => number;
    readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
    readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
