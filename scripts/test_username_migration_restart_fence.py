import json
import os
import subprocess
import sys
import tempfile
import unittest

from username_migration_restart_fence import FenceError, RestartFence

CID = "a" * 64
NO = {"Name": "no", "MaximumRetryCount": 0}
ALWAYS = {"Name": "always", "MaximumRetryCount": 0}


class Adapter:
    def __init__(self):
        self.unit = {"enabled": True, "masked": False}
        self.policies = {CID: dict(ALWAYS)}
        self.fail = None

    def unit_state(self):
        return dict(self.unit)

    def policy(self, cid):
        return dict(self.policies[cid])

    def mask(self):
        self.unit["masked"] = True
        if self.fail == "mask":
            raise RuntimeError("secret")

    def unmask(self):
        self.unit["masked"] = False

    def set_policy(self, cid, policy):
        self.policies[cid] = dict(policy)
        if self.fail == "policy":
            raise RuntimeError("secret")


class Tests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        os.chmod(self.tmp.name, 0o700)
        self.fd = os.open(self.tmp.name, os.O_RDONLY | os.O_DIRECTORY)
        self.adapter = Adapter()
        self.fence = RestartFence(self.fd, "operation", self.adapter)

    def tearDown(self):
        self.fence.close()
        os.close(self.fd)
        self.tmp.cleanup()

    def test_recovery_and_boundary(self):
        self.adapter.fail = "mask"
        with self.assertRaisesRegex(FenceError, "Fence operation failed") as caught:
            self.fence.engage([CID])
        self.assertNotIn("secret", str(caught.exception))
        with open(os.path.join(self.tmp.name, "operation", "intent.json")) as f:
            self.assertEqual(json.load(f)["containers"][CID], ALWAYS)
        self.adapter.fail = None
        self.fence.engage([CID])
        self.assertTrue(self.adapter.unit["masked"])
        self.assertEqual(self.adapter.policy(CID), NO)
        with self.assertRaises(FenceError):
            self.fence.restore("old_ready", lambda _: False)
        self.assertEqual(self.adapter.policy(CID), NO)
        self.fence.restore("old_ready", lambda _: True)
        self.fence.restore("old_ready", lambda _: True)
        self.assertEqual(self.adapter.policy(CID), ALWAYS)
        self.assertEqual(self.adapter.unit, {"enabled": True, "masked": False})

    def test_existing_mask_preserved(self):
        self.adapter.unit["masked"] = True
        self.fence.engage([CID])
        self.fence.restore("committed", lambda _: True)
        self.assertTrue(self.adapter.unit["masked"])

    def test_unsupported_policy_fails_before_effect(self):
        self.adapter.policies[CID] = {"Name": "bad", "MaximumRetryCount": 0}
        with self.assertRaises(FenceError):
            self.fence.engage([CID])
        self.assertFalse(self.adapter.unit["masked"])
        self.assertFalse(os.path.exists(os.path.join(self.tmp.name, "operation", "intent.json")))

    def test_symlink_journal_rejected(self):
        os.symlink("/etc/passwd", os.path.join(self.tmp.name, "operation", "intent.json"))
        with self.assertRaises(FenceError):
            self.fence.engage([CID])
        self.assertFalse(self.adapter.unit["masked"])

    def test_process_crash_after_effect_recovers_from_intent(self):
        # The subprocess uses a fake adapter only; it exits after the mask.
        code = '''
import os, sys
from username_migration_restart_fence import RestartFence
class Fake:
 def unit_state(self): return {"enabled": True, "masked": False}
 def policy(self, cid): return {"Name": "always", "MaximumRetryCount": 0}
 def mask(self): os._exit(42)
fd = os.open(sys.argv[1], os.O_RDONLY | os.O_DIRECTORY)
RestartFence(fd, "crash", Fake()).engage(["a" * 64])
'''
        result = subprocess.run([sys.executable, "-c", code, self.tmp.name], cwd=os.path.dirname(__file__), check=False)
        self.assertEqual(result.returncode, 42)
        other = RestartFence(self.fd, "crash", self.adapter)
        try:
            other.engage([CID])
            other.restore("committed", lambda _: True)
            self.assertEqual(self.adapter.policy(CID), ALWAYS)
        finally:
            other.close()


if __name__ == "__main__":
    unittest.main()
