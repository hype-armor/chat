#!/usr/bin/env python3
"""Validate fail-fast CI dependencies and retained checks. Requires PyYAML."""

from copy import deepcopy
from pathlib import Path
import unittest

import yaml


WORKFLOWS = Path(__file__).resolve().parents[1] / ".github/workflows"
CHEAP = {"dependency-audit", "build-controls", "helm", "web-checks"}
EXPENSIVE = (
    "cargo clippy", "cargo test", "cargo build", "cargo install",
    "scripts/build-wasm.sh", "pnpm build", "pnpm test",
    "playwright install", "playwright test", "pnpm --filter web e2e",
    "docker run",
)


def dependencies(job):
    value = job.get("needs", [])
    return {value} if isinstance(value, str) else set(value)


def commands(job):
    return "\n".join(step.get("run", "") for step in job.get("steps", []))


def validate_required_execution(workflow, gates=frozenset(), allow_failure_logs=False):
    for name, job in workflow["jobs"].items():
        assert "continue-on-error" not in job, f"Required job can fail softly: {name}"
        if name not in gates:
            assert "if" not in job, f"Required job can skip or bypass validation: {name}"
        for step in job.get("steps", []):
            assert "continue-on-error" not in step, f"Required step can fail softly: {name}"
            run = step.get("run", "")
            failure_log = allow_failure_logs and name == "web-browser" and (
                run == "docker logs livekit > target/livekit.log 2>&1 || true"
                or (step.get("uses", "").startswith("actions/upload-artifact@")
                    and step.get("with", {}).get("name") == "e2e-server-log")
            )
            if failure_log:
                assert step.get("if") == "failure()"
            else:
                assert "if" not in step, f"Required step can skip validation: {name}"
                assert "||" not in run, f"Required command can hide failure: {name}"


