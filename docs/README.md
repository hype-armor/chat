# Design Documentation

Planning documents for the chat service: a web/PWA-first, fully open-source,
end-to-end encrypted messenger. Technology choices are recorded as
Architecture Decision Records (ADRs) under [`adr/`](adr/).

| # | Document | Purpose |
|---|----------|---------|
| 01 | [Vision & Scope](01-vision-and-scope.md) | What we are building, for whom, and what is out of scope |
| 02 | [Requirements](02-requirements.md) | Functional and non-functional requirements with IDs and priorities |
| 03 | [System Architecture](03-architecture.md) | Technology-agnostic component model and data flows |
| 04 | [Security & Cryptography](04-security-and-cryptography.md) | Threat model and end-to-end encryption design |
| 05 | [Media & Calling](05-media-and-calling.md) | Attachments, 1:1 and group voice/video |
| 06 | [Location Sharing](06-location-sharing.md) | One-shot and live location |
| 07 | [Offline / Serverless Mode](07-offline-mesh.md) | Local-network mode (web) and Bluetooth/Wi-Fi mesh (native) |
| 08 | [Technology Stack](08-technology-stack.md) | Chosen technologies and why |
| 09 | [Roadmap & Open Questions](09-roadmap-and-open-questions.md) | Phasing, milestones, and decisions we need from stakeholders |
| 10 | [Deployment: Kubernetes](10-deployment-kubernetes.md) | Cluster layout, security baseline, US hosting notes |
| 11 | [Server API](11-api.md) | REST endpoints and WebSocket protocol |
| 12 | [Performance](12-performance.md) | Delivery latency load test, results and server metrics |
| — | [ADR index](adr/README.md) | Decision log |

## Conventions

- Requirement IDs: `FR-<AREA>-<n>` (functional), `NFR-<AREA>-<n>` (non-functional).
- Priority uses MoSCoW: **M**ust, **S**hould, **C**ould, **W**on't (this release).
- Statements marked **[ASSUMPTION]** are placeholders we picked to make the
  design concrete; they need confirmation and are collected in doc 09.
- Each doc has a status line: `Draft` → `In review` → `Accepted`.
