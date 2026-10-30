# ADR-0023: Attachments stream through the server

- **Status:** Accepted
- **Date:** 2026-10-29
- **Deciders:** project owner, Claude
- **Related requirements:** FR-MED-2, FR-MED-3, NFR-SEC (strict CSP, no third-party origins)

## Context
Docs 03 and 05 planned pre-signed URLs: clients upload and download
encrypted attachments directly to object storage. The web client must not
talk to any origin but its own (CLAUDE.md, CSP `connect-src 'self'`).
Pre-signed URLs point at the storage host (SeaweedFS, Linode Object Storage,
S3), so they would need that host in the CSP, or the ingress to expose the
storage under the app's origin with its own auth.

## Options considered
1. **Pre-signed URLs to the storage host.** No server bandwidth, but
   another origin in the CSP, and storage reachable from the internet.
2. **Pre-signed URLs through an ingress path** (`/blobs/…` → SeaweedFS).
   Same origin, but couples the chart to one storage product, and the
   storage still faces the internet.
3. **The server streams bytes to and from the store.** Same origin and the
   same token auth as everything else. Storage stays private. Costs server
   bandwidth.

## Decision
Option 3, for the 100-user launch.
- `PUT /v1/blobs` streams the body in 8 MB parts to the store, enforcing
  `Content-Length`, the 100 MB limit (FR-MED-3) and a per-device daily
  quota.
- `GET /v1/blobs/{id}` streams it back.
- The store is any `object_store` backend: `s3://bucket` (SeaweedFS on k3s,
  Linode Object Storage, AWS), `file:///path`, or `memory` for
  development.
- Blobs expire after 30 days (doc 05).

## Consequences
- **Bandwidth:** upload and download bandwidth goes through the server pods:
  about 3 GB a day for 100 users each sending 10 photos of 3 MB. Revisit
  (option 2 with a CDN) when that matters.
- **Resumable transfers** (Phase 2 item 6) need a chunked protocol on these
  endpoints rather than S3 multipart from the client.
- **Doc 05 §1 step 4** (pre-signed URL) is superseded.