def validate(workflow):
    validate_required_execution(workflow, {"rust", "web"}, allow_failure_logs=True)
    jobs = workflow["jobs"]
    assert "workflow_call" in workflow["on"], "CI must support reusable calls"
    assert "pull_request" in workflow["on"], "PRs must run CI"
    assert "push" not in workflow["on"], "Images owns main and tag pushes"
    assert workflow["permissions"] == {"contents": "read"}
    assert CHEAP <= jobs.keys()
    assert jobs["dependency-audit"]["uses"] == "./.github/workflows/security.yml"
    assert jobs["dependency-audit"]["permissions"] == {"contents": "read"}

    def ancestors(name, visiting=frozenset()):
        assert name in jobs, f"Unknown dependency: {name}"
        assert name not in visiting, f"Dependency cycle: {name}"
        direct = dependencies(jobs[name])
        return direct | set().union(*(
            ancestors(dep, visiting | {name}) for dep in direct
        ))

    for name, job in jobs.items():
        before = ancestors(name)
        expensive = bool(job.get("services")) or any(
            marker in commands(job) for marker in EXPENSIVE
        )
        if name in CHEAP:
            assert not expensive, f"Cheap job starts expensive work: {name}"
        if expensive:
            assert CHEAP <= before, f"Static checks do not gate {name}"
            assert "if" not in job, f"Expensive job can bypass failed needs: {name}"
            if name != "rust-checks":
                assert "rust-checks" in before, f"Clippy does not gate {name}"
        if job.get("services") or "playwright" in commands(job):
            assert "web-build" in before, f"Build and full units do not gate {name}"

    required = {
        "build-controls": [
            "cargo fmt --all --check", "python3 scripts/test-ci-graph.py",
            "bash -n scripts/compose-build.sh scripts/test-compose-build.sh",
            "scripts/test-compose-build.sh", "docker buildx build --check",
        ],
        "helm": ["helm lint", "helm template", "shellcheck scripts/*.sh"],
        "web-checks": [
            "test ! -e web/src/core/pkg", "scripts/ci/wasm-types/chat_core.d.ts",
            "pnpm typecheck", "vitest run", "src/core/replies.test.ts",
            "src/core/deletions.test.ts", "src/core/me-deletion-sync.test.ts",
            "src/core/devices.test.ts", "src/core/calls.test.ts", "src/ui/deletion.test.ts",
        ],
        "rust-checks": [
            "cargo clippy --workspace --all-targets -- -D warnings",
            "cargo clippy -p chat-core --target wasm32-unknown-unknown --features wasm -- -D warnings",
            "cargo test -p chat-core -p chat-proto --lib",
        ],
        "web-build": [
            'cargo install wasm-bindgen-cli --locked --version "$(scripts/wasm-bindgen-version.sh)"',
            "scripts/build-wasm.sh",
            "diff -u scripts/ci/wasm-types/chat_core.d.ts web/src/core/pkg/chat_core.d.ts",
            "pnpm typecheck", "pnpm test", "pnpm build",
        ],
        "rust-integration": ["cargo test --workspace"],
        "web-browser": [
            "cargo build -p chat-server -p chat-echo",
            "playwright install --with-deps chromium firefox webkit",
            "playwright test --config playwright.fixtures.config.ts",
            "pnpm --filter web e2e", "postgres:18", "livekit/livekit-server:v1.13",
        ],
    }
    for name, retained in required.items():
        for command in retained:
            assert command in commands(jobs[name]), f"Missing {name} check: {command}"

    assert dependencies(jobs["web-browser"]) == {"web-build", "rust-integration"}, (
        "Browser setup must wait for successful workspace integration tests"
    )
    failure_upload = next(step for step in jobs["web-browser"]["steps"]
                          if step.get("uses", "").startswith("actions/upload-artifact@"))
    assert failure_upload["with"].get("retention-days") == "1", (
        "Test logs and traces must expire after 1 day"
    )

    build = commands(jobs["web-build"])
    assert build.index("scripts/build-wasm.sh") < build.index("diff -u")
    assert build.index("diff -u") < build.index("pnpm typecheck")
    assert build.index("pnpm test") < build.index("pnpm build")
    upload = next(step for step in jobs["web-build"]["steps"]
                  if step.get("uses", "").startswith("actions/upload-artifact@"))
    assert set(upload["with"]["path"].split()) == {"web/dist", "web/src/core/pkg"}
    download = next(step for step in jobs["web-browser"]["steps"]
                    if step.get("uses", "").startswith("actions/download-artifact@"))
    assert download["with"]["name"] == upload["with"]["name"]
    assert download["with"]["path"] == "web", "Restore the common artifact parent"
    browser = commands(jobs["web-browser"])
    assert browser.index("cargo build") < browser.index("playwright install")
    assert browser.index("cargo build") < browser.index("docker run")
    browser_tests = [step for step in jobs["web-browser"]["steps"]
                     if "playwright test" in step.get("run", "")
                     or step.get("run") == "pnpm --filter web e2e"]
    assert len(browser_tests) == 2
    for step in browser_tests:
        assert step["env"]["PW_ALL_BROWSERS"] == "1"
        assert step["env"]["CI"] == "1"
    assert browser_tests[1]["env"]["E2E_SERVER"] == "1"
    assert browser_tests[1]["env"]["E2E_LIVEKIT"] == "ws://127.0.0.1:7880"
    assert "DATABASE_URL" in browser_tests[1]["env"]

    for gate, tested in (("rust", "rust-integration"), ("web", "web-browser")):
        job = jobs[gate]
        assert job.get("if") == "always()", f"The {gate} gate must run after failure"
        assert dependencies(job) == {tested}
        assert len(job["steps"]) == 1
        assert job["steps"][0]["run"] == 'test "$RESULT" = success'
        assert job["steps"][0]["env"]["RESULT"] == "${{ needs." + tested + ".result }}"


