# Self-hosting on k3s

Single-node k3s (ADR-0015). Used first for **development and initial
testing**; the production host is still open (k3s on your own hardware or
on a Linode VM — doc 10 §2).

## Development / test cluster

Follow §1–§3 below with these differences:

1. No public domain needed: apply `deploy/k3s/dev-ca.yaml` instead of
   `deploy/k8s/cluster-issuer.yaml`, and point `chat.test` (and
   `rtc.chat.test`) at the host's LAN IP in your router's DNS or each
   device's hosts file.
2. Trust the dev CA's root certificate on every test phone and browser
   (command in `dev-ca.yaml`). Without it, the service worker, camera and
   WebRTC won't work on other devices.
3. Build and deploy local code with `scripts/k3s-dev-deploy.sh` instead of
   the `helm upgrade` in §3. It imports images straight into k3s, so no
   registry is needed.
4. Ports only need to be reachable on the LAN; skip the router port
   forwarding and §5 backups until real users arrive.

Alternative to a private CA: a real domain with cert-manager's DNS-01
challenge gives publicly trusted certificates without opening any ports.

## Production
 Commands below are the intended
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
# Web Push key (keep it stable: changing it invalidates subscriptions)
kubectl -n chat create secret generic chat-vapid \
  --from-literal=private-key="$(docker run --rm ghcr.io/hype-armor/chat-server:dev generate-vapid-key | sed -n 's/^CHAT_VAPID_PRIVATE_KEY=//p')"
kubectl apply -n chat -f deploy/k8s/postgres-cluster.yaml
helm upgrade --install chat deploy/helm/chat -n chat \
  -f deploy/helm/chat/values-k3s.yaml --set host=chat.example.com \
  --set server.vapid.existingSecret=chat-vapid --atomic
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
