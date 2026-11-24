"""Test-only state machine. This is not a fence or deployment code."""
from dataclasses import dataclass, field
from typing import Dict, List, Optional, Set


class Stop(Exception):
    """Fail closed. State is retained for inspection and retry."""


@dataclass
class Model:
    operation: str
    phase: str = "old_ready"
    markers: Optional[Dict[str, Optional[str]]] = None
    durable_phase: str = "old_ready"
    durable_markers: Optional[Dict[str, Optional[str]]] = None
    # Synthetic retained history is not durable operational evidence.
    durable_history: Optional[List[str]] = None
    # Only a fixture that knows this is a new operation may set this flag.
    trusted_fresh_genesis: bool = False
    events: List[str] = field(default_factory=list)
    restore_calls: int = 0
    locked: bool = False
    uncertain: bool = False
    synthetic_witnesses: Set[str] = field(default_factory=set)

    def __post_init__(self):
        if self.trusted_fresh_genesis:
            if (self.phase != "old_ready" or self.durable_phase != "old_ready"
                    or self.markers is not None or self.durable_markers is not None
                    or self.durable_history is not None):
                raise ValueError("fresh genesis cannot include reconstructed state")
            self.markers = {"update": self.operation, "systemd": self.operation}
            self.durable_markers = self.markers.copy()
            self.durable_history = ["old_ready"]

    def _validate_history(self):
        # The complete synthetic history starts at before or old_ready. It must
        # contain every subsequent transition and end at the durable phase.
        order = ("before", "old_ready", "old_releasing", "rolled_back")
        history = self.durable_history
        if not history or history[0] not in ("before", "old_ready"):
            raise Stop("missing or incomplete retained history")
        try:
            indices = [order.index(phase) for phase in history]
        except ValueError:
            raise Stop("invalid retained history")
        if (any(b != a + 1 for a, b in zip(indices, indices[1:]))
                or history[-1] != self.durable_phase):
            raise Stop("incomplete or regressed durable history")

    def crash(self):
        self.phase = self.durable_phase
        self.markers = (None if self.durable_markers is None
                        else self.durable_markers.copy())
        self.locked = False
        self.uncertain = False
        self.events.append("crash")

    def release(self, fault=None):
        """Run under an exclusive synthetic journal lock."""
        if self.locked:
            raise Stop("journal lock busy")
        self.locked = True
        try:
            self._release(fault)
        finally:
            self.locked = False

    def _release(self, fault):
        self._validate_history()
        gates = {"update", "systemd"}
        if (not isinstance(self.markers, dict)
                or not isinstance(self.durable_markers, dict)
                or set(self.markers) != gates or set(self.durable_markers) != gates):
            raise Stop("incomplete marker snapshot")
        if (self.uncertain or self.phase != self.durable_phase
                or self.markers != self.durable_markers):
            raise Stop("ambiguous state; reload before retry")
        if self.phase == "rolled_back":
            if any(self.markers[gate] is not None for gate in gates):
                raise Stop("rolled_back with marker present")
            return
        if self.phase not in ("old_ready", "old_releasing"):
            raise Stop("invalid phase")
        if self.synthetic_witnesses != {"old_ready", "operation_bound"}:
            raise Stop("missing synthetic witnesses")
        for gate in ("update", "systemd"):
            marker = self.markers[gate]
            if marker is not None and marker != self.operation:
                raise Stop("foreign marker: " + gate)
            if marker is None and self.durable_phase != "old_releasing":
                raise Stop("absent marker before durable release: " + gate)
        if self.markers["update"] is not None and self.markers["systemd"] is None:
            raise Stop("markers removed in reverse order")
        if self.phase == "old_ready":
            self._journal("old_releasing", fault)
        for gate in ("update", "systemd"):
            if self.markers[gate] is None:
                continue
            self.events.append("unlink:" + gate)
            if fault == "unlink_" + gate:
                self.uncertain = True
                raise Stop("unlink outcome ambiguous")
            self.markers[gate] = None
            self.events.append("fsync:" + gate)
            if fault == "fsync_" + gate:
                self.uncertain = True
                raise Stop("directory fsync outcome ambiguous")
            self.durable_markers[gate] = None
        self._journal("rolled_back", fault)

    def _journal(self, phase, fault):
        self.events.append("journal:" + phase)
        if fault == "journal_write_" + phase:
            self.uncertain = True
            raise Stop("journal write outcome ambiguous")
        self.phase = phase
        if fault == "journal_fsync_" + phase:
            self.uncertain = True
            raise Stop("journal fsync outcome ambiguous")
        self.durable_phase = phase
        self.durable_history.append(phase)

    def restore(self):
        self._validate_history()
        forbidden = {"old_ready", "old_releasing", "rolled_back"}
        if (self.phase in forbidden or self.durable_phase in forbidden
                or any(phase in forbidden for phase in self.durable_history)):
            raise Stop("restore forbidden after old_ready")
        self.restore_calls += 1
