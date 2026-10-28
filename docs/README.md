# Design Documentation

Planning documents for the chat service. Nothing here is final: every
technology choice is still open and is tracked as an Architecture Decision
Record (ADR) under [`adr/`](adr/).

| # | Document | Purpose |
|---|----------|---------|
| 01 | [Vision & Scope](01-vision-and-scope.md) | What we are building, for whom, and what is out of scope |
| 02 | [Requirements](02-requirements.md) | Functional and non-functional requirements with IDs and priorities |
| 03 | [System Architecture](03-architecture.md) | Technology-agnostic component model and data flows |
| 04 | [Security & Cryptography](04-security-and-cryptography.md) | Threat model and end-to-end encryption design |
| 05 | [Media & Calling](05-media-and-calling.md) | Attachments, 1:1 and group voice/video |
| 06 | [Location Sharing](06-location-sharing.md) | One-shot and live location |
| 07 | [Offline / Serverless Mode](07-offline-mesh.md) | Bluetooth and Wi-Fi peer-to-peer messaging |
| 08 | [Technology Options](08-technology-options.md) | Candidate stacks and evaluation criteria |
| 09 | [Roadmap & Open Questions](09-roadmap-and-open-questions.md) | Phasing, milestones, and decisions we need from stakeholders |
| — | [ADR index](adr/README.md) | Decision log |

## Conventions

- Requirement IDs: `FR-<AREA>-<n>` (functional), `NFR-<AREA>-<n>` (non-functional).
- Priority uses MoSCoW: **M**ust, **S**hould, **C**ould, **W**on't (this release).
- Statements marked **[ASSUMPTION]** are placeholders we picked to make the
  design concrete; they need confirmation and are collected in doc 09.
- Each doc has a status line: `Draft` → `In review` → `Accepted`.
