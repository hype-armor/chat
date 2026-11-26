# Disposable Compose writer-fence rehearsal

This opt-in check is **not** an application migration, rollback, or production
fence. It starts the exact old server on newly initialized synthetic stores.
It does not start the candidate or exercise schema promotion, backup, or
rollback. The separate application rehearsal is the evidence for those paths.

## Prerequisites

- Use a fresh, offline, disposable Linux guest with **1 vCPU** and a trusted,
  unprivileged fixture user. Never run this on a shared daemon, on a deployed
  system, or with production data or credentials. Do not attach the guest to a
  deployment network. No other daemon client or supervisor may change the
  fixture, start its containers, or apply its Compose plan.
- Use Docker Engine and the Compose CLI plugin already installed in that guest.
  Before the check, provision a fresh **rootless** daemon with no swarm, no live
  restore, and no existing containers, user networks, or volumes. The daemon
  must listen directly on the one private Unix socket, not on an API proxy. The
  runner never provisions a daemon, installs packages, pulls images, or builds.
  On systemd, run rootless Docker as a delegated user service, not a system
  service with `User=`. Enable lingering and the user service for the reboot
  check. Before preparing the rehearsal daemon, verify a pinned scratch
  container can start on an internal bridge with `--log-driver=local`,
  `--log-opt=max-size=1m`, `--log-opt=max-file=1`, and
  `--log-opt=compress=false`. Use a separate scratch daemon and stop it before
  starting the rehearsal daemon. Do not copy scratch state into the rehearsal.
- Create a short, absolute, nonsymlink workspace path with mode `0700`. The
  daemon command line must set `--data-root=$WORK/engine-data` and
  `--host=unix://$WORK/engine.sock` (the only host). Use a separate daemon
  execution root and PID file. The data directory must have mode `0700` and the
  socket must have mode `0600`. All 3 paths must belong to the fixture user.
  Reassert these modes after each daemon start, including after a reboot.
  The runner expects `/usr/bin/docker` and a local `/usr/bin/dockerd` socket
  peer. It will not use `/run/docker.sock`, a Docker context, or an inherited
  CLI configuration. Keep the workspace on persistent guest storage for a
  reboot check.
- Allow disk for all preloaded image layers, Docker overhead, and both stores
  **in addition to** the 800 MiB floor. The runner checks the workspace and
  Docker data filesystems before each Docker call. Stop and discard the guest
  if the floor blocks the owner. The checks cannot reserve free space against
  external writes.
- Verify and preload the exact Linux guest-platform registry manifests into
  the dedicated guest daemon, with matching `RepoDigests`. Use only trusted
  published artifacts. The 4 values in a local `images.json` must be real
  repository manifest digests, not a Docker image ID or placeholders:

  | Key | Required prefix (append `@sha256:<64 lowercase hex digits>`) |
  | --- | --- |
  | `app` | `ghcr.io/hype-armor/chat-server:sha-4e04c0b` |
  | `pg` | `docker.io/library/postgres:18.6` |
  | `s3` | `docker.io/chrislusf/seaweedfs:4.50` |
  | `curl` | `docker.io/curlimages/curl:8.17.0` |

  The old tag refers to the `v0.1.0-pr.170` target. Compare its digest to the
  independently verified release image before starting. The rehearsal records
  the supplied registry digests and resolved image IDs. It does not derive
  image provenance from the older release's binary archive. If no digest or
  image is available, stop. Do not substitute a floating tag or a new build.

### Observed registry digests for Linux AMD64

These HTTPS registry results are references for fixture preparation, not a
signature or a record that the images were loaded. Recheck the registry and
verify the loaded `RepoDigests` in the guest. For the app, the platform image
configuration identifies revision `4e04c0b2ed639ee46341c9205d09a66e967afd47`.

