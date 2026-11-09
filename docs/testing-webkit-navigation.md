# WebKit navigation and composer diagnostic

## Current investigation: PR #134

This diagnostic investigates 2 failures from the normal CI suite:

- At `b37685e`, `safety.spec.ts` timed out while clicking Send in the stranger-message phase.
- At `ad788e2`, `desktop-layout.spec.ts` timed out in Alice's first `signUp`, while `page.goto('/')` waited for `load`.

The desktop-layout failure occurred before the test set the 768px viewport or used the signup controls.
Its CI artifact contained no page snapshot or trace. It did not establish whether onboarding rendered or navigation committed.
The context-closure error does not establish a browser crash; timeout cleanup can close the context.

The diagnostic does not change product code, signup waits, test budgets, assertions, or retries.
Do not change `waitUntil` without evidence from the failing navigation.

## Trigger and comparison

The workflow is `.github/workflows/webkit-navigation-diagnostic.yml`.
A maintainer starts it by adding the `diagnose-webkit-navigation` label to a PR.
Pushes do not start this diagnostic workflow.
Review and push the diagnostic update before adding the label once with an investigation reason.
Remove and reapply the label only for a new investigation with a stated reason, not to obtain a passing result.
A new `workflow_dispatch` workflow cannot run before its file exists on `main`.
The label event permits this investigation without merging the workflow first.

The workflow runs each revision once:

- **Candidate:** the PR head SHA captured by the label event, including the reviewed diagnostic update.
- **Baseline:** pinned PR base `66055b223f129eabae87a7483598ec73d5341762`, which includes merged PR #127.

The candidate is not permanently pinned to the earlier failing commit `ad788e2`.
The label event fixes its exact SHA for this run. Later pushes do not change that run's selected revision.

Each revision gets a separate standard GitHub-hosted Linux runner and an isolated PostgreSQL service container.
This public repository uses no paid or persistent infrastructure for the diagnostic.
Both revisions use the diagnostic configuration from the candidate SHA.
The application, tests, helpers, dependencies, and normal Playwright configuration come from each selected revision.
The candidate therefore includes its test instrumentation; the baseline retains its own test code.

## Exact test command and scope

The workflow builds WASM, the web application, `chat-server`, and `chat-echo`.
It installs WebKit and runs this command from the repository root:

```sh
CI=1 PW_ALL_BROWSERS=1 E2E_SERVER=1 \
DATABASE_URL=postgres://postgres:postgres@localhost:5432/postgres \
pnpm --filter web exec playwright test \
  --config playwright.navigation-diagnostic.config.ts --project=webkit --workers=2 --retries=0
```

The workflow stores the test command in `DIAGNOSTIC_COMMAND` and records that same command in `revisions.txt`.
The configuration selects only `desktop-layout.spec.ts` and `safety.spec.ts`.
Each revision currently has 7 selected tests: 5 desktop-layout tests and 2 safety tests.
The diagnostic adds no skips. It retains the existing WebKit and test-specific budgets.

The configuration and command use 2 workers and 0 retries.
This matches the normal CI worker count, but not its full scheduling or resource pressure.
The selected files omit the full-suite predecessors.
The diagnostic does not reproduce the original full-suite worker history or guarantee the same test interleaving.
**A passing diagnostic is inconclusive. It does not establish that either failure is fixed.**

The existing Playwright web-server configuration starts the preview and test services on loopback.
`CI=1` prohibits reuse of an existing deployment. LiveKit is not needed for these tests.

## Explicit context tracing

Playwright `1.64.1` already records contexts created with `browser.newContext()`.
Its artifact recorder starts tracing after context creation and stops the trace before context close.
This also covers `signUp` and shared-fixture cleanup.
Do not add a second tracing wrapper to the fixture or helper.

