import os
import tempfile
import unittest
from pathlib import Path

from username_migration_systemd_gate import GateError, SystemdGate


class GateTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        (self.root / "state").mkdir()
        (self.root / "unit.d").mkdir()
        self.marker = str(self.root / "state" / "marker")
        self.dropin = str(self.root / "unit.d" / "90-chat-maintenance.conf")
        self.calls = []
        self.fail_reload = False
        self.runtime = False
        self.gate = self.new_gate()

    def new_gate(self):
        return SystemdGate("op1", runner=self.run_systemctl, marker=self.marker,
                           dropin=self.dropin, trusted_root=str(self.root))

    def run_systemctl(self, args):
        self.calls.append(args)
        if args == ["daemon-reload"]:
            if self.fail_reload:
                raise OSError("lost reply")
            return ""
        return ("LoadState=loaded\nFragmentPath=/etc/systemd/system/pi-chat.service\n"
                f"DropInPaths={self.dropin}{' /run/systemd/system/foo.conf' if self.runtime else ''}\n"
                "Conditions={ type=ConditionPathExists ; trigger=no ; negate=yes ; "
                f"path={self.marker} ; state=failed }}\n")

    def test_engage_and_old_ready_release(self):
        self.gate.engage()
        self.assertEqual(Path(self.marker).read_text(), "op1\n")
        self.assertIn("ConditionPathExists=!", Path(self.dropin).read_text())
        with self.assertRaises(GateError):
            self.gate.clear_old_ready(lambda: False)
        self.gate.clear_old_ready(lambda: True)
        self.assertFalse(Path(self.marker).exists())
        self.assertFalse(Path(self.dropin).exists())
        self.assertFalse(any("stop" in a or "start" in a for a in self.calls))

    def test_lost_reload_reply_and_reboot_resume(self):
        self.fail_reload = True
        with self.assertRaises(GateError):
            self.gate.engage()
        self.assertTrue(Path(self.marker).exists())
        self.assertTrue(Path(self.dropin).exists())
        self.fail_reload = False
        self.new_gate().engage(resume=True)

    def test_interruption_after_marker(self):
        Path(self.marker).write_text("op1\n")
        self.gate.engage(resume=True)
        self.assertTrue(Path(self.dropin).exists())

    def test_existing_admin_files_rejected(self):
        Path(self.dropin).write_text("admin\n")
        with self.assertRaises(GateError):
            self.gate.engage()
        self.assertEqual(Path(self.dropin).read_text(), "admin\n")
        self.assertFalse(Path(self.marker).exists())

    def test_symlink_marker_rejected(self):
        os.symlink(self.root / "target", self.marker)
        with self.assertRaises(GateError):
            self.gate.engage(resume=True)
        self.assertFalse((self.root / "target").exists())

    def test_runtime_config_rejected(self):
        self.runtime = True
        with self.assertRaises(GateError):
            self.gate.engage()
        self.assertTrue(Path(self.marker).exists())

    def test_unsafe_directory_and_path_rejected(self):
        os.chmod(self.root / "state", 0o777)
        with self.assertRaises(GateError):
            self.gate.engage()
        with self.assertRaises(GateError):
            SystemdGate("op1", runner=self.run_systemctl, marker=str(self.root / "bad path"),
                        dropin=self.dropin, trusted_root=str(self.root))

    def test_changed_operation_rejected(self):
        self.gate.engage()
        other = SystemdGate("op2", runner=self.run_systemctl, marker=self.marker,
                            dropin=self.dropin, trusted_root=str(self.root))
        with self.assertRaises(GateError):
            other.engage(resume=True)


if __name__ == "__main__":
    unittest.main()
