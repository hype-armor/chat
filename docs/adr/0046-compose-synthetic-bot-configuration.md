# ADR-0046: Configure synthetic bots with a separate Compose updater

- **Status:** Accepted
- **Date:** 2026-11-12
- **Deciders:** Greg; implementation by Pi
- **Related:** ADR-0044, ADR-0045

## Context

Operators need an application updater that also configures the synthetic bot runner.
The existing `update.sh` belongs to the operator and must remain unchanged. Bot state
and its encryption key must survive image updates. Configuration must not silently
register accounts or enable external inference.

## Options considered

1. Install Rust, Node, and a system service on the host. This adds toolchain and
   permission requirements to the existing Compose deployment.
2. Add an optional Compose image and a separate updater. This reuses existing
   deployment tools and keeps the old updater intact.
3. Enable bots in the base Compose stack automatically. Reject this option because
   ordinary application updates must not activate bot traffic.

## Decision

Use `update-with-bots.sh` and an optional bots Compose overlay. Configuration uses
synthetic mode only. Registration/bootstrap/start require `--enable-bots`. New setups
start with 2 requested accounts and 12 send attempts per minute; operators can select
larger staged account counts and bounded rates.

Generate a private random state key once. Store it in ignored configuration outside
the encrypted state directory. Never replace missing credentials when nonempty state
already exists. Preserve state and credentials across updates. Use supported server
invite creation and client registration; do not insert memberships or alter quotas.

The bot container shares the server network namespace. Its server URL is actual
loopback HTTP, so the native HTTPS/loopback policy does not need an insecure exception.
The service exposes no ports and uses a read-only root filesystem, restricted
capabilities, and caller-owned private state binds.

Keep Docker builds sequential and retain the shared BuildKit Cargo lock and CPU budget.
The new updater shares the existing checkout deployment lock and adds a repository-wide
lock for new updater runs across worktrees. It keeps its own input baseline. Old updater
runs from other worktrees or clones against the same deployment remain unsupported.
Dry-run performs no pull, writes, deployment, bootstrap, or pruning.

## Consequences

The host needs the existing Docker/Compose, Python, Git, and locking tools, not a new
Rust or Node installation. The bot image adds build work only when enabled or changed.
The first account bootstrap can stop at existing registration or welcome limits;
operators must resume rather than bypass those limits. The finite native journal
and membership-reconciliation limitations still apply.

## Validation

Use mock Docker commands and temporary repositories to test dry-run, key preservation,
permissions, selective rebuilds, activation gates, bootstrap failure, and resume order.
Check all Cargo Dockerfile build controls and render Compose without loading secrets.
Never run installer tests against a live service or create real operator credentials.
