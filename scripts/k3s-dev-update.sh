#!/usr/bin/env bash
# Continuous deployment for the dev k3s cluster (ADR-0018). Runs on the k3s
# host from deploy/k3s/chat-dev-update.timer, in a clone of the repository
# used only for this: deploys the newest commit on main once the Images
# workflow has published both images for it to GHCR. --atomic rolls a
# release back if its pods do not become ready.
#
# Usage: scripts/k3s-dev-update.sh [--force] [extra helm arguments]
# Env: CHAT_NAMESPACE (chat), CHAT_BRANCH (main), KUBECONFIG.
set -euo pipefail

# Everything runs inside main(): bash reads a script as it executes, and the
# checkout below replaces this file.
main() {
  cd "$(dirname "$0")/.."
  local namespace="${CHAT_NAMESPACE:-chat}"
  local branch="${CHAT_BRANCH:-main}"
  local state="${STATE_DIRECTORY:-${XDG_STATE_HOME:-$HOME/.local/state}/chat-dev-update}"
  local force=false
  if [[ "${1:-}" == --force ]]; then
    force=true
    shift
  fi
  mkdir -p "$state"

  git fetch -q origin "$branch"
  local sha tag
  sha="$(git rev-parse --short=7 "origin/$branch")"
  tag="sha-$sha"
  if [[ $force == false && "$(cat "$state/deployed" 2>/dev/null)" == "$sha" ]]; then
    exit 0
  fi
  for image in server web; do
    if ! published "chat-$image" "$tag"; then
      echo "$sha: waiting for the $image image"
      exit 0
    fi
  done

  # The chart comes from the same commit as the images.
  git checkout -q --detach "origin/$branch"
  echo "$sha: deploying"
  helm upgrade --install chat deploy/helm/chat -n "$namespace" --create-namespace \
    -f deploy/helm/chat/values-k3s.yaml -f deploy/helm/chat/values-dev.yaml \
    --set server.image.tag="$tag" --set server.image.pullPolicy=IfNotPresent \
    --set web.image.tag="$tag" --set web.image.pullPolicy=IfNotPresent \
    --atomic --wait --timeout 5m "$@"
  echo "$sha" >"$state/deployed"
  echo "$sha: deployed"
}

# Whether ghcr.io has the image tag (the packages are public).
published() {
  local repo token
  repo="hype-armor/$1"
  token="$(curl -fsS "https://ghcr.io/token?scope=repository:$repo:pull" |
    sed -n 's/.*"token":"\([^"]*\)".*/\1/p')"
  curl -fs -o /dev/null --head \
    -H "Authorization: Bearer $token" \
    -H "Accept: application/vnd.oci.image.index.v1+json" \
    -H "Accept: application/vnd.docker.distribution.manifest.list.v2+json" \
    -H "Accept: application/vnd.oci.image.manifest.v1+json" \
    -H "Accept: application/vnd.docker.distribution.manifest.v2+json" \
    "https://ghcr.io/v2/$repo/manifests/$2"
}

main "$@"
