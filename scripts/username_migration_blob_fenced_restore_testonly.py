"""Synthetic restore experiment only. This module has no operational entrypoint.

All paths and Docker inspection records must be private synthetic fixtures. The
caller must hold an uninterrupted exclusion fence and independently verify the
rollback journal on every callback. The fake inspector must return a complete,
consistent snapshot of *all* containers. Neither callback is a security boundary.
This experiment does not protect against concurrent host or Docker administrators,
mount namespaces, concurrent mount changes, filesystem races, or untrusted tar
archives. Trusted administrators must continuously exclude mount and tree changes.
The callbacks cannot provide a physical fence. Live restore remains disabled.
"""

import json
import os
import re
import stat

from username_migration_blob_disposable_restart import RestoreError as _RestoreError, restore as _restore

RestoreError = _RestoreError
__all__ = ['restore_testonly']

operational = False


def _directory(path):
    path = os.path.abspath(os.fspath(path))
    if os.path.realpath(path) != path:
        raise RestoreError('symlink path is not allowed')
    st = os.lstat(path)
    if not stat.S_ISDIR(st.st_mode):
        raise RestoreError('expected a real directory')
    return path, (st.st_dev, st.st_ino)


def _overlap(a, b):
    return os.path.commonpath((a, b)) in (a, b)


def restore_testonly(*, synthetic_volume_root, volume_name, source, workspace,
                     snapshot, snapshot_sha256, expected_inventory, intent_path,
                     inspect_fake_docker, verify_rollback_journal, max_archive_size,
                     max_entries, max_depth, max_path_bytes, interrupt=None,
                     on_intent_published=None):
    """Restore a fake local volume, under a caller-held fence, for tests only.

    The inspector returns exactly {"volume": {...}, "containers": [...]}; volume
    has Name, Driver, Mountpoint, Options, and containers have Id, State,
    RestartPolicy, Mounts. State is a Docker status string. Mounts use Type,
    Name, Source. Every inspection must cover stopped containers as well.
    The journal callback receives (phase, volume_name, identity) and must
    independently verify the rollback boundary and return exactly True.
    """
    if not callable(inspect_fake_docker) or not callable(verify_rollback_journal):
        raise RestoreError('inspection and journal callbacks are required')
    if not isinstance(volume_name, str) or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.-]*', volume_name):
        raise RestoreError('invalid volume name')
    root, root_id = _directory(synthetic_volume_root)
    source, source_id = _directory(source)
    workspace, workspace_id = _directory(workspace)
    if source_id == workspace_id or _overlap(source, workspace):
        raise RestoreError('source and workspace overlap')
    if _overlap(root, source) or _overlap(root, workspace):
        raise RestoreError('synthetic root must be separate')
    destination, identity = _directory(os.path.join(root, volume_name))
    if identity in (root_id, source_id, workspace_id):
        raise RestoreError('volume identity overlaps')
    snapshot = os.path.abspath(os.fspath(snapshot))
    intent_path = os.path.abspath(os.fspath(intent_path))
    if not _overlap(workspace, snapshot) or os.path.commonpath((workspace, snapshot)) != workspace:
        raise RestoreError('snapshot must be in workspace')
    if os.path.commonpath((workspace, intent_path)) != workspace:
        raise RestoreError('intent must be in workspace')
    if os.path.realpath(snapshot) != snapshot or os.path.realpath(intent_path) != intent_path:
        raise RestoreError('workspace paths must not use symlinks')

    def inventory_bytes():
        try:
            return json.dumps(expected_inventory, sort_keys=True, separators=(',', ':'),
                              allow_nan=False).encode()
        except (TypeError, ValueError, RecursionError):
            raise RestoreError('invalid or changed inventory') from None

    pinned_inventory = inventory_bytes()

    def check_inventory():
        if inventory_bytes() != pinned_inventory:
            raise RestoreError('inventory changed')

    def verify_gate(phase):
        check_inventory()
        if verify_rollback_journal(phase, volume_name, identity) is not True:
            raise RestoreError('rollback journal verification failed')
        if _directory(root)[1] != root_id or _directory(destination)[1] != identity:
            raise RestoreError('volume identity changed')
        if _directory(source)[1] != source_id or _directory(workspace)[1] != workspace_id:
            raise RestoreError('fixture identity changed')
        check_inventory()

    def fence(phase):
        verify_gate(phase)
        data = inspect_fake_docker()
        if not isinstance(data, dict) or set(data) != {'volume', 'containers'}:
            raise RestoreError('invalid inspection')
        volume = data['volume']
        if not isinstance(volume, dict) or set(volume) != {'Name', 'Driver', 'Mountpoint', 'Options'}:
            raise RestoreError('invalid volume inspection')
        if volume != {'Name': volume_name, 'Driver': 'local', 'Mountpoint': destination, 'Options': {}}:
            raise RestoreError('not the pinned synthetic local volume')
        containers = data['containers']
        if not isinstance(containers, list):
            raise RestoreError('invalid container inspection')
        seen = set()
        for container in containers:
            if not isinstance(container, dict) or set(container) != {'Id', 'State', 'RestartPolicy', 'Mounts'}:
                raise RestoreError('invalid container inspection')
            cid = container['Id']
            if not isinstance(cid, str) or not re.fullmatch(r'[0-9a-f]{64}', cid) or cid in seen:
                raise RestoreError('invalid container ID')
            seen.add(cid)
            state, policy, mounts = container['State'], container['RestartPolicy'], container['Mounts']
            if state not in ('created', 'running', 'paused', 'restarting', 'removing', 'exited', 'dead'):
                raise RestoreError('invalid container state')
            if not isinstance(policy, dict) or set(policy) != {'Name', 'MaximumRetryCount'}:
                raise RestoreError('invalid restart policy')
            name, count = policy['Name'], policy['MaximumRetryCount']
            if name not in ('no', 'always', 'unless-stopped', 'on-failure') or type(count) is not int or count < 0 or (name != 'on-failure' and count != 0):
                raise RestoreError('invalid restart policy')
            if not isinstance(mounts, list):
                raise RestoreError('invalid mounts')
            uses_volume = False
            for mount in mounts:
                if not isinstance(mount, dict) or set(mount) != {'Type', 'Name', 'Source'}:
                    raise RestoreError('invalid mount')
                kind, mount_name, mount_source = mount['Type'], mount['Name'], mount['Source']
                if kind not in ('volume', 'bind', 'tmpfs') or not isinstance(mount_name, str) or not isinstance(mount_source, str):
                    raise RestoreError('invalid mount')
                if kind == 'volume' and mount_name == volume_name:
                    if mount_source != destination:
                        raise RestoreError('volume mount mismatch')
                    uses_volume = True
                if kind in ('bind', 'volume') and not (kind == 'volume' and mount_name == volume_name):
                    if not os.path.isabs(mount_source):
                        raise RestoreError('invalid mount source')
                    if _overlap(os.path.realpath(mount_source), destination):
                        raise RestoreError('mount path aliases volume')
            if uses_volume and (state not in ('created', 'exited', 'dead') or name != 'no'):
                raise RestoreError('volume consumer is active or may restart')

        # The synthetic inspector can change evidence or replace fixture paths.
        # Recheck after it returns; continuous external exclusion is still required.
        verify_gate(phase)
        return True

    _restore(snapshot, snapshot_sha256, expected_inventory, destination, intent_path,
             fence, interrupt, workspace=workspace, max_archive_size=max_archive_size,
             max_entries=max_entries, max_depth=max_depth, max_path_bytes=max_path_bytes,
             on_intent_published=on_intent_published)
