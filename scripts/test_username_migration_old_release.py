import unittest
from unittest.mock import Mock

from username_migration_old_release import OldRelease, OldReleaseError


class Adapter:
    def __init__(self):
        self.released = False
        self.events = []
        self.fail = None

    def step(self, name):
        self.events.append(name)
        if self.fail == name:
            raise RuntimeError("injected")

    def release_recorded(self):
        self.step("read")
        return self.released

    def verify_release_preconditions(self):
        self.step("verify")
        return True

    def record_release(self):
        self.released = True  # An error may occur after the durable write.
        self.step("record")

    def restore_database(self):
        self.step("restore")

    def start_old_database(self):
        self.step("database")
        assert self.released

    def start_old_services(self):
        self.step("services")
        assert self.released

    def old_health_check(self):
        self.step("health")
        return True

    def record_old_ready(self):
        self.step("ready")


class OldReleaseTests(unittest.TestCase):
    def test_restore_and_release_order(self):
        adapter = Adapter()
        protocol = OldRelease(adapter)
        protocol.restore()
        protocol.release()
        self.assertEqual(adapter.events, ["read", "restore", "read", "verify", "record", "read", "database", "services", "health", "ready"])
        with self.assertRaises(OldReleaseError):
            protocol.restore()
        self.assertEqual(adapter.events[-1], "read")

    def test_failure_at_every_release_step_never_restores_after_boundary(self):
        for step in ("record", "database", "services", "health", "ready"):
            with self.subTest(step=step):
                adapter = Adapter()
                adapter.fail = step
                protocol = OldRelease(adapter)
                with self.assertRaises(OldReleaseError):
                    protocol.release()
                self.assertTrue(adapter.released)
                adapter.fail = None
                with self.assertRaises(OldReleaseError):
                    protocol.restore()
                protocol.release()
                self.assertEqual(adapter.events[-1], "ready")
                self.assertNotIn("restore", adapter.events)

    def test_precondition_failure_keeps_database_closed(self):
        adapter = Adapter()
        adapter.verify_release_preconditions = Mock(return_value=False)
        with self.assertRaises(OldReleaseError):
            OldRelease(adapter).release()
        self.assertFalse(adapter.released)
        self.assertNotIn("database", adapter.events)
        OldRelease(adapter).restore()
        self.assertIn("restore", adapter.events)

    def test_ambiguous_read_fails_closed(self):
        for value in (None, 0, 1, "false"):
            adapter = Adapter()
            adapter.release_recorded = Mock(return_value=value)
            with self.assertRaises(OldReleaseError):
                OldRelease(adapter).restore()
            with self.assertRaises(OldReleaseError):
                OldRelease(adapter).release()
            self.assertEqual(adapter.events, [])

    def test_failed_durability_confirmation_never_starts_database(self):
        adapter = Adapter()
        adapter.release_recorded = Mock(side_effect=[False, False])
        with self.assertRaises(OldReleaseError):
            OldRelease(adapter).release()
        self.assertNotIn("database", adapter.events)
        self.assertNotIn("services", adapter.events)

    def test_failed_health_never_marks_ready_or_restores(self):
        adapter = Adapter()
        adapter.old_health_check = Mock(return_value=False)
        protocol = OldRelease(adapter)
        with self.assertRaises(OldReleaseError):
            protocol.release()
        self.assertNotIn("ready", adapter.events)
        with self.assertRaises(OldReleaseError):
            protocol.restore()


if __name__ == "__main__":
    unittest.main()
