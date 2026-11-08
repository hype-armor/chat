# Fail-fast CI

## Entry points and publication

Pull requests run `.github/workflows/ci.yml` directly. The Images workflow calls
that same workflow for the exact pushed `main` or `v*` tag commit. CI therefore
has `pull_request` and `workflow_call` triggers, but no separate push trigger.
Do not add a second main/tag CI run alongside Images.

Images must wait for the complete reusable CI result before registry login,
container builds, or publication. Validation receives only `contents: read`.
Only the image-build job receives `packages: write`. Pull requests cannot invoke
image publication. Existing image tags and the pull-based deployment timer remain
unchanged; see [ADR-0018](adr/0018-pull-based-dev-deployment.md).

Security is a reusable dependency audit within CI. It also runs daily and on
manual dispatch. Its standalone pull-request trigger is unnecessary because CI
already calls it. Keep its pinned actions and existing audit policy.

GitHub-managed analyses such as the repository's separate CodeQL checks sit
outside this workflow graph. This refactor does not disable or reorder them.
Ordering those checks requires repository security configuration, not a `needs`
edge in this workflow. Do not claim that this graph gates those external checks.

## Stages

1. **Cheap validation:** dependency audit, Rust formatting, workflow graph tests,
   shell/build controls, Helm validation, full TypeScript checks, and focused pure
   unit tests. These jobs do not compile the application, start databases, or
   install browsers.
2. **Compilation-based validation:** both existing Clippy commands and focused
   Rust library tests. Clippy requires compilation, so all cheap checks gate it.
3. **Verified web build:** generate real WASM bindings, reject declaration drift,
   repeat full typechecking, run the complete web unit suite, and build the web app.
4. **Integration:** run the complete Rust workspace suite with isolated test
   databases. PostgreSQL starts only after the previous stages pass.
5. **Browsers:** after integration succeeds, build the test server and echo bot,
   install Chromium/Firefox/WebKit, run the UI fixtures, and then run the real
   server-backed tests with PostgreSQL and LiveKit.
6. **Publication:** on main/tag pushes only, Images builds and publishes after
   every required CI stage succeeds. No CI job invokes the live deployment script.

The final `rust` and `web` jobs preserve the existing required-check names.
They run even when prerequisite tests fail or skip, and report success only when
their test job succeeds. Do not soften required checks with `continue-on-error`.

The verified web artifact contains public build outputs and the real generated
WASM package. Browser jobs restore it under `web/`. Test binaries build locally
in their runner, so artifact downloads cannot lose executable permissions.

## Early typechecking without a WASM build

The web worker imports generated Rust bindings. A clean checkout has no generated
runtime, so early TypeScript checks use the authentic generated declaration at:

```text
scripts/ci/wasm-types/chat_core.d.ts
```

This is a type contract, not a JavaScript implementation or a cryptographic mock.
The early focused unit set does not import the generated runtime. Later CI builds
the real WASM package, compares its declaration byte-for-byte with this contract,
and runs the full unit suite without exclusions. Do not replace those later
checks with the early focused set.

For a clean local checkout only:

```sh
test ! -e web/src/core/pkg &&
mkdir -p web/src/core/pkg &&
cp scripts/ci/wasm-types/chat_core.d.ts web/src/core/pkg/
pnpm typecheck
```

The declaration alone cannot run the application or native-dependent unit tests.
Run `scripts/build-wasm.sh` before those tests.

When Rust exports or the pinned wasm-bindgen version change, regenerate rather
than hand-edit the contract:

```sh
scripts/build-wasm.sh &&
cp web/src/core/pkg/chat_core.d.ts scripts/ci/wasm-types/chat_core.d.ts
```

Review the generated API change with its Rust source change. The build uses the
CLI version selected by `scripts/wasm-bindgen-version.sh` from `Cargo.lock`.

## Local checks

Run formatting, configured lint, type checks, and focused unit tests before each
push. Use `actionlint` for workflow syntax and expressions, and run:

```sh
python3 scripts/test-ci-graph.py
git diff --check
```

The graph tests require PyYAML (CI pins `6.0.3`). They include negative controls
for broken gates, early expensive work, skipped checks, publication permissions,
artifact paths, browser coverage, and declaration drift verification. They do
not replace GitHub's workflow execution or integration/browser tests.

Do not run deployment scripts, publish images, or change running services to
validate this CI refactor locally.