The diagnostic uses native `retain-on-failure`, with network and DOM snapshots enabled.
It disables screenshots, video, and source collection. It discards passing traces.
Earlier controlled tests confirmed that native tracing retained both an early-closed context and a context closed by the shared fixture.
A test-timeout probe also retained its pending `page.goto` action. A passing probe retained no trace.
These tracing checks do not establish the cause of the current failures.

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
web/navigation-diagnostic/test-results/<failed-test>/**/safety-composer-*.json
target/e2e-server.log
target/e2e-echo.log
```

`revisions.txt` records the candidate SHA, pinned baseline SHA, checkout SHA, diagnostic configuration SHA, workflow SHA, and exact test command.
It also records `CI`, `PW_ALL_BROWSERS`, and `E2E_SERVER`, without recording database credentials.
`report.json` records test results and worker assignments.
Only failed tests retain a `trace.zip`. The JSON report and revision record remain on success.

The workflow also uploads redacted safety-composer JSON files when the selected revision produces them.
These files contain bounded state and geometry observations, not message text, account IDs, or keys.
They can distinguish draft changes, input replacement, hidden ancestors, viewport collapse, and an already submitted message.
They do not replace the native trace or prove a cause without a captured failure.

Use only generated synthetic accounts and files in the isolated test services.
Do not load real accounts, imported backups, production services, or real messages.
Traces can contain generated session tokens, recovery keys, DOM text, and network bodies.
Treat them as sensitive, even though the test database is temporary.
Artifacts in this public repository are not a private storage location.
Do not post raw traces, recovery keys, screenshots, or trace contents in PR comments or external viewers.
Share only artifact links and a redacted technical diagnosis.
Download and open a trace locally with the matching Playwright version:

```sh
pnpm --filter web exec playwright show-trace /local/path/to/trace.zip
```

Delete local trace copies when the investigation ends.
Do not retain test-account tokens after the service containers have been removed.

## Evidence to inspect

For a signup failure, identify the failed signup call and compare its duration with the total test budget.
Inspect the main-document response, pending resources, lifecycle events, page snapshots, action logs, and context-close timing.
Check whether navigation committed and whether the onboarding controls appeared before `load` completed.
Do not change `waitUntil` without this evidence.

For a Send failure, identify the sender and inspect the draft, selected conversation, button geometry, hidden ancestors, and viewport state.
Check whether the message was already submitted before the click stalled.
Do not infer draft clearing from a visibility error alone.

A trace that does not capture the stall is not a verified fix.
Keep the existing waits, budgets, and assertions until evidence supports a specific remediation.
Do not repeat the diagnostic only to obtain a passing result.

## Historical investigation: PR #120

The original diagnostic investigated an initial signup navigation failure in PR #120.
Its baseline was `db4e0a5ffb79925fd22766a6179c0f25bbbe4f56`, which included merged PR #104.
Its candidate was the PR head SHA from the label event.
The candidate included the baseline dependency changes. The application source did not differ between those original comparison revisions.
The baseline did not contain `activity.spec.ts`.

The original configuration selected `account.spec.ts`, `activity.spec.ts`, `attachments.spec.ts`, and `backup.spec.ts`.
It used 1 worker and 0 retries, with 7 candidate tests and 4 baseline tests.
It added no skips. It preserved the selected file predecessor sequence in 1 worker.
It did not reproduce the original full-suite schedule with 2 workers.
A successful historical diagnostic did not establish that the original failure was fixed.

The original command omitted the current explicit worker and retry arguments:

```sh
CI=1 PW_ALL_BROWSERS=1 E2E_SERVER=1 \
DATABASE_URL=postgres://postgres:postgres@localhost:5432/postgres \
pnpm --filter web exec playwright test \
  --config playwright.navigation-diagnostic.config.ts --project=webkit
```

The original workflow used the same label trigger, separate isolated runners, candidate-supplied diagnostic configuration, and 1-day artifact retention.
It used native failure-only tracing with screenshots, video, and sources disabled.
Its revision record contained the checkout SHA, diagnostic configuration SHA, and exact command.
The current investigation expands that record and changes the baseline, selected files, and worker count.
