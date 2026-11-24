"""Offline SeaweedFS volume snapshot preflight; publication is not supported.

The caller must stop and fence all writers before preflight and keep the volume
unchanged until an archive is durably copied. Docker and the host must be
trusted. The destination must be a private local directory inaccessible to
other users; no same-UID attacker may act. The caller must provide sufficient
space for the archive and a separate restore volume. These requirements are
not established by Docker inspection.

This module deliberately cannot produce a recovery artifact. Metadata-complete
archiving and comparison against an actual restore remain unimplemented. Do not
use it to enable the username migration operational gate.
"""

from __future__ import annotations

import json
import re
import subprocess
from typing import Callable


class SnapshotError(RuntimeError):
    """A snapshot requirement was not met."""


class UnsupportedSnapshot(SnapshotError):
    """A safe snapshot cannot yet be produced by this adapter."""


Runner = Callable[..., subprocess.CompletedProcess[str]]
_VOLUME = re.compile(r"[a-zA-Z0-9][a-zA-Z0-9_.-]*\Z")
_IMAGE = re.compile(r"[^\s@]+@sha256:[0-9a-f]{64}\Z")


def _docker_json(runner: Runner, args: list[str]) -> object:
    try:
        result = runner(["docker", *args], check=True, capture_output=True, text=True)
        return json.loads(result.stdout)
    except (OSError, subprocess.SubprocessError, ValueError, TypeError) as exc:
        raise SnapshotError("Docker inspection failed") from exc


def preflight(volume: str, helper_image: str, *, runner: Runner = subprocess.run) -> None:
    """Check the Docker volume and all containers; this does not establish a fence.

    The helper digest must identify an independently trusted image. A digest
    alone does not establish trust. Docker access must target the intended host.
    The check is only a point-in-time observation and cannot prevent new users.
    It cannot detect direct host access or bind mounts of the volume path.
    """
    if not isinstance(volume, str) or not _VOLUME.fullmatch(volume):
        raise SnapshotError("invalid Docker volume name")
    if not isinstance(helper_image, str) or not _IMAGE.fullmatch(helper_image):
        raise SnapshotError("helper image must use a sha256 digest")
    volumes = _docker_json(runner, ["volume", "inspect", volume])
    if (not isinstance(volumes, list) or len(volumes) != 1
            or not isinstance(volumes[0], dict)
            or volumes[0].get("Name") != volume
            or volumes[0].get("Driver") != "local"):
        raise SnapshotError("volume is missing or is not the expected local volume")
    try:
        result = runner(["docker", "ps", "--all", "--quiet", "--no-trunc"],
                        check=True, capture_output=True, text=True)
        ids = result.stdout.splitlines()
    except (OSError, subprocess.SubprocessError, AttributeError) as exc:
        raise SnapshotError("container enumeration failed") from exc
    if any(not re.fullmatch(r"[0-9a-f]{64}", item) for item in ids):
        raise SnapshotError("invalid container identifier")
    # Inspect separately to avoid command line length limits on large hosts.
    for container_id in ids:
        containers = _docker_json(runner, ["inspect", "--type", "container", container_id])
        if (not isinstance(containers, list) or len(containers) != 1
                or not isinstance(containers[0], dict)):
            raise SnapshotError("invalid container inspection")
        item = containers[0]
        state, mounts = item.get("State"), item.get("Mounts")
        if (item.get("Id") != container_id or not isinstance(state, dict)
                or not isinstance(state.get("Status"), str)
                or not isinstance(mounts, list)):
            raise SnapshotError("incomplete container inspection")
        status = state["Status"]
        if status not in {"created", "running", "paused", "restarting", "removing", "exited", "dead"}:
            raise SnapshotError("unknown container state")
        for mount in mounts:
            if not isinstance(mount, dict) or not isinstance(mount.get("Type"), str):
                raise SnapshotError("incomplete mount inspection")
            if mount["Type"] == "volume":
                if not isinstance(mount.get("Name"), str):
                    raise SnapshotError("incomplete volume mount inspection")
                if mount["Name"] == volume and status not in {"created", "exited", "dead"}:
                    raise SnapshotError("volume has an active container user")


def snapshot(volume: str, helper_image: str, *, runner: Runner = subprocess.run) -> None:
    """Fail closed until metadata-preserving capture and restore verification exist."""
    preflight(volume, helper_image, runner=runner)
    raise UnsupportedSnapshot(
        "snapshot disabled: durable archive capture and metadata-complete "
        "disposable-volume restore verification are not implemented"
    )
