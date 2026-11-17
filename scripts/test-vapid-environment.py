#!/usr/bin/env python3
"""Check VAPID loading without Docker, sudo, private files, or helper execution."""
import json
import os
from pathlib import Path
import shlex
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
UNIT = (ROOT / "deploy/systemd/pi-chat.service").read_text()
REPAIR = (ROOT / "scripts/repair-compose-vapid.sh").read_text()


class VapidEnvironmentTests(unittest.TestCase):
    def check_unit_command(self, name, action):
        line = next(line for line in UNIT.splitlines() if line.startswith(name + "="))
        self.assertEqual(
            shlex.split(line.split("=", 1)[1]),
            ["/usr/bin/docker", "compose", "--env-file", "/srv/chat/.env",
             "-f", "deploy/compose/docker-compose.yml", *action],
        )

    def test_start_loads_the_persistent_compose_environment(self):
        self.check_unit_command("ExecStart", ["up", "-d"])

    def test_stop_uses_the_same_compose_environment(self):
        self.check_unit_command("ExecStop", ["stop"])

    def test_systemd_does_not_open_the_checkout_environment_itself(self):
        self.assertFalse(any(line.startswith("EnvironmentFile=") for line in UNIT.splitlines()))

    def test_recreate_unsets_shadowing_variables_and_quotes_the_env_path(self):
        # Execute only the extracted recreation command. Never run the helper's
        # key generation, file-writing, backup, or real container operations.
        lines = REPAIR.splitlines()
        start = next(i for i, line in enumerate(lines) if line.startswith("sudo env "))
        invocation = []
        while True:
            invocation.append(lines[start])
            start += 1
            if not invocation[-1].endswith("\\"):
                break
        command = "\n".join(invocation)
        with tempfile.TemporaryDirectory(prefix="vapid-command-test-") as temporary:
            directory = Path(temporary)
            fake_bin = directory / "bin"
            fake_bin.mkdir()
            sudo = fake_bin / "sudo"
            sudo.write_text('#!/bin/sh\nexec "$@"\n')
            docker = fake_bin / "docker"
            docker.write_text(
                f"#!{sys.executable}\nimport json, os, sys\n"
                "print(json.dumps({'args': sys.argv[1:], "
                "'key_present': 'CHAT_VAPID_PRIVATE_KEY' in os.environ, "
                "'subject_present': 'CHAT_VAPID_SUBJECT' in os.environ}))\n"
            )
            sudo.chmod(0o700)
            docker.chmod(0o700)
            fixture_repo = str(directory / "fixture checkout with spaces")
            for inherited in ("", "synthetic-stale-value"):
                with self.subTest(inherited=inherited):
                    result = subprocess.run(
                        ["/bin/bash", "-eu", "-c", 'repo=$1; env_file=.env\n' + command,
                         "vapid-command-test", fixture_repo],
                        env={"PATH": str(fake_bin) + os.pathsep + os.defpath,
                             "CHAT_VAPID_PRIVATE_KEY": inherited,
                             "CHAT_VAPID_SUBJECT": inherited},
                        text=True, capture_output=True, check=True, timeout=5,
                    )
                    recorded = json.loads(result.stdout)
                    self.assertFalse(recorded["key_present"])
                    self.assertFalse(recorded["subject_present"])
                    self.assertEqual(
                        recorded["args"],
                        ["compose", "--env-file", fixture_repo + "/.env",
                         "-f", "deploy/compose/docker-compose.yml", "up", "-d",
                         "--force-recreate", "server"],
                    )


if __name__ == "__main__":
    unittest.main()
