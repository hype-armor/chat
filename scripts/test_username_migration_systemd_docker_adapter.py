import json
import os
import subprocess
import tempfile
import unittest
from types import SimpleNamespace

from username_migration_systemd_docker_adapter import AdapterError, SystemdDockerAdapter

CID = "a" * 64
NO = {"Name": "no", "MaximumRetryCount": 0}


class Fake:
    def __init__(self):
        self.state = "disabled"
        self.policy = {"Name": "on-failure", "MaximumRetryCount": 3}
        self.calls = []
        self.fail_after_effect = False
        self.output = None
        self.fail = False

    def __call__(self, args, **kwargs):
        self.calls.append(args)
        if self.fail:
            raise subprocess.TimeoutExpired(args, 30, output="secret")
        if args[:2] == ["systemctl", "show"]:
            out = self.state + "\n"
        elif args[:2] == ["systemctl", "mask"]:
            self.state = "masked"
            out = ""
        elif args[:2] == ["systemctl", "unmask"]:
            self.state = "disabled"
            out = ""
        elif args[:2] == ["docker", "inspect"]:
            out = json.dumps(self.policy)
        elif args[:2] == ["docker", "update"]:
            value = args[3].split(":")
            self.policy = {"Name": value[0], "MaximumRetryCount": int(value[1]) if len(value) == 2 else 0}
            out = CID
        else:
            raise AssertionError(args)
        if self.fail_after_effect and args[1] in ("mask", "update"):
            self.fail_after_effect = False
            raise subprocess.TimeoutExpired(args, 30, output="secret")
        return SimpleNamespace(returncode=0, stdout=self.output if self.output is not None else out)


class AdapterTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.fake = Fake()
        self.adapter = SystemdDockerAdapter(self.fake, self.tmp.name)

    def owned(self):
        self.adapter.owned_mask = True  # Caller first persists original state and ownership.

    def test_capture_mutate_verify_and_explicit_restore(self):
        original = self.adapter.unit_state()
        policy = self.adapter.policy(CID)
        self.owned()
        self.adapter.mask()
        self.adapter.set_policy(CID, NO)
        self.assertEqual(self.adapter.unit_state(), {"enabled": False, "masked": True})
        self.adapter.set_policy(CID, policy)
        self.adapter.unmask()
        self.assertEqual(self.adapter.unit_state(), original)
        self.assertIn(["docker", "update", "--restart", "on-failure:3", CID], self.fake.calls)

    def test_enabled_beneath_mask(self):
        os.mkdir(os.path.join(self.tmp.name, "multi-user.target.wants"))
        os.symlink("/lib/systemd/system/pi-chat.service", os.path.join(self.tmp.name, "multi-user.target.wants", "pi-chat.service"))
        self.fake.state = "enabled"
        self.assertTrue(self.adapter.unit_state()["enabled"])
        self.owned()
        self.adapter.mask()
        self.assertEqual(self.adapter.unit_state(), {"enabled": True, "masked": True})

    def test_reject_preexisting_and_runtime_masks(self):
        for state in ("masked", "masked-runtime", "enabled-runtime", "static", "disabled\nsecret"):
            self.fake.state = state
            with self.subTest(state=state), self.assertRaises(AdapterError):
                self.adapter.unit_state()
        with self.assertRaises(AdapterError):
            self.adapter.unmask()
        self.assertFalse(any(call[1] == "unmask" for call in self.fake.calls))

    def test_malformed_and_daemon_errors_are_sanitized(self):
        for output in ("secret", '{}', '{"Name":"always","MaximumRetryCount":2}', '{"Name":"bad","MaximumRetryCount":0}', '{"Name":"no","MaximumRetryCount":false}'):
            self.fake.output = output
            with self.subTest(output=output), self.assertRaises(AdapterError) as caught:
                self.adapter.policy(CID)
            self.assertNotIn("secret", str(caught.exception))
        self.fake.fail = True
        with self.assertRaises(AdapterError) as caught:
            self.adapter.policy(CID)
        self.assertNotIn("secret", str(caught.exception))
        self.fake.fail = False
        self.fake.output = None
        # A nonzero result must also fail closed.
        self.adapter.runner = lambda *a, **k: SimpleNamespace(returncode=1, stdout="secret")
        with self.assertRaises(AdapterError):
            self.adapter.policy(CID)

    def test_invalid_input_does_not_execute(self):
        for cid in ("a" * 63, "A" * 64, "--help", None):
            with self.assertRaises(AdapterError):
                self.adapter.policy(cid)
        with self.assertRaises(AdapterError):
            self.adapter.set_policy(CID, {"Name": "always", "MaximumRetryCount": 1})
        self.assertEqual(self.fake.calls, [])

    def test_lost_replies_retry(self):
        self.adapter.unit_state()
        self.owned()
        self.fake.fail_after_effect = True
        with self.assertRaises(AdapterError):
            self.adapter.mask()
        self.adapter.mask()
        self.fake.fail_after_effect = True
        with self.assertRaises(AdapterError):
            self.adapter.set_policy(CID, NO)
        self.adapter.set_policy(CID, NO)
        self.assertEqual(self.adapter.policy(CID), NO)

    def test_reinspection_detects_no_effect(self):
        def runner(args, **kwargs):
            if args[:2] == ["docker", "update"]:
                return SimpleNamespace(returncode=0, stdout="")
            return self.fake(args, **kwargs)
        self.adapter.runner = runner
        with self.assertRaises(AdapterError):
            self.adapter.set_policy(CID, NO)


if __name__ == "__main__":
    unittest.main()
