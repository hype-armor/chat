import unittest

from model import Model, Stop


class ReleaseTests(unittest.TestCase):
    def fresh(self):
        return Model("op-1", trusted_fresh_genesis=True, synthetic_witnesses={"old_ready", "operation_bound"})

    def set_phase(self, m, phase):
        phases = ["old_ready", "old_releasing", "rolled_back"]
        m.phase = m.durable_phase = phase
        m.durable_history = phases[:phases.index(phase) + 1]

    def test_order_and_idempotence(self):
        m = self.fresh()
        m.release()
        self.assertEqual(m.events, ["journal:old_releasing", "unlink:update", "fsync:update", "unlink:systemd", "fsync:systemd", "journal:rolled_back"])
        self.assertEqual(m.durable_phase, "rolled_back")
        m.release()
        self.assertEqual(m.restore_calls, 0)

    def test_lock_and_witnesses(self):
        m = self.fresh()
        m.locked = True
        with self.assertRaises(Stop): m.release()
        m.locked = False
        m.synthetic_witnesses.remove("operation_bound")
        with self.assertRaises(Stop): m.release()
        self.assertEqual(m.events, [])

    def test_legacy_old_ready_absent_fails_closed(self):
        for gate in ("update", "systemd"):
            m = self.fresh()
            m.markers[gate] = None
            m.durable_markers[gate] = None
            with self.assertRaises(Stop): m.release()
            self.assertEqual(m.durable_phase, "old_ready")
            self.assertEqual(m.events, [])

    def test_foreign_markers_never_removed(self):
        for phase in ("old_ready", "old_releasing"):
            for gate in ("update", "systemd"):
                m = self.fresh()
                self.set_phase(m, phase)
                m.markers[gate] = m.durable_markers[gate] = "other-op"
                with self.assertRaises(Stop): m.release()
                self.assertEqual(m.events, [])
                self.assertEqual(m.markers[gate], "other-op")

    def test_reconcile_absence_only_in_durable_release(self):
        for missing in (("update",), ("update", "systemd")):
            m = self.fresh()
            self.set_phase(m, "old_releasing")
            for gate in missing:
                m.markers[gate] = m.durable_markers[gate] = None
            m.release()
            self.assertEqual(m.durable_phase, "rolled_back")
            for gate in missing:
                self.assertNotIn("unlink:" + gate, m.events)

    def test_reversed_order_fails_closed_after_recovery(self):
        m = self.fresh()
        self.set_phase(m, "old_releasing")
        m.durable_markers["systemd"] = None
        m.crash()
        with self.assertRaises(Stop): m.release()
        self.assertEqual(m.events, ["crash"])
        self.assertEqual(m.durable_markers["update"], "op-1")

    def test_rolled_back_requires_both_markers_absent(self):
        for gate in ("update", "systemd"):
            m = self.fresh()
            self.set_phase(m, "rolled_back")
            m.markers = m.durable_markers = {"update": None, "systemd": None}
            m.markers[gate] = "op-1"
            with self.assertRaises(Stop): m.release()
            self.assertEqual(m.events, [])

    def test_restore_checks_durable_phase_and_retained_history(self):
        for durable, history in (("old_ready", ["before"]),
                                 ("before", ["before", "old_ready"])):
            m = Model("op-1", phase="before", durable_phase=durable,
                      durable_history=history)
            with self.assertRaises(Stop): m.restore()
            self.assertEqual(m.restore_calls, 0)

    def test_reconstructed_model_uses_retained_history_not_events(self):
        m = self.fresh()
        m.release()
        retained = m.durable_history.copy()
        rebuilt = Model("op-1", phase="before", durable_phase="before",
                        durable_history=retained)
        self.assertEqual(rebuilt.events, [])
        with self.assertRaises(Stop): rebuilt.restore()
        self.assertEqual(rebuilt.restore_calls, 0)

    def test_mismatched_marker_snapshots_fail_closed(self):
        m = self.fresh()
        self.set_phase(m, "old_releasing")
        m.markers["update"] = None
        with self.assertRaises(Stop): m.release()
        self.assertEqual(m.events, [])

    def test_faults_and_both_durable_outcomes(self):
        points = ["journal_write_old_releasing", "journal_fsync_old_releasing",
                  "unlink_update", "fsync_update", "unlink_systemd", "fsync_systemd",
                  "journal_write_rolled_back", "journal_fsync_rolled_back"]
        for point in points:
            for persisted in (False, True):
                with self.subTest(point=point, persisted=persisted):
                    m = self.fresh()
                    with self.assertRaises(Stop): m.release(point)
                    evidence = m.events.copy()
                    with self.assertRaises(Stop): m.release()
                    self.assertEqual(m.events, evidence)
                    if persisted:
                        if point.startswith("journal_"):
                            phase = point.split("_", 2)[2]
                            m.durable_phase = phase
                            m.durable_history.append(phase)
                        else:
                            gate = point.split("_", 1)[1]
                            m.durable_markers[gate] = None
                    m.crash()
                    m.release()
                    self.assertEqual(m.durable_phase, "rolled_back")
                    self.assertEqual(m.durable_markers, {"update": None, "systemd": None})
                    self.assertEqual(m.restore_calls, 0)
                    self.assertEqual(m.events[:len(evidence)], evidence)

    def test_reconstructed_snapshots_require_exact_keys(self):
        for phase, history in (("old_releasing", ["old_ready", "old_releasing"]),
                               ("rolled_back", ["old_ready", "old_releasing", "rolled_back"])):
            for snapshot in ({}, {"update": None}, {"systemd": None},
                             {"update": None, "systemd": None, "extra": None}):
                with self.subTest(phase=phase, snapshot=snapshot):
                    m = Model("op-1", phase=phase, durable_phase=phase,
                              markers=snapshot.copy(), durable_markers=snapshot.copy(),
                              durable_history=history.copy())
                    with self.assertRaises(Stop): m.release()
                    self.assertEqual(m.events, [])

    def test_reconstructed_history_must_be_complete_and_current(self):
        for history in (None, [], ["old_releasing"], ["old_ready", "rolled_back"],
                        ["old_ready", "old_releasing", "old_ready"]):
            m = Model("op-1", phase="old_ready", durable_phase="old_ready",
                      markers={"update": "op-1", "systemd": "op-1"},
                      durable_markers={"update": "op-1", "systemd": "op-1"},
                      durable_history=history,
                      synthetic_witnesses={"old_ready", "operation_bound"})
            with self.assertRaises(Stop): m.release()
            with self.assertRaises(Stop): m.restore()
            self.assertEqual(m.events, [])
        with self.assertRaises(Stop): Model("op-1", phase="before", durable_phase="before").restore()
        Model("op-1", phase="before", durable_phase="before", durable_history=["before"]).restore()

    def test_repeated_crashes_and_reconstruction(self):
        m = self.fresh()
        for fault in ("journal_fsync_old_releasing", "fsync_update", "fsync_systemd", "journal_fsync_rolled_back"):
            with self.assertRaises(Stop): m.release(fault)
            if fault.startswith("journal_"):
                phase = fault.split("_", 2)[2]
                m.durable_phase = phase
                m.durable_history.append(phase)
            else:
                m.durable_markers[fault.split("_", 1)[1]] = None
            m.crash()
            m = Model("op-1", phase=m.phase, durable_phase=m.durable_phase,
                      markers=m.markers.copy(), durable_markers=m.durable_markers.copy(),
                      durable_history=m.durable_history.copy(),
                      synthetic_witnesses={"old_ready", "operation_bound"})
        m.release()
        self.assertEqual(m.durable_history, ["old_ready", "old_releasing", "rolled_back"])
        self.assertEqual(m.durable_markers, {"update": None, "systemd": None})

    def test_restore_forbidden(self):
        for phase in ("old_ready", "old_releasing", "rolled_back"):
            m = self.fresh()
            self.set_phase(m, phase)
            with self.assertRaises(Stop): m.restore()
            self.assertEqual(m.restore_calls, 0)

    def test_volatile_release_phase_is_not_enough(self):
        m = self.fresh()
        m.phase = "old_releasing"
        m.markers["update"] = None
        with self.assertRaises(Stop): m.release()
        self.assertEqual(m.events, [])


if __name__ == "__main__":
    unittest.main()
