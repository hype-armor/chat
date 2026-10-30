# ADR-0025: Resumable transfers and auto-download

- **Status:** Accepted
- **Date:** 2026-10-30
- **Deciders:** project owner, Claude
- **Related requirements:** FR-MED-5, FR-MED-6

## Context
Attachments are up to 100 MB (ADR-0023, ADR-0024). On a phone, a single
request that size often fails partway, and starting over wastes data. People
also want photos to appear without tapping each one, but not videos eating
their mobile data.

## Options considered
1. **S3 multipart uploads exposed to the client.** Native resume, but
   S3-specific, and the browser would talk to storage (rejected in
   ADR-0023).
2. **tus protocol.** A standard for resumable uploads, but needs a server
   library and adds a protocol for one feature.
3. **Our own part-based upload sessions plus HTTP `Range` downloads.** A
   handful of plain endpoints on top of any `object_store` backend.

## Decision
Option 3.

- **Uploads:**
  - files up to 8 MiB still go in one `PUT /v1/blobs`;
  - larger ones start a session (`POST /v1/blobs/uploads {size}`) and send
    8 MiB parts (`PUT …/{id}/{n}`, any order, repeatable);
  - after an interruption the client asks which parts arrived
    (`GET …/{id}`) and sends only the rest, then completes;
  - the parts stay as separate objects (`blobs/{id}/{n}`) with no copy into
    one object, so this works on any store;
  - only the device that started a session can add to it. Sessions last
    24 hours, and abandoned ones are deleted with their parts by the
    hourly expiry job;
  - the whole size counts against the daily allowance when the session
    starts, so retries cost nothing extra.
- **Downloads:** `GET /v1/blobs/{id}` honours a single `Range: bytes=…`
  (`206`, `Content-Range`; `416` outside the blob). The client fetches 4 MiB
  pieces and keeps each in IndexedDB; a retry starts from the first missing
  piece. Pieces are joined, checked and decrypted as before (ADR-0024).
- **Across reloads:** uploads and downloads in progress are recorded in the
  client's sealed state and resume on the next connection.
- **Auto-download** (per device; Media settings):
  - photos, and voice notes and audio, by default always;
  - videos only when not on mobile data;
  - other files when opened.
  - "Not on mobile data" uses the Network Information API where the browser
    has it (Chromium; `type === 'cellular'` or `saveData`). Browsers that
    don't say are treated as not on mobile data.
  - Downloaded photos show full size without a tap.
- **Photo quality:** "standard" fits 2560 px at JPEG quality 0.85; "high"
  fits 4096 px at 0.92. Re-drawing (and so metadata removal) applies to
  both.

## Consequences
- The server learns nothing new: sizes were already visible, and part
  boundaries are fixed.
- Two transfer paths on the server (single `PUT` and sessions) and one more
  table. Blobs record their part count so expiry deletes every part.
- Downloads keep pieces on the device until joined: a 100 MB file briefly
  needs about twice its size in browser storage.
- Settings are per device and not synced between linked devices. Syncing
  can come with the rest of the settings.
- Firefox and Safari don't expose the connection type, so "not on mobile
  data" means "always" there.

## Validation
- **Server tests:**
  - parts in any order and repeated;
  - wrong sizes, unknown parts and other devices refused;
  - completion waits for every part;
  - ranges across part boundaries, open-ended and clamped, and `416`;
  - expiry of parted blobs and abandoned sessions;
  - the quota is charged up front.
- **Browser test (Chromium, which can intercept worker requests):**
  - a 20 MB upload whose second part fails resumes without re-sending the
    first;
  - a download whose third range fails resumes from there;
  - both files arrive byte for byte.
- **Browser test (all engines):** photos download by themselves, and stop
  when turned off.
