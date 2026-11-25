# Opt-in pre-topic WASM compatibility check

This check covers 1 topic prerequisite. It does not enable topic transport.
It uses 2 independently built `--target web` wasm-bindgen packages:

- Old: `4141dbd3c87a7bd2fa09d4359a969de7a73458c3`.
- Current topic implementation: `908f69a5e185b5b644030003ec4a531bbfcd2983`.

The current sender creates a conversation with the old receiver. It sends ordinary
text, a real encrypted topic, and subsequent ordinary text. The old receiver must
report the topic as `ignored`. It must save its snapshot, destroy its client,
restore through the old WASM class, and decrypt the subsequent ordinary text.
The test checks the authenticated sender identity too.

Each package gets a separate JS module and WASM instance. Copying the same JS
module and calling its initializer twice is not sufficient: wasm-bindgen stores
its instance in module-level mutable state. The loader uses distinct data URLs.
No services, browser storage, network, or deployment participate.

## Source evidence, not a mixed-version runtime result

At old commit `4141dbd`:

- `proto/chat/v1/content.proto:10-24` has body tags through 17 and no tag 18.
  Current `proto/chat/v1/content.proto:24` assigns tag 18 to `GroupTopic`.
- `crates/chat-core/src/client.rs:345-358` decodes the decrypted application bytes
  with prost. An unknown protobuf field is skipped, leaving `body = None`.
  It does not reject a successfully decoded Content with an absent body.
- `crates/chat-core/src/wasm.rs:1253` explicitly maps `None` to `kind = "ignored"`.
- `web/src/core/engine.ts:4426` enters the visible-message branch only for
  `event.kind === 'message'`. An ignored event does not enter that branch.
- `web/src/core/engine.ts:4272-4292` processes delivery, records the ID, and calls
  `persist()` even for an ignored event. It acknowledges only after persistence.
- `web/src/core/engine.ts:5096-5105` persists `this.core!.snapshot()`.

This supports compatibility for a well-formed, authenticated tag-18 payload.
It does not promise safety for malformed protobuf or arbitrary future fields.
Only the genuine old-package runtime check below closes the mixed-version gap.
This check does not exercise the old web engine or IndexedDB failure handling.

## Build on a separate machine with sufficient memory

Do not run these builds on the constrained shared host. Supply an existing local
repository containing both commits. Use a clean build environment and matching
wasm-bindgen CLI versions from each commit's Cargo.lock. Do not substitute a
current package, stub, or relabeled package for the old build.

Example commands for an isolated builder, not executed by this task:

```sh
set -eu
REPO=/absolute/path/to/local/chat-irc
ROOT=$(mktemp -d)
export ROOT
OLD=4141dbd3c87a7bd2fa09d4359a969de7a73458c3
CURRENT=908f69a5e185b5b644030003ec4a531bbfcd2983
git -C "$REPO" worktree add --detach "$ROOT/old-source" "$OLD"
git -C "$REPO" worktree add --detach "$ROOT/current-source" "$CURRENT"
for role in old current; do
  (
    cd "$ROOT/$role-source"
    test -z "$(git status --porcelain)"
    # Install the CLI into a role-specific directory; do not replace global tools.
    version=$(scripts/wasm-bindgen-version.sh)
    export CARGO_BUILD_JOBS=$(getconf _NPROCESSORS_ONLN)
    export CARGO_TARGET_DIR="$ROOT/$role-target"
    rustup target add wasm32-unknown-unknown
    cargo install wasm-bindgen-cli --locked --version "$version" --root "$ROOT/$role-tools"
    cargo build --locked --release --target wasm32-unknown-unknown -p chat-core --features wasm
    "$ROOT/$role-tools/bin/wasm-bindgen" --target web --out-dir "$ROOT/$role-package" \
      "$CARGO_TARGET_DIR/wasm32-unknown-unknown/release/chat_core.wasm"
    # Record provenance immediately after this exact clean-source build.
    SOURCE_COMMIT=$(git rev-parse HEAD) PACKAGE="$ROOT/$role-package" python3 - <<'PY'
import hashlib, json, os
from pathlib import Path
p = Path(os.environ['PACKAGE'])
m = {'sourceCommit': os.environ['SOURCE_COMMIT']}
for key, name in [('jsSha256', 'chat_core.js'), ('wasmSha256', 'chat_core_bg.wasm')]:
    m[key] = hashlib.sha256((p / name).read_bytes()).hexdigest()
(p / 'topic-compat-build.json').write_text(json.dumps(m, indent=2) + '\n')
PY
  )
done
```

Retain the build logs and the manifests with the packages. The manifest binds
checksums to a declared source revision. It is not independent proof of source
provenance; the builder must be trusted. The loader rejects absent manifests,
wrong revisions, checksum mismatches, identical WASM binaries, and an old API
that exposes `sendGroupTopic`.

Transfer both package directories to the test machine. Then run from this
worktree, with explicit package paths:

```sh
node scripts/test-topic-legacy-wasm.mjs /absolute/path/old-package /absolute/path/current-package
```

The successful output includes both commits and both JS/WASM checksums.
To test a different trusted current artifact, append `--current-commit FULL_SHA`
and use its actual checkout SHA in the manifest. Keep the old commit fixed.
Do not treat a missing artifact or manifest as a successful skip.