| Key | Manifest index SHA-256 | Linux AMD64 manifest SHA-256 |
| --- | --- | --- |
| `app` | `e9737ea310588bc27cf7df80dc8c460923d7d2b0a985130b81b468f61b7744d1` | `e6cfeab100ddd6ea71ae33d65d467c4a63ec6335a82d33897bc703388fbff09a` |
| `pg` | `e3d24f6906d0760bf4da0dae872415391ededefad23fd471c47dc53b0ddf3c42` | `e923a22ac074261dd73970c57edf659475bf0497cb9456f17d98ed7cdd3ca913` |
| `s3` | `c2658820e763294a9e9de7b36c81e59b879e3459148351aee4e31a126ca64860` | `b2e51562743be5637381a82eeeee4872eb2f86994b723d25a1bbd171855fe18d` |
| `curl` | `935d9100e9ba842cdb060de42472c7ca90cfe9a7c96e4dacb55e79e560b3ff40` | `43ebaa53d3806db6b1ce4353b6b26ae638ec1c167ee351524b05690f988bb20d` |

## Run

In the dedicated guest, from the repository root:

```sh
python3 scripts/username_migration_compose_rehearsal.py run \
  --disposable-guest --workspace "$WORK" --images /absolute/path/images.json
```

The owner claims a random Compose project and a private journal. An internal
bridge is the only writer network. No port publishes to the guest. The original
PostgreSQL server accepts TCP and SeaweedFS accepts S3. The outside probes
write/read synthetic data using known fixture credentials, and the old app must
be healthy with migration 20 as its highest applied migration. The owner then
stops the app, the combined SeaweedFS container, and PostgreSQL, in that order.

The original containers persist with `restart: "no"`; the owner never starts
an original writer after the `fencing` marker. Both maintenance stores use
`network_mode: none`, bind to loopback, and mount the exact original named
volumes. SeaweedFS keeps its Raft hostname but maps it to loopback in the
maintenance container. One private `curl` probe shares only the maintenance
S3 network namespace. The outside probes attempt SQL and S3 writes from the old writer
network to the original addresses, using the original fixture credentials. S3
also gets an unsigned attempt. The owner also probes the old app, SeaweedFS
master, filer, and volume HTTP ports. Authentication denial alone is not proof.
The owner requires connection failures and no outside canaries in either store.
It also checks the original PostgreSQL system ID, the baseline data, and
successful internal reads and writes. The proof is in `$WORK/journal.json`.

If interrupted between confirmed Docker operations during `fencing`, `fenced`,
or `maintenance`, restart only the owner with `resume` on the same boot. An
interruption in `provisioning` or `baseline` needs `abort` or guest disposal.
Before Docker create, start, or stop, the owner records a durable pending
marker. If that command has an unknown result, both `resume` and `abort` refuse.
Discard the guest externally; do not clear the marker. The owner never guesses
a failed baseline or an uncertain daemon effect. Do not apply the fixture plan
with Compose directly.

## Optional reboot check

After `proven`, run `arm-reboot --disposable-guest --workspace "$WORK"`. Shut
down/reboot **the dedicated guest only**, externally. Restart the same daemon
with the same data root and socket; do not apply any Compose project. Then run
`resume --disposable-guest --workspace "$WORK"`. The owner checks for a new
Linux boot ID and the same daemon, container, network, image, and volume
identities. No fixture container may have auto-started. The owner starts only
the probes and private maintenance stores and verifies the pre-reboot write
canaries before producing the separate `reboot-proven` record. A same-boot
resume must refuse. This is a controlled guest restart, not a power-loss test.

## Stop and interpret

`abort --disposable-guest --workspace "$WORK"` stops the owned containers and
retains the journal, containers, networks, and volumes. It never restores,
removes, or starts a container. If ownership or storage identity is unclear,
stop and dispose of the entire dedicated guest via its operator. Retain only
synthetic proof records as needed. Do not remove individual resources through
an unverified daemon. `restart: "no"` covers this daemon's auto-start behavior;
it does not protect against a privileged client manually starting old writers,
an external orchestrator, another host, or a process that can access the
physical volumes. This check does not exercise any of those production paths.

## Offline checks

```sh
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s scripts \
  -p test_username_migration_compose_rehearsal.py -v
```

The tests use a fake runner for lifecycle, drift, and reboot cases. The Compose
configuration test uses a nonexistent explicit socket and no daemon. `render
--images ...` emits a deterministic non-operational review plan with a dummy
project name. Neither that plan nor the tests prove real store behavior,
Docker isolation, or guest reboot persistence.
