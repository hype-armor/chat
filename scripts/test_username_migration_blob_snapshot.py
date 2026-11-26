import json
import subprocess
import unittest

import username_migration_blob_snapshot as snapshot


IMAGE = "helper@sha256:" + "a" * 64
ID = "b" * 64


class FakeDocker:
    def __init__(self, status="exited", mounts=None):
        self.status = status
        self.mounts = [{"Type": "volume", "Name": "seaweed"}] if mounts is None else mounts
        self.calls = []

    def __call__(self, args, **kwargs):
        self.calls.append(args)
        assert kwargs == {"check": True, "capture_output": True, "text": True}
        if args[1:3] == ["volume", "inspect"]:
            output = json.dumps([{"Name": "seaweed", "Driver": "local"}])
        elif args[1] == "ps":
            output = ID + "\n"
        elif args[1] == "inspect":
            output = json.dumps([{"Id": ID, "State": {"Status": self.status}, "Mounts": self.mounts}])
        else:
            raise AssertionError(args)
        return subprocess.CompletedProcess(args, 0, output, "")


class SnapshotTests(unittest.TestCase):
    def test_inactive_volume_still_cannot_publish(self):
        runner = FakeDocker()
        with self.assertRaises(snapshot.UnsupportedSnapshot):
            snapshot.snapshot("seaweed", IMAGE, runner=runner)
        self.assertEqual(len(runner.calls), 3)
        self.assertTrue(all(call[1] in {"volume", "ps", "inspect"} for call in runner.calls))

    def test_active_users_fail(self):
        for state in ("running", "paused", "restarting", "removing"):
            with self.subTest(state=state), self.assertRaises(snapshot.SnapshotError):
                snapshot.preflight("seaweed", IMAGE, runner=FakeDocker(state))

    def test_invalid_inputs_never_call_docker(self):
        runner = FakeDocker()
        for volume, image in (("-bad", IMAGE), ("seaweed", "helper:latest")):
            with self.assertRaises(snapshot.SnapshotError):
                snapshot.preflight(volume, image, runner=runner)
        self.assertEqual(runner.calls, [])

    def test_malformed_mount_fails_closed(self):
        with self.assertRaises(snapshot.SnapshotError):
            snapshot.preflight("seaweed", IMAGE, runner=FakeDocker(mounts=[{"Type": "volume"}]))

    def test_docker_failure_fails_closed(self):
        def failed(*args, **kwargs):
            raise subprocess.CalledProcessError(1, args[0])
        with self.assertRaises(snapshot.SnapshotError):
            snapshot.preflight("seaweed", IMAGE, runner=failed)


if __name__ == "__main__":
    unittest.main()