def validate_publication(images, security):
    validate_required_execution(images)
    validate_required_execution(security)
    assert set(images["on"]) == {"push"}, "Images owns main and tag pushes"
    assert images["on"]["push"]["branches"] == ["main"]
    assert images["on"]["push"]["tags"] == ["v*"]
    assert images["permissions"] == {"contents": "read"}
    validation = images["jobs"]["validation"]
    assert validation["uses"] == "./.github/workflows/ci.yml"
    assert validation["permissions"] == {"contents": "read"}
    assert "if" not in validation, "Every publication must run validation"
    build = images["jobs"]["build"]
    assert dependencies(build) == {"validation"}, "Publication must wait for CI"
    assert "if" not in build, "Publication cannot bypass failed validation"
    assert build["permissions"] == {"contents": "read", "packages": "write"}
    for name, job in images["jobs"].items():
        if name != "build":
            assert job.get("permissions", images["permissions"]) == {"contents": "read"}

    assert set(security["on"]) == {"workflow_call", "schedule", "workflow_dispatch"}, (
        "CI calls the audit; standalone PR and push audits would duplicate it"
    )
    assert security["on"]["schedule"] == [{"cron": "23 4 * * *"}]
    assert security["permissions"] == {"contents": "read"}
    for job in security["jobs"].values():
        assert job.get("permissions", security["permissions"]) == {"contents": "read"}
    deny = next(step for step in security["jobs"]["deny"]["steps"]
                if step.get("uses", "").startswith("EmbarkStudios/cargo-deny-action@"))
    assert deny["with"]["command"] == "check"
    assert deny["with"]["arguments"] == "--all-features"


class GraphTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        # BaseLoader keeps the YAML key `on` and quoted environment scalars intact.
        cls.workflow, cls.images, cls.security = (
            yaml.load((WORKFLOWS / name).read_text(), Loader=yaml.BaseLoader)
            for name in ("ci.yml", "images.yml", "security.yml")
        )

    def test_current_graph(self):
        validate(self.workflow)

    def test_current_publication_and_audit(self):
        validate_publication(self.images, self.security)

    def rejected(self, change):
        workflow = deepcopy(self.workflow)
        change(workflow)
        with self.assertRaises(AssertionError):
            validate(workflow)

    def test_missing_cheap_gate(self):
        for omitted in CHEAP:
            with self.subTest(omitted=omitted):
                self.rejected(lambda w: w["jobs"]["rust-checks"].update(
                    needs=sorted(CHEAP - {omitted})))

    def test_early_database(self):
        self.rejected(lambda w: w["jobs"]["web-checks"].update(
            services={"postgres": {"image": "postgres:18"}}))

    def test_early_compilation(self):
        self.rejected(lambda w: w["jobs"]["web-checks"]["steps"].append(
            {"run": "cargo build -p chat-core"}))

    def test_browser_bypasses_units(self):
        self.rejected(lambda w: w["jobs"]["web-browser"].update(needs="rust-checks"))

    def test_browser_bypasses_integration(self):
        self.rejected(lambda w: w["jobs"]["web-browser"].update(needs="web-build"))

    def test_failure_artifacts_expire_after_1_day(self):
        self.rejected(lambda w: next(
            step for step in w["jobs"]["web-browser"]["steps"]
            if step.get("uses", "").startswith("actions/upload-artifact@")
        )["with"].update({"retention-days": "90"}))

    def test_duplicate_ci_push(self):
        self.rejected(lambda w: w["on"].update(push={"branches": ["main"]}))

    def test_gate_cannot_succeed_after_skip(self):
        self.rejected(lambda w: w["jobs"]["web"].pop("if"))
        self.rejected(lambda w: w["jobs"]["rust"]["steps"][0].update(run="true"))

    def test_broken_artifact_parent(self):
        self.rejected(lambda w: w["jobs"]["web-browser"]["steps"][1]["with"].update(path="."))

    def test_full_units_and_drift_check_are_mandatory(self):
        for command in ("pnpm test", "diff -u"):
            with self.subTest(command=command):
                self.rejected(lambda w: w["jobs"]["web-build"].update(steps=[
                    step for step in w["jobs"]["web-build"]["steps"]
                    if command not in step.get("run", "")
                ]))

    def test_focused_deletion_checks_are_mandatory(self):
        for command in ("src/core/deletions.test.ts", "src/core/me-deletion-sync.test.ts",
                        "src/core/devices.test.ts", "src/core/calls.test.ts", "src/ui/deletion.test.ts"):
            with self.subTest(command=command):
                self.rejected(lambda w: w["jobs"]["web-checks"].update(steps=[
                    {**step, "run": step["run"].replace(command, "")} if "run" in step else step
                    for step in w["jobs"]["web-checks"]["steps"]
                ]))

    def test_all_browser_engines_are_mandatory(self):
        self.rejected(lambda w: next(
            step for step in w["jobs"]["web-browser"]["steps"]
            if step.get("run") == "pnpm --filter web e2e"
        )["env"].update(PW_ALL_BROWSERS="0"))

    def test_cycle(self):
        self.rejected(lambda w: w["jobs"]["rust-checks"].update(needs="web-build"))

    def rejected_publication(self, change):
        images, security = deepcopy(self.images), deepcopy(self.security)
        change(images, security)
        with self.assertRaises(AssertionError):
            validate_publication(images, security)

    def test_cheap_validation_cannot_fail_softly(self):
        self.rejected(lambda w: w["jobs"]["web-checks"].update({"continue-on-error": "true"}))
        self.rejected(lambda w: w["jobs"]["build-controls"]["steps"][1].update(
            {"continue-on-error": "true"}))

    def test_required_validation_cannot_be_conditional(self):
        self.rejected(lambda w: w["jobs"]["helm"].update({"if": "false"}))
        self.rejected(lambda w: next(
            step for step in w["jobs"]["web-build"]["steps"]
            if step.get("run") == "pnpm test"
        ).update({"if": "false"}))
        self.rejected(lambda w: next(
            step for step in w["jobs"]["web-build"]["steps"]
            if step.get("run") == "pnpm test"
        ).update(run="pnpm test || true"))

    def test_failed_validation_cannot_publish_images(self):
        for condition in ("always()", "failure()", "true"):
            with self.subTest(condition=condition):
                self.rejected_publication(lambda images, _: images["jobs"]["build"].update(
                    {"if": condition}))
        self.rejected_publication(lambda images, _: images["jobs"]["validation"].update(
            {"continue-on-error": "true"}))
        self.rejected_publication(lambda images, _: images["jobs"]["build"]["steps"][0].update(
            {"if": "false"}))

    def test_security_validation_cannot_fail_softly(self):
        self.rejected_publication(lambda _, security: security["jobs"]["deny"].update(
            {"continue-on-error": "true"}))
        self.rejected_publication(lambda _, security: security["jobs"]["deny"]["steps"][1].update(
            {"continue-on-error": "true"}))

    def test_image_build_missing_validation(self):
        self.rejected_publication(lambda images, _: images["jobs"]["build"].pop("needs"))

    def test_validation_cannot_write_packages(self):
        self.rejected_publication(lambda images, _: images["jobs"]["validation"]["permissions"].update(
            packages="write"))

    def test_no_standalone_security_pr(self):
        self.rejected_publication(lambda _, security: security["on"].update(pull_request=""))

    def test_security_is_read_only(self):
        self.rejected_publication(lambda _, security: security["permissions"].update(
            packages="write"))
        self.rejected_publication(lambda _, security: security["jobs"]["deny"].update(
            permissions={"contents": "write"}))

    def test_security_retains_daily_and_manual_runs(self):
        for trigger in ("schedule", "workflow_dispatch", "workflow_call"):
            with self.subTest(trigger=trigger):
                self.rejected_publication(lambda _, security: security["on"].pop(trigger))


if __name__ == "__main__":
    unittest.main()
