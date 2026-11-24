"""Generate, but do not install, the fixed username migration recovery unit.

The executable is a separately reviewed, root-owned recovery-only entry point.
It must recover the durable journal before it exits successfully. It must not
start a new migration. This generator does not provide that entry point.

Enablement must create both install links, including RequiredBy=pi-chat.service;
ordering alone does not prevent pi-chat from starting after recovery failure.
The persistent migration gate remains necessary. Review the effective units and
all other start paths before deployment. Docker service activation is not proof
of application-specific readiness; the entry point must check the daemon.

KillMode=control-group terminates local descendants, not operations that the
Docker daemon already accepted. Daemon operations must be idempotent and must
verify resource identity on every retry. Never use this unit as that fence.
"""
import os
import re
import stat

EXECUTABLE = "/usr/local/libexec/pi-chat-username-migration-recover"
DEPENDENCIES = ("docker.service",)


class UnitError(ValueError):
    pass


def _check_trusted_executable(path):
    """Reject symlinks and non-root-owned or writable path components.

    This is a point-in-time check. Deployment must keep the path immutable and
    independently verify the executable contents and its runtime dependencies.
    """
    if (not isinstance(path, str) or not re.fullmatch(r"/[A-Za-z0-9_./-]+", path)
            or os.path.normpath(path) != path or path == "/"):
        raise UnitError("unsafe executable path")
    components = path.split("/")[1:]
    current = "/"
    for index, component in enumerate([""] + components):
        if component:
            current = os.path.join(current, component)
        try:
            info = os.lstat(current)
        except OSError as error:
            raise UnitError("executable path is unavailable") from error
        if info.st_uid != 0 or info.st_mode & 0o022:
            raise UnitError("untrusted executable path")
        if index < len(components):
            if not stat.S_ISDIR(info.st_mode):
                raise UnitError("untrusted executable directory")
        elif not stat.S_ISREG(info.st_mode) or not info.st_mode & 0o111:
            raise UnitError("executable is not a regular executable file")


def generate_unit(*, dependencies=DEPENDENCIES):
    """Return a fixed unit. Unknown or missing dependencies fail closed."""
    if dependencies != DEPENDENCIES:
        raise UnitError("unsupported recovery dependencies")
    _check_trusted_executable(EXECUTABLE)
    return """[Unit]
Description=Recover pending pi-chat username migration
Requires=docker.service
After=docker.service
Before=pi-chat.service
StartLimitIntervalSec=0

[Service]
Type=oneshot
ExecStart={executable}
RemainAfterExit=yes
Restart=on-failure
RestartSec=5s
KillMode=control-group

[Install]
WantedBy=multi-user.target
RequiredBy=pi-chat.service
""".format(executable=EXECUTABLE)
