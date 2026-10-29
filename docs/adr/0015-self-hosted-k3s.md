# ADR-0015: Self-host on single-node k3s

- **Status:** Accepted
- **Date:** 2026-10-29
- **Related requirements:** NFR-OPS-4, NFR-SCALE-1
- **Refines:** ADR-0014 (Kubernetes, US-hosted)

## Context
The 100-user launch needs one node. Managed Kubernetes costs $65–450/month
(doc 10 §2.1). Stakeholders chose to self-host.

## Options considered
1. **k3s, single node** — lightweight certified Kubernetes; bundles ingress (Traefik), a service load balancer, local storage and NetworkPolicy enforcement.
2. **kubeadm / full upstream Kubernetes** — more moving parts for no gain at this size.
3. **MicroK8s / Talos** — viable, smaller community for single-node self-hosting (MicroK8s) or a steeper start (Talos).

## Decision
k3s for **development and initial testing** now (2026-10-29), on a
self-hosted machine. The production host stays open: self-hosted k3s, or
Linode (k3s on a Linode VM, ~$29–34/month for 30 users on the 4 GB plan,
~$65 for 100 users on 8 GB; or managed LKE). Whichever is chosen runs the
same chart.

k3s on one Linux host (US for production), using its bundled Traefik, ServiceLB and
local-path storage. The Helm chart is unchanged; `values-k3s.yaml` adapts
it. Setup steps: `deploy/k3s/README.md`.

## Consequences
- Single point of failure: hardware, disk or network loss takes the
  service down. Off-site PostgreSQL backups are mandatory, and restores
  must be tested.
- We run Kubernetes upgrades, OS patching and monitoring ourselves.
- Object storage (Phase 2) runs in-cluster (SeaweedFS) or as an external
  S3-compatible bucket.
- Growth path: add k3s agent nodes, or move the same chart to managed
  Kubernetes, without application changes.

## Validation
A fresh host reaches a working deployment by following
`deploy/k3s/README.md`; a backup restore drill succeeds before launch.
