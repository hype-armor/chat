# ADR-0014: Run on Kubernetes, hosted in the United States

- **Status:** Accepted
- **Date:** 2026-10-29
- **Related requirements:** NFR-OPS-2, NFR-OPS-4, NFR-SCALE-*

## Context
Stakeholders chose Kubernetes as the runtime platform and the USA as the
hosting jurisdiction. Launch scale is 100 users.

## Options considered
1. **Kubernetes with a Helm chart for our components; datastores via operators** — standard, portable, self-hosters can reuse it.
2. **Kubernetes with all dependencies bundled as subcharts** — one install command, but couples our releases to third-party chart versions.
3. **Docker Compose on a VM** — simplest; rejected by stakeholders for production.

## Decision
Option 1. `deploy/helm/chat` deploys the server and web client; PostgreSQL
via CloudNativePG, LiveKit via its own chart, TLS via cert-manager. Docker
Compose stays for local development. Single US region at launch.

## Consequences
The cluster needs UDP reachability for LiveKit (host networking).
Migrations move to a Helm hook before scaling the server beyond one replica.
The US legal environment applies (doc 10 §6).

## Validation
`helm lint` in CI; first deployment to a US cluster in Phase 1 passes the
end-to-end tests against the live URL.
