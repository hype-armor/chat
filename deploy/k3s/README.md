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

### Continuous deployment (ADR-0018)

Every merge to `main` publishes `ghcr.io/hype-armor/chat-{server,web}:sha-<commit>`
(Images workflow). A systemd timer on the k3s host deploys the newest
published commit every 5 minutes; nothing outside the LAN needs to reach the
cluster. Set it up once:

```sh
sudo useradd --create-home --shell /usr/sbin/nologin chat-deploy
sudo -u chat-deploy git clone https://github.com/hype-armor/chat /home/chat-deploy/chat
sudo install -d -o chat-deploy -m 700 /home/chat-deploy/.kube
sudo install -o chat-deploy -m 600 /etc/rancher/k3s/k3s.yaml /home/chat-deploy/.kube/config
sudo cp /home/chat-deploy/chat/deploy/k3s/chat-dev-update.{service,timer} /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now chat-dev-update.timer
journalctl -u chat-dev-update -f     # "<commit>: deployed"
```

Needs `git`, `curl` and `helm` on the host. The clone is checked out at
each deployed commit, so don't edit it; use another checkout and
`scripts/k3s-dev-deploy.sh` to try local changes (the next new commit on
`main` replaces them). `--atomic` rolls a release back if its pods don't
become ready; the timer tries again only when `main` moves, or run
`sudo -u chat-deploy KUBECONFIG=/home/chat-deploy/.kube/config
/home/chat-deploy/chat/scripts/k3s-dev-update.sh --force`.

## Production
 Commands below are the intended
procedure; run them on a fresh Linux host (Ubuntu 24.04 LTS or Debian 13,
4 vCPU / 8 GB RAM / 100 GB+ SSD).

## 0. Network prerequisites

| Port | Protocol | Purpose |
|------|----------|---------|
| 80, 443 | TCP | Web app, API, WebSocket, ACME certificate challenge |
| 7881 | TCP | LiveKit media fallback over TCP |
| 3478 | UDP + TCP | TURN (coturn) |
| 5349 | TCP | TURN over TLS (coturn) |
| 49152–49999 | UDP | TURN relayed media (coturn) |
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
# Sign-up is invite-only (ADR-0021): create the first invite, open the
# printed link and sign up; invite everyone else from the app.
kubectl -n chat exec deploy/chat-server -- chat-server create-invite https://chat.example.com
```

### Call relay: coturn (ADR-0029)

1:1 calls connect directly when they can; otherwise, and always for people
who turn on "Always relay calls", media goes through coturn. It runs with
host networking on the ports above. The server and coturn share one
secret; clients get 12-hour credentials from `GET /v1/turn`.

```sh
kubectl -n chat create secret generic chat-turn \
  --from-literal=static-auth-secret="$(openssl rand -hex 32)"
helm upgrade chat deploy/helm/chat -n chat --reuse-values \
  --set turn.enabled=true --set turn.host=turn.chat.example.com
# Behind NAT (e.g. a cloud floating IP): --set turn.externalIp=<public IP>
```

cert-manager issues the TURN-over-TLS certificate (`turn.tls.issuer`).
coturn keeps no logs by default, since they would name both callers' IP
addresses; `--set turn.logs=true` while debugging.

### Attachments and backups: SeaweedFS (ADR-0005, ADR-0023)

SeaweedFS runs in the cluster as the S3-compatible store (MinIO's community
edition is no longer maintained). One access key, used only by the chat
server:

```sh
KEY=chat SECRET="$(openssl rand -hex 24)"
kubectl -n chat create secret generic seaweedfs-s3 --from-literal=s3.json="$(cat <<JSON
{"identities":[{"name":"chat","credentials":[{"accessKey":"$KEY","secretKey":"$SECRET"}],
  "actions":["Read","Write","List","Tagging"]}]}
JSON
)"
kubectl -n chat create secret generic chat-blobs \
  --from-literal=AWS_ACCESS_KEY_ID="$KEY" --from-literal=AWS_SECRET_ACCESS_KEY="$SECRET"
kubectl apply -n chat -f deploy/k8s/seaweedfs.yaml
kubectl -n chat rollout status deploy/seaweedfs
kubectl -n chat exec deploy/seaweedfs -- sh -c 'echo "s3.bucket.create -name chat-blobs" | weed shell'
helm upgrade chat deploy/helm/chat -n chat --reuse-values \
  --set server.blobs.bucket=chat-blobs \
  --set server.blobs.endpoint=http://seaweedfs.chat.svc:8333 \
  --set server.blobs.existingSecret=chat-blobs
```

SeaweedFS stays inside the cluster (its NetworkPolicy admits only the chat
server); the server streams attachments and backups to it. The store holds
only ciphertext. Include the `seaweedfs` volume in the off-site backups (§5).

### Map tiles (ADR-0026)

Locations show on a map only once the server has a basemap: one
[Protomaps](https://docs.protomaps.com/) PMTiles file, served by the web pod
from `/tiles/basemap.pmtiles`. Without it, locations show as coordinates.
Cut out the region you need with the `pmtiles` CLI, run on the host:

```sh
# A US-wide extract to zoom 15 is roughly 10–20 GB; a metro area is far smaller.
pmtiles extract https://build.protomaps.com/$(date -u -d '-1 day' +%Y%m%d).pmtiles \
  /srv/chat-tiles/basemap.pmtiles --bbox=-125,24,-66,50 --maxzoom=15
helm upgrade chat deploy/helm/chat -n chat --reuse-values \
  --set web.tiles.hostPath=/srv/chat-tiles
```

Phones never contact Protomaps: the file is downloaded once here, and the
app reads map data only from this server. Refresh it every few months.

## 4. Calls (Phase 3)

Group calls go through LiveKit (ADR-0031). One API key pair, shared by
LiveKit and the chat server, which hands out room tokens to members:

```sh
KEY=chat SECRET="$(openssl rand -hex 32)"
kubectl -n chat create secret generic chat-livekit \
  --from-literal=api-key="$KEY" --from-literal=api-secret="$SECRET"
helm repo add livekit https://helm.livekit.io
helm upgrade --install livekit livekit/livekit-server -n chat \
  -f deploy/k8s/livekit-values.yaml --set "livekit.keys.$KEY=$SECRET"
helm upgrade chat deploy/helm/chat -n chat --reuse-values \
  --set livekit.url=wss://rtc.chat.example.com \
  --set livekit.apiUrl=http://livekit-livekit-server.chat.svc:80 \
  --set web.cspConnectExtra=wss://rtc.chat.example.com
```

Check the service name with `kubectl -n chat get svc`. Media is
SFrame-encrypted in the browsers; LiveKit forwards frames it can't read.

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
