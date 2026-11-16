#!/usr/bin/env bash
# Restore Web Push after a Compose deployment started without a persistent
# CHAT_VAPID_PRIVATE_KEY. Run this only when the existing VAPID key is absent.
set -euo pipefail

repo=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
cd -- "$repo"

compose=(sudo docker compose -f deploy/compose/docker-compose.yml)
env_file=.env

if [[ -f $env_file ]] && grep -q '^CHAT_VAPID_PRIVATE_KEY=.' "$env_file"; then
  printf 'Refusing to replace the existing CHAT_VAPID_PRIVATE_KEY in %s.\n' "$env_file" >&2
  printf 'Keep the existing key. Replacing it invalidates active push subscriptions.\n' >&2
  exit 1
fi

umask 077
key=$("${compose[@]}" run --rm --no-deps server generate-vapid-key |
  awk -F= '/^CHAT_VAPID_PRIVATE_KEY=/{print $2}')
if [[ -z $key ]]; then
  printf 'Could not generate a VAPID key. The server container did not return one.\n' >&2
  exit 1
fi

backup=
if [[ -f $env_file ]]; then
  backup="${env_file}.before-vapid.$(date +%Y%m%d%H%M%S)"
  cp -p -- "$env_file" "$backup"
fi

temporary=$(mktemp .env.new.XXXXXX)
trap 'rm -f -- "$temporary"; unset key' EXIT
{
  if [[ -f $env_file ]]; then
    grep -vE '^CHAT_VAPID_(PRIVATE_KEY|SUBJECT)=' "$env_file" || true
  fi
  printf 'CHAT_VAPID_PRIVATE_KEY=%s\n' "$key"
  printf 'CHAT_VAPID_SUBJECT=mailto:ios_notifications@gregsemail.us\n'
} > "$temporary"
mv -- "$temporary" "$env_file"
chmod 600 "$env_file"

"${compose[@]}" up -d --force-recreate server
printf 'Stored the VAPID key in %s and recreated the server.\n' "$env_file"
if [[ -n $backup ]]; then
  printf 'Saved the previous environment file as %s.\n' "$backup"
fi
printf 'Open the installed iOS app once to refresh each invalidated subscription.\n'