## Offline checks without an old artifact

```sh
node --check scripts/test-topic-legacy-wasm.mjs
node --check scripts/test-topic-legacy-wasm.test.mjs
node --test scripts/test-topic-legacy-wasm.test.mjs
CURRENT_WASM_PACKAGE=/absolute/path/existing/current/pkg \
  node --test scripts/test-topic-legacy-wasm.test.mjs
```

The optional current-only test runs real existing WASM twice with isolated
instances. It checks conversation creation, topic decode, snapshot/restore,
subsequent text, and rejection of current bindings as an old API. Its output
explicitly says that it is not legacy evidence. It requires no build or manifest.

## Recorded mixed-version result

The complete mixed-version exchange **passed** with 2 genuine GitHub Actions packages.
Both `verified-web-build` archive hashes matched the values from the GitHub API.
The old package came from [main CI run 45445037261](https://github.com/hype-armor/chat/actions/runs/45445037261),
artifact `14944468321`, at `4141dbd3c87a7bd2fa09d4359a969de7a73458c3`.
The current package came from [PR #175 CI run 45500186393](https://github.com/hype-armor/chat/actions/runs/45500186393),
artifact `14970243938`. The job log identifies its merge checkout as
`4e018ad818288cb32df9c35c77ea78f48004bad8`. Its tree matches PR head `4b13182`;
its WASM build inputs match `908f69a`. The artifact manifests record the actual
checkout SHAs, not the default current revision.

| Package | WASM SHA-256 |
| --- | --- |
| Old | `a85c73ebd339ab3199aad16a522ff0bfdc4c9f1d39c1b5b2ed05f5d2fa66d973` |
| Current | `60ee55de299f283a639e91f2aac38631f1d4296f87ba45d63e69eb1c2fe07442` |

No Rust build ran on this host. This result covers only the tested WASM pair.
This WASM check alone does not verify the old web delivery path or browser persistence.

## Old web delivery check

The opt-in `scripts/fixtures/legacy-topic-engine.test.ts` runs the actual old
`Engine.onDeliver` with the two verified WASM packages. It asserts no emitted
UI events or stored topic, restores the persisted old MLS state, rejects a replay of the
exact topic ciphertext, and decrypts later text. It also injects a failure
between the old core and app-state writes. A new engine loads those saved
after-failure values and handles a redelivery before sending an ACK. The store
and socket are test doubles; this is not a browser or IndexedDB crash test.

Use an isolated checkout at `4141dbd3c87a7bd2fa09d4359a969de7a73458c3` with
lockfile-matched dependencies. Prepare the 2 package manifests as described
above, with the recorded checkout `4e018ad818288cb32df9c35c77ea78f48004bad8`
for the current CI-package test. Use `HARNESS`, `OLD_WORKTREE`, `OLD_PACKAGE`,
and `CURRENT_PACKAGE` as absolute paths. Do not copy into a working deployment.

```sh
mkdir -p "$OLD_WORKTREE/web/src/core/pkg"
cp "$OLD_PACKAGE"/chat_core.js "$OLD_PACKAGE"/chat_core_bg.wasm \
  "$OLD_PACKAGE"/topic-compat-build.json "$OLD_WORKTREE/web/src/core/pkg/"
cp "$HARNESS/scripts/test-topic-legacy-wasm.mjs" "$OLD_WORKTREE/scripts/"
cp "$HARNESS/scripts/fixtures/legacy-topic-engine.test.ts" "$OLD_WORKTREE/web/src/core/"
cd "$OLD_WORKTREE/web"
CURRENT_TOPIC_WASM_PACKAGE="$CURRENT_PACKAGE" pnpm exec vitest run src/core/legacy-topic-engine.test.ts
```

Both cases passed in an isolated copy with the recorded CI packages. This
covers one ignored-content recovery path. It does not prove old-browser
persistence, delivery recovery for visible content, or that topic transport
can be enabled.

## Current browser storage check

The isolated topic-delivery fixture runs the current `Engine` and `SecureStore`
in a module worker. It aborts the IndexedDB batch after the core write request
succeeds but before transaction commit. The socket double must see no ACK, and
both stored records must remain unchanged. The fixture terminates the worker,
starts a fresh one on the same IndexedDB, and replays the same encrypted topic.
The new worker must commit before it acknowledges. At acknowledgement, both
stored records must match the engine state, including the seen delivery ID.
The restored ratchet must reject exact replay and decrypt the following text. The fixture
blocks requests to chat APIs and other origins.

Run from `web` in an isolated checkout with lockfile-matched dependencies and
the current CI WASM package installed. `E2E_TOPIC_DELIVERY_PORT` can select an
unused test port. The default runs Chromium and Firefox; set
`PW_ALL_BROWSERS=1` to include WebKit when available.

```sh
pnpm exec playwright test --config=playwright.topic-delivery.config.ts
```

Chromium and Firefox passed. WebKit did not launch on the test host because
system libraries were missing. A separate Chromium run with the app write
removed failed at the app-state readback assertion, as expected.

This is a controlled transaction-abort test, not a power-loss or cross-device
recovery test. It does not exercise the production worker entry point or prove
that unrelated writers cannot race the transaction.
