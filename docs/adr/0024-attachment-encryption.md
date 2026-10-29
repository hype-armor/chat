# ADR-0024: Attachment encryption and photo clean-up

- **Status:** Accepted
- **Date:** 2026-10-29
- **Deciders:** project owner, Claude
- **Related requirements:** FR-MED-1, FR-MED-2, FR-MED-3, FR-MED-4, FR-MED-8

## Context
Attachments go through the server to object storage (ADR-0023). Doc 05 §1
asks for:
- device-side encryption with a per-file key;
- chunking, so 100 MB files are never held whole in memory by the crypto;
- padding to hide the exact size;
- photo metadata (EXIF, GPS) stripped;
- encrypted thumbnails.

The ground rules say no hand-rolled cryptography, and keys stay in the core
worker.

## Options considered
1. **WebCrypto AES-GCM per chunk, our own framing** (chunk index in the
   nonce, a last-chunk flag). Fast, but the framing is a home-made
   construction: getting truncation and reordering right is on us.
2. **The STREAM construction (Hoang, Reyhanitabar, Rogaway, Vizár) from
   RustCrypto's `aead` crate, over AES-256-GCM, in the Rust core.** A
   published, analysed construction with a maintained implementation; it
   handles reordering, truncation and the last chunk. Runs in WebAssembly
   at a few tens of MB/s, which is fine for 100 MB.
3. **One AES-GCM call over the whole file.** Simple, but needs the whole
   file in memory twice and can't be resumed (FR-MED-5).

For photos: strip EXIF with a JPEG parser (keeps quality, but a parser per
format and easy to miss metadata) or **re-draw the pixels on a canvas**
(drops everything that isn't pixels, applies orientation, scales down).

## Decision
Option 2, plus re-drawing photos.

- **Format:** a random 256-bit key per file, used once. The plaintext is
  padded with zeros to a Padmé size (at most 12% larger), then sealed by
  `EncryptorBE32<Aes256Gcm>` in 64 KiB chunks with a fixed nonce prefix
  (safe because the key is single-use). The ciphertext is
  `padded + 16 × chunks` bytes.
- **Digest:** the message carries the SHA-256 of the ciphertext. The
  receiver checks it as well as every chunk tag. AES-GCM is not
  key-committing, so the digest pins the exact blob.
- **Message:** a new `Attachment` content body, encrypted by MLS like any
  message. It carries:
  - the blob id, key, digest and size;
  - MIME type and file name;
  - pixel size for images;
  - a JPEG thumbnail of at most 48 KB (320 px, or 160 px if needed);
  - a caption.
- **Photos:** JPEG, PNG, WebP, AVIF, BMP, HEIC and TIFF that the browser can
  decode are re-drawn on an `OffscreenCanvas` in the worker. They are
  scaled to fit 2560 px and re-encoded (PNG stays PNG, the rest become
  JPEG at quality 0.85). Only pixels survive: no EXIF, GPS, camera or
  editing data. GIFs are sent as they are, to keep the animation; GIF has
  no EXIF block. Images the browser can't decode are sent as plain files,
  unchanged.
- **Flow:** the worker seals the file and keeps the sealed copy on the
  device, then uploads it and sends the message. A failed upload can be
  retried from that copy. Received files are downloaded when opened,
  checked, kept sealed for next time, and handed to the UI as a `Blob`.
  The key never leaves the worker.
- **Local copies:** IndexedDB holds sealed blobs (a `files` store). Their
  keys are in the message history, which is itself sealed with the
  storage key. Signing out clears them.
- **Display:** only raster photo types are shown inline. Anything else
  (SVG, HTML, …) is handed out as `application/octet-stream` and offered
  as a download, so a received file never renders in the app's origin.
  Received names and types are cleaned (no paths or control characters).

### Addendum (2026-10-29): voice notes and clips (Phase 2 item 5)
- **Voice notes** are recorded with `MediaRecorder`: Opus in WebM or Ogg,
  or AAC in MP4 on Safari. Up to 5 minutes. They are sent as attachments
  marked `voice_note`, with `duration_ms`. The microphone is on only while
  recording.
- **Clips** (audio and video files) are probed on the UI thread, since the
  worker can't decode media. That gives their duration, and for videos
  their size and a poster frame, which is sent as the thumbnail.
- **Location in clips:** phones store where a video was filmed in the
  MP4/QuickTime `moov` box. The worker blanks `©xyz` and `loci` boxes and
  ISO 6709 coordinates (Apple's `mdta` location key) in place, so every
  offset in the file stays valid. Media data is never touched. Other
  formats are sent unchanged.
- **Playback:** audio and video of common types play inline (media
  elements run no script). Other types stay downloads only.

## Consequences
- The sender re-encodes photos: some quality loss, and large originals
  shrink. A "send original" choice can come with the quality settings
  (FR-MED-5).
- Thumbnails make history and backups bigger (up to 48 KB per photo). The
  25 MB backup limit lasts thousands of photos; item 9 moves backups into
  blob storage.
- Downloads are fetched whole before opening. Resumable transfers and an
  auto-download policy are Phase 2 item 6; the chunked format already
  allows ranged, resumable reads.
- Undecodable images (e.g. HEIC on browsers without HEIC support) keep
  their metadata. iOS converts HEIC to JPEG when a web page picks a photo,
  so this is rare.
- Sealed copies stay on the device with the history. Clean-up with
  disappearing messages comes later.

## Validation
- **Rust tests:**
  - round trips for many file sizes, fed in pieces of every size;
  - wrong key, flipped bits, a dropped last chunk and a wrong size are all
    rejected;
  - Padmé overhead stays bounded.
- **Unit tests:** location blanking in crafted MP4 boxes; clips without a
  location are left unchanged.
- **Browser test (Chromium, fake microphone):** a recorded voice note and a
  WebM clip play on the other side.
- **Browser test:**
  - a JPEG carrying a GPS EXIF block arrives as a valid JPEG without it;
  - a text file arrives byte for byte;
  - after a reload, the file opens from the local copy.
