# WebKit navigation diagnostic

This diagnostic investigates the initial signup navigation failure in PR #120.
It does not change product code, navigation waits, assertion budgets, or retries.

## Trigger and comparison

The workflow is `.github/workflows/webkit-navigation-diagnostic.yml`.
A maintainer starts it by adding the `diagnose-webkit-navigation` label to a PR.
Pushes do not start this diagnostic workflow. Remove and reapply the label only
for a new investigation with a stated reason, not to obtain a passing result.
A new `workflow_dispatch` workflow cannot run before its file exists on `main`.
The label event permits this investigation without merging the workflow first.

The workflow runs each revision once:

- **Candidate:** the PR head SHA from the label event.
- **Baseline:** `db4e0a5ffb79925fd22766a6179c0f25bbbe4f56`, which includes merged PR #104.

Each revision gets a separate standard GitHub-hosted Linux runner and an isolated
PostgreSQL service container. This public repository uses no paid or persistent
infrastructure for the diagnostic. Each run uses the same diagnostic configuration
from the candidate SHA. The application and tests come from the selected revision.

The candidate includes the baseline dependency changes. There are no application
source differences in this comparison. The baseline does not contain `activity.spec.ts`.

## Exact test command

The workflow builds WASM, the web application, `chat-server`, and `chat-echo`.
It installs WebKit and runs this command from the repository root:

```sh
CI=1 PW_ALL_BROWSERS=1 E2E_SERVER=1 \
DATABASE_URL=postgres://postgres:postgres@localhost:5432/postgres \
pnpm --filter web exec playwright test \
  --config playwright.navigation-diagnostic.config.ts --project=webkit
```

The configuration selects `account.spec.ts`, `activity.spec.ts`,
`attachments.spec.ts`, and `backup.spec.ts`. It uses 1 worker and 0 retries.
There are 7 candidate tests and 4 baseline tests. No new skips apply.
This preserves the file predecessor sequence in one worker. It does not reproduce
the original full-suite schedule with 2 workers. A successful diagnostic does not
establish that the original failure is fixed.

The existing Playwright web-server configuration starts the preview and test
services on loopback. `CI=1` prohibits reuse of an existing deployment.
LiveKit is not needed for these tests.

## Explicit context tracing

Playwright `1.64.1` already records contexts created with `browser.newContext()`.
Its artifact recorder starts tracing after context creation and stops the trace
before context close. This also covers `signUp` and shared-fixture cleanup.
Do not add a second tracing wrapper to the fixture or helper.

The diagnostic uses `retain-on-failure`, with network/DOM snapshots enabled.
Screenshots, video, and source collection are disabled. Passing traces are discarded.
A local controlled test confirmed that native tracing retains both an early-closed
context and a context closed by the shared fixture. A test-timeout probe also
retained its pending `page.goto` action. A passing probe retained no trace.

## Artifact paths and privacy

The artifact names are:

```text
webkit-navigation-candidate-<run-id>
webkit-navigation-baseline-<run-id>
```

Each artifact expires after 1 day. Its paths are:

```text
web/navigation-diagnostic/revisions.txt
web/navigation-diagnostic/report.json
web/navigation-diagnostic/test-results/<failed-test>/trace.zip
target/e2e-server.log
target/e2e-echo.log
```

`revisions.txt` records the checkout SHA, diagnostic configuration SHA, and exact
command. `report.json` records test results and worker assignments. Only failed
tests retain a `trace.zip`. The JSON report and revision record remain on success.

Use only the generated synthetic accounts and files in the isolated test services.
Do not load real accounts, imported backups, production services, or real messages.
Traces can contain generated session tokens, recovery keys, DOM text, and network
bodies. Treat them as sensitive, even though the test database is temporary.
Artifacts in this public repository are not a private storage location. Do not
post raw traces, recovery keys, screenshots, or trace contents in PR comments or
external viewers. Share only artifact links and a redacted technical diagnosis.
Download and open a trace locally with the matching Playwright version:

```sh
pnpm --filter web exec playwright show-trace /local/path/to/trace.zip
```

Delete local trace copies when the investigation ends. Do not retain test-account
tokens after the service containers have been removed.

## Evidence to inspect

Identify the failed signup call and compare its duration with the total test budget.
Inspect the main-document response, pending resources, page snapshots, action logs,
and context-close timing. Check whether the navigation committed and whether the
onboarding controls appeared. Do not change `waitUntil` without this evidence.
A trace that does not capture the stall is not a verified fix.
