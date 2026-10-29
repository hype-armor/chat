# Self-hosting on k3s

Single-node k3s in the USA (ADR-0015). Commands below are the intended
procedure; run them on a fresh Linux host (Ubuntu 24.04 LTS or Debian 13,
4 vCPU / 8 GB RAM / 100 GB+ SSD).

## 0. Network prerequisites

| Port | Protocol | Purpose |
|------|----------|---------|
| 80, 443 | TCP | Web app, API, WebSocket, ACME certificate challenge |
| 7881 | TCP | LiveKit media fallback over TCP |
| 3478 | UDP | TURN |
| 5349 | TCP | TURN over TLS |
| 50000–60000 | UDP | LiveKit WebRTC media |
| 6443 | TCP | Kubernetes API — **do not expose publicly**; reach it over SSH or a VPN |

DNS: point `chat.example.com`, `rtc.chat.example.com` and
`turn.chat.example.com` at the host's public IP.

## 1. Install k3s

```sh
curl -sfL https://get.k3s.io | sh -s - \
  --write-kubeconfig-mode 600 \
  --secrets-encryption
sudo cp deploy/k3s/traefik-config.yaml /var/lib/rancher/k3s/server/manifests/
export KUBECONFIG=/etc/rancher/k3s/k3s.yaml
```

k3s includes Traefik (ingress), ServiceLB (binds 80/443 on the host),
local-path storage, and NetworkPolicy enforcement, so nothing else is
needed for those.

## 2. Cluster add-ons

```sh
# cert-manager (TLS from Let's Encrypt)
helm repo add jetstack https://charts.jetstack.io
helm upgrade --install cert-manager jetstack/cert-manager -n cert-manager \
  --create-namespace --set crds.enabled=true
kubectl apply -f deploy/k8s/cluster-issuer.yaml   # edit the email first

# CloudNativePG operator (PostgreSQL)
helm repo add cnpg https://cloudnative-pg.github.io/charts
helm upgrade --install cnpg cnpg/cloudnative-pg -n cnpg-system --create-namespace
```

`deploy/k8s/cluster-issuer.yaml` solves challenges through Traefik.

## 3. Database and app

```sh
kubectl create namespace chat
kubectl apply -n chat -f deploy/k8s/postgres-cluster.yaml
helm upgrade --install chat deploy/helm/chat -n chat \
  -f deploy/helm/chat/values-k3s.yaml --set host=chat.example.com --atomic
```

## 4. Calls (Phase 3)

```sh
helm repo add livekit https://helm.livekit.io
helm upgrade --install livekit livekit/livekit-server -n chat \
  -f deploy/k8s/livekit-values.yaml
```

## 5. Backups — required on a single machine

One host means one disk. Configure CloudNativePG WAL archiving and base
backups (see the commented block in `deploy/k8s/postgres-cluster.yaml`) to
S3-compatible storage **in another location**, e.g. a Backblaze B2 or
Wasabi bucket in a US region. Also keep a copy of the k3s server token
(`/var/lib/rancher/k3s/server/token`) and your Helm values off the host.
Test a restore before launch.

## 6. Hardening checklist

- Host firewall (ufw/nftables) allowing only the ports in §0, SSH by key only.
- Unattended security upgrades for the OS; upgrade k3s with the
  system-upgrade-controller or `curl -sfL https://get.k3s.io | sh -`
  pinned to a release channel.
- Full-disk encryption if the hardware is physically accessible to others.
