# Cluster prerequisites

The `deploy/helm/chat` chart installs only our own components (server, web).
Install these first; full walkthrough in
[docs/10-deployment-kubernetes.md](../../docs/10-deployment-kubernetes.md).

| Component | How | File |
|-----------|-----|------|
| TLS certificates | cert-manager + Let's Encrypt | `cluster-issuer.yaml` |
| PostgreSQL | CloudNativePG operator | `postgres-cluster.yaml` |
| Group calls (SFU) | LiveKit Helm chart | `livekit-values.yaml` |
| Call relay (TURN) | coturn, in this chart (`turn.enabled`) | `deploy/k3s/README.md` |
| Object storage | Managed S3 in a US region, or SeaweedFS | — (needed from Phase 2) |
| Valkey | Not needed until presence/rate limiting land | — |

```sh
kubectl create namespace chat
kubectl apply -f deploy/k8s/cluster-issuer.yaml
kubectl apply -n chat -f deploy/k8s/postgres-cluster.yaml
helm upgrade --install chat deploy/helm/chat -n chat --set host=chat.example.com
```
