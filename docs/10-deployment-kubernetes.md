# 10 — Deployment: Kubernetes, US-hosted

**Status:** Draft. Decision: ADR-0014.

## 1. Decisions

| Topic | Decision |
|-------|----------|
| Platform | Kubernetes for production; Docker Compose for local development only |
| Region | United States (single region at launch) |
| Packaging | Helm chart `deploy/helm/chat` for our components; operators/charts for datastores |
| Images | `ghcr.io/hype-armor/chat-server`, `ghcr.io/hype-armor/chat-web`, built by `.github/workflows/images.yml` |

## 2. Cluster choice

Any conformant cluster works. For a 100-user launch:

| Option | Fit |
|--------|-----|
| Managed Kubernetes in a US region (EKS, GKE, AKS, DigitalOcean DOKS, Linode LKE, Vultr VKE) | Least operations work; control plane managed. Pick a provider with cheap egress, since call media dominates bandwidth |
| k3s on one or two US VMs | Cheapest; we own upgrades and backups |

Requirements for any option: public IPv4 with **UDP** reachable on the
LiveKit node (WebRTC media); a LoadBalancer or hostPort path for HTTPS;
persistent volumes for PostgreSQL.

Starting size: **1 node, 4 vCPU / 8 GB**, matching doc 09 §5. A second node
later lets LiveKit run on its own host-networked node.

## 3. Layout

```
namespace: chat
├── chat-web      Deployment (nginx, static PWA, strict CSP)      ─┐ Ingress or
├── chat-server   Deployment (Rust, WebSocket /v1/ws)              ─┘ Gateway API
├── chat-db       CloudNativePG Cluster (PostgreSQL 18)
└── livekit       LiveKit SFU + TURN (host networking, UDP 50000-60000)
cluster-wide: cert-manager, ingress/gateway controller, CloudNativePG operator
```

- **Ingress controller:** any. The chart supports classic Ingress and
  Gateway API `HTTPRoute`. Gateway API is the preferred long-term path
  (the community ingress-nginx project has been retired); Traefik, Envoy
  Gateway or a cloud provider's gateway are all fine. Set idle timeouts
  ≥ 1 hour so client WebSockets aren't cut.
- **TLS:** cert-manager with Let's Encrypt (`deploy/k8s/cluster-issuer.yaml`).
- **PostgreSQL:** CloudNativePG (`deploy/k8s/postgres-cluster.yaml`); its
  generated `chat-db-app` secret supplies `DATABASE_URL`. 1 instance at
  launch, 3 for high availability later; WAL archiving to object storage.
- **Calls:** LiveKit's Helm chart (`deploy/k8s/livekit-values.yaml`), plus
  coturn for 1:1 call relays from Phase 3.
- **Object storage (Phase 2):** managed S3-compatible storage in a US
  region, or SeaweedFS in-cluster for full self-hosting.
- **Valkey:** added when presence and rate limiting land.

## 4. Security baseline

- Pods run as non-root with a read-only root filesystem, all capabilities
  dropped, seccomp `RuntimeDefault`, and no service-account token mounted.
- NetworkPolicy: only the ingress controller's namespace may reach our pods.
- Secrets (database URL, LiveKit keys, VAPID key, SMS provider key) come from
  Kubernetes Secrets populated by a secret manager (External Secrets
  Operator or SOPS-encrypted manifests); never committed in plain text.
- Logs contain no message content, phone numbers or IP addresses beyond
  what's needed to debug (NFR-OPS-1); log retention ≤ 14 days.
- Images are rebuilt from pinned, reproducible sources and published by CI
  (supports the release transparency log in Phase 5).

## 5. Rollout

- `helm upgrade --install` with `--atomic`. The server shuts down
  gracefully on SIGTERM (30 s grace period) so WebSockets reconnect to new
  pods.
- Database migrations run at server start (embedded `sqlx` migrations).
  Before running more than one server replica, move them to a pre-upgrade
  Helm hook Job.
- Web releases are content-hashed. The installed service worker keeps
  serving the pinned version until the update gate approves the new one
  (doc 04 §9).

## 6. US hosting: legal and operational notes

Not legal advice; review with counsel before launch.

| Topic | Implication |
|-------|-------------|
| Legal process (subpoenas, court orders, CLOUD Act) | Can compel only what we hold: account phone numbers, device public keys, push subscriptions, coarse last-seen day, queued ciphertext, and logs. Minimising these (NFR-SEC-5) limits exposure. Publish a transparency report |
| SMS to US numbers | Application-to-person (A2P) SMS needs 10DLC registration or a verified toll-free number; providers' verification APIs (e.g., Twilio Verify) handle this |
| State privacy laws (CCPA/CPRA and similar) | Access, deletion and disclosure duties for server-held personal data (NFR-LEG-1) |
| Children (COPPA) | Set a minimum age (13+) in the terms of service; don't knowingly collect data from younger users |
| Encryption export (EAR) | Publicly available open-source encryption is generally outside EAR controls; confirm the classification (and any notification needed) with counsel |
| Abuse reporting | Respond to reports and legal duties within E2EE limits (doc 04 §6) |
