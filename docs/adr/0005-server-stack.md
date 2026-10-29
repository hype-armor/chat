# ADR-0005: Server: Rust modular monolith, PostgreSQL, Valkey, S3, Web Push

- **Status:** Accepted
- **Date:** 2026-10-28
- **Related requirements:** NFR-SCALE-*, NFR-OPS-4

## Context
The server routes ciphertext, holds queues and key packages, and must be easy to self-host.

## Options considered
1. **Rust (tokio/axum)**: shares protocol types with the core; efficient with many WebSockets.
2. **Go**: simple and fast, but types would be duplicated across languages.
3. **Elixir**: excellent for connections; a third language in the project.
4. **Microservices from day one**: harder to self-host, unnecessary at this scale.

## Decision
A single Rust binary with internal modules (gateway, accounts, contact lookup, keys, delivery, group epochs, blobs, push, call signalling). PostgreSQL for durable state and the delivery queue; Valkey for presence and rate limits; S3-compatible storage for blobs (MinIO when self-hosting); Web Push via VAPID. WebSocket transport with Protobuf frames.

## Consequences
Modules must keep clean boundaries so they can be split into services later. Each server instance needs a shared connection registry (Valkey pub/sub).

## Validation
Load test on the launch server: 1,000 concurrent WebSockets and 100 msgs/s (10× launch headroom), with delivery p95 < 1 s.
