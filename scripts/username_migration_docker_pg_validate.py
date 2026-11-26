"""Disabled disposable restore validation command plan.

The current capture metadata does not contain database ACLs or database/role
settings. Therefore no restore can pass the requested comparison. This module
never executes its command plan, creates Docker objects, or writes evidence.
The Docker administrator and external writer gate would also be trust boundaries
for any future executor. This module does not authorize migration or recovery.
"""
import re


class ValidationUnsupported(RuntimeError):
    pass


_NAME = re.compile(r'[A-Za-z_][A-Za-z_0-9]{0,62}\Z')
_OPERATION = re.compile(r'[a-zA-Z0-9_-]{16,128}\Z')
_VOLUME = re.compile(r'[A-Za-z0-9][A-Za-z0-9_.-]{0,127}\Z')
_IMAGE = re.compile(r'sha256:[0-9a-f]{64}\Z')


def disabled_command_plan(*, operation, source_volume, validation_volume,
                          image, role, database):
    """Return a non-executable outline, not a validated execution plan.

    The outline omits inspection, readiness, archive header verification,
    stdin handling, and property comparison. It must not be executed.
    """
    if (not isinstance(operation, str) or not _OPERATION.fullmatch(operation)
            or not isinstance(source_volume, str) or not _VOLUME.fullmatch(source_volume)
            or not isinstance(validation_volume, str) or not _VOLUME.fullmatch(validation_volume)
            or source_volume == validation_volume
            or not isinstance(image, str) or not _IMAGE.fullmatch(image)
            or not isinstance(role, str) or not _NAME.fullmatch(role)
            or not isinstance(database, str) or not _NAME.fullmatch(database)
            or database in ('postgres', 'template0', 'template1')):
        raise ValueError('invalid validation configuration')
    label = 'username-migration.operation=' + operation
    return (
        ('docker', 'volume', 'create', '--driver', 'local', '--label', label, validation_volume),
        ('docker', 'run', '--detach', '--network', 'none', '--restart', 'no',
         '--label', label, '--mount', 'type=volume,src=' + validation_volume + ',dst=/var/lib/postgresql/data',
         '--env', 'POSTGRES_USER=' + role, '--env', 'POSTGRES_DB=postgres',
         '--env', 'POSTGRES_HOST_AUTH_METHOD=trust', image),
        ('docker', 'exec', '-i', '<verified-container-id>', 'pg_restore',
         '--exit-on-error', '--create', '--no-password', '-U', role, '-d', 'postgres'),
    )


def validate(*args, **kwargs):
    """Always fail closed until independent metadata and controls exist."""
    raise ValidationUnsupported(
        'disabled: capture lacks database ACL and database/role settings; '
        'disposable restore and comparison are not implemented')
