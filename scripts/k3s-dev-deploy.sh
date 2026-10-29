#!/usr/bin/env bash
# Builds the server and web images, imports them into the local k3s
# containerd, and installs/updates the chart with dev values.
#
# Run on the k3s host (needs docker, helm, sudo for `k3s ctr`), with
# KUBECONFIG pointing at the cluster. Prerequisites from deploy/k3s/README.md
# (cert-manager, CloudNativePG, dev-ca.yaml, postgres-cluster.yaml) must be
# installed once beforehand.
set -euo pipefail
cd "$(dirname "$0")/.."

namespace="${CHAT_NAMESPACE:-chat}"

for image in server web; do
  docker build -f "deploy/docker/$image.Dockerfile" -t "ghcr.io/hype-armor/chat-$image:dev" .
  docker save "ghcr.io/hype-armor/chat-$image:dev" | sudo k3s ctr images import -
done

helm upgrade --install chat deploy/helm/chat -n "$namespace" --create-namespace \
  -f deploy/helm/chat/values-k3s.yaml -f deploy/helm/chat/values-dev.yaml "$@"

# Same tag every build: force pods to pick up the newly imported images.
kubectl -n "$namespace" rollout restart deployment -l app.kubernetes.io/instance=chat
kubectl -n "$namespace" rollout status deployment -l app.kubernetes.io/instance=chat --timeout=120s
