# ADR-0018: Pull-based continuous deployment to the dev cluster

- **Status:** Accepted
- **Date:** 2026-10-29
- **Deciders:** project owner, Claude
- **Related requirements:** Phase 1 checklist item 6 (doc 09 §2.1)

## Context
Development and initial testing run on a single-node k3s host on the
owner's network (ADR-0015). Its Kubernetes API (6443) must not be exposed
(deploy/k3s/README.md §0), so GitHub-hosted runners cannot reach it. Every
merge to `main` already publishes images to GHCR tagged `sha-<commit>`, and
the packages are public (the project is fully open source).

## Options considered
1. **Push from GitHub Actions** through an exposed API, a VPN or a tunnel
   (e.g. Tailscale). Simple workflow, but it puts a cluster-admin
   credential in GitHub secrets and opens a path into the home network.
2. **Self-hosted Actions runner** on the host. No credential leaves the
   host, but GitHub advises against self-hosted runners on public
   repositories: workflow code from the repository runs on the owner's
   machine.
3. **GitOps operator** (Flux or Argo CD with image automation). The
   standard answer for many services, but several controllers, CRDs and
   a write-back loop for one chart on one node.
4. **Pull with a systemd timer** on the host: poll `main`, wait until both
   images exist, `helm upgrade --atomic` with the commit's tag and the
   chart from the same commit.

## Decision
Option 4. Nothing is exposed and no credential leaves the host, and it is
about 70 lines of shell built on the same Helm command as the manual
procedure. A release that does not become ready is rolled back.

### Validation gate (2026-11-08)

The Images workflow invokes reusable CI for the exact pushed `main` or version-tag
commit. It must finish successfully before either image build or registry login
starts. Cheap validation gates builds, integration tests, and browser tests.
Publication waits for all required CI stages, not only the cheap checks.

Pull requests invoke the same CI directly. Main and tag pushes invoke it through
Images, not through a second standalone push trigger. This avoids duplicate CI
runs and preserves the original push context for image tags. Validation receives
read-only repository permissions. Only image publication receives package-write
permission. No cluster credential enters GitHub Actions.

The existing timer still deploys only after both commit-tagged images exist.
The workflow change does not invoke the timer or perform a deployment itself.

## Consequences
- Deploys trail a merge by validation, image builds, and up to 5 minutes of polling.
- `main` must only receive commits whose PR checks passed. Image publication also
  requires successful CI for the exact pushed commit.
- The deploy clone on the host follows `main`, so the script and chart
  update themselves.
- For production (Linode or own hardware) revisit: with real users, a
  manual promotion step or Flux is likely better than deploying every
  merge.

## Validation
`journalctl -u chat-dev-update` shows each validated merge deployed after CI,
image publication, and the next timer poll. A deliberately broken image rolls
back without downtime. Test this behavior only during an authorized deployment.
