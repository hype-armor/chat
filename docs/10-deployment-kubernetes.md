# 10 — Deployment: Kubernetes, US-hosted

**Status:** Draft. Decisions: ADR-0014 (Kubernetes, USA), ADR-0015 (self-hosted k3s).

## 1. Decisions

| Topic | Decision |
|-------|----------|
| Platform | Kubernetes for production — **self-hosted single-node k3s** (ADR-0015); Docker Compose for local development only |
| Region | United States (single region at launch) |
| Packaging | Helm chart `deploy/helm/chat` for our components; operators/charts for datastores |
| Images | `ghcr.io/hype-armor/chat-server`, `ghcr.io/hype-armor/chat-web`, built by `.github/workflows/images.yml` |

## 2. Cluster choice

**Decided: self-hosted k3s** — setup guide in
[`deploy/k3s/README.md`](../deploy/k3s/README.md). The chart still runs on
any conformant cluster; the options considered were:

| Option | Fit |
|--------|-----|
| Managed Kubernetes in a US region (EKS, GKE, AKS, DigitalOcean DOKS, Linode LKE, Vultr VKE) | Least operations work; control plane managed. Pick a provider with cheap egress, since call media dominates bandwidth |
| k3s on one or two US VMs | Cheapest; we own upgrades and backups |

Requirements for any option: public IPv4 with **UDP** reachable on the
LiveKit node (WebRTC media); a LoadBalancer or hostPort path for HTTPS;
persistent volumes for PostgreSQL.

Starting size: **1 node, 4 vCPU / 8 GB**, matching doc 09 §5. A second node
later lets LiveKit run on its own host-networked node.

### 2.0 Self-hosting considerations

| Where the k3s host runs | Watch out for |
|-------------------------|---------------|
| Rented VM / dedicated server in a US data centre | Included traffic and overage price; UDP allowed; static IPv4 |
| Own hardware (home or office) | ISP terms often forbid servers on residential plans; need a static IP or dynamic DNS; router port-forwarding for TCP 80/443/7881/5349 and UDP 3478 + 50000–60000; **upload bandwidth** (group calls send each participant's streams out: ~1.5 Mbps per receiving participant, so a 10-person call needs ~15 Mbps up); UPS for power cuts |

Either way: off-site backups (deploy/k3s/README.md §5) and a host
firewall are mandatory.

### 2.1 Cost estimate for the 100-user launch (list prices, Oct 2026)

**Bandwidth assumption** (monthly data sent out of the cluster): text and
push ≈ 10 GB; attachments 50–400 GB; group-call media through LiveKit at
~0.55 GB per participant-hour received (1:1 calls are mostly peer-to-peer).

| Usage | Group-call hours per user / month | Outbound total |
|-------|-----------------------------------|----------------|
| Light | 2 | ~0.2 TB |
| Typical | 10 | ~0.8 TB |
| Heavy | 30 | ~2.5 TB |

**Baseline resources:** one 4 vCPU / 8 GB node, one load balancer, ~20 GB
block storage (PostgreSQL), ~100 GB object storage (attachments, backups,
regional map tiles).

| Provider | Control plane | Node | LB + storage + IPs | Egress | **Light** | **Typical** | **Heavy** |
|----------|--------------|------|--------------------|--------|-----------|-------------|-----------|
| Akamai/Linode LKE | free (HA +$60) | $48 (5 TB incl.) | ~$17 | included | **~$65** | **~$65** | **~$65** |
| DigitalOcean DOKS | free | $48 (5 TB incl.) | ~$19 | included | **~$67** | **~$67** | **~$67** |
| Vultr VKE | free | $40–48 (4–6 TB incl.) | ~$17 | included | **~$57–65** | **~$57–65** | **~$57–65** |
| k3s on Hetzner US (self-run) | you run it | ~$72 (CPX31, after June 2026 increase) | ~$10 | small allowance in US; verify | **~$85+** | **~$85+** | **verify** |
| Google GKE (zonal) | free tier credit | ~$81 (e2 custom 4/8) | ~$25 | $0.12→0.11/GiB | **~$130** | **~$205** | **~$395** |
| Azure AKS (Free tier) | $0 (Standard SLA +$73) | ~$124 (F4s v2) | ~$27 | $0.087/GB after 100 GB | **~$160** | **~$212** | **~$360** |
| AWS EKS | $73 | ~$130 (c7i.xlarge) | ~$31 | $0.09/GB after 100 GB | **~$245** | **~$300** | **~$450** |

Not included, common to all: SMS verification (≈ $5–10/month at 100
users), domain, and the external security audit (Phase 5, one-off and by
far the largest cost).

**Recommendation:** Akamai LKE or DigitalOcean DOKS. Both have US regions,
a free control plane, and enough included egress to cover even heavy call
usage, so the bill stays flat at about $65/month. Hyperscalers cost 2–7×
more, mostly from the control-plane fee and per-GB egress on call media;
they only make sense with startup credits. Prices moved sharply in 2026
(memory costs), so re-check before signing up.

## 3. Layout

On k3s, the ingress controller is the bundled Traefik (in `kube-system`),
ServiceLB exposes it on host ports 80/443, and PVCs use the local-path
provisioner.

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
