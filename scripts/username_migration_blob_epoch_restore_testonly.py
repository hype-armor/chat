"""Synthetic epoch-to-disposable-restore experiment. Never use for live recovery.

The caller holds the journal lock and a continuously exclusive fake fence. The
independent evidence, mount, and resolution callbacks are synthetic test fixtures.
They cannot authorize production recovery. Evidence verification must bind the
exact snapshot hash, inventory, and original intent to the evidence digest. Mount
verification must check the current mount ID, device, inode, and volume mapping.
Every prior epoch or ambiguous publication requires external resolution.
The original restore intent is never changed. Each attempt uses a new intent.
"""
import hashlib
import json
import os
import stat

import username_migration_recovery_epoch_durable_testonly as epochs
import username_migration_mount_check_testonly as mounts
from username_migration_recovery_anchor_testonly import _state
from username_migration_blob_fenced_restore_testonly import restore_testonly

operational = False


def restore_epoch_testonly(*, journal, evidence_digest, mount_id, number,
                           authority, fence, original_intent_path,
                           verify_evidence=None, verify_mount=None,
                           resolve_prior=None, **restore_args):
    """Publish a fresh durable epoch before running one disposable restore."""
    if not callable(verify_evidence) or not callable(verify_mount):
        raise epochs.EpochError('independent synthetic verification callbacks required')
    names = os.listdir(journal.dirfd)
    # Restore attempts use a fresh intent even when resolution permits a replay.
    if type(number) is not int or number != sum(n.startswith(epochs.PREFIX) for n in names) + 1:
        raise epochs.EpochError('a fresh epoch is required')
    if any(key in restore_args for key in ('intent_path', 'verify_rollback_journal', 'on_intent_published')):
        raise epochs.EpochError('wrapper owns restore intent and journal gate')
    inventory_bytes = json.dumps(restore_args['expected_inventory'], sort_keys=True,
                                 separators=(',', ':'), allow_nan=False).encode()
    inventory_hash = hashlib.sha256(inventory_bytes).hexdigest()

    def check_inventory():
        try:
            current = json.dumps(restore_args['expected_inventory'], sort_keys=True,
                                 separators=(',', ':'), allow_nan=False).encode()
        except (TypeError, ValueError, RecursionError):
            raise epochs.EpochError('inventory changed') from None
        if current != inventory_bytes:
            raise epochs.EpochError('inventory changed')

    state, check_journal = epochs.pin_journal(journal)
    lease = fence()
    check_inventory()
    if not isinstance(lease, str) or not lease.strip():
        raise epochs.EpochError('invalid fence')
    check_journal()
    identity = authority(state['operation_id'], evidence_digest)
    from username_migration_recovery_epoch_model_testonly import Identity
    if type(identity) is not Identity:
        raise epochs.EpochError('ambiguous authority')
    identity.validate()
    original = os.path.abspath(os.fspath(original_intent_path))
    def read_evidence(path, required=False, private=False):
        try:
            fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC)
        except FileNotFoundError:
            if required:
                raise epochs.EpochError('original intent evidence is absent') from None
            return None, None
        try:
            before = os.fstat(fd)
            if (not stat.S_ISREG(before.st_mode) or before.st_size > 1024 * 1024
                    or (private and (before.st_uid != os.geteuid() or before.st_mode & 0o077))):
                raise epochs.EpochError('invalid intent evidence')
            data = bytearray()
            while len(data) <= 1024 * 1024:
                part = os.read(fd, min(65536, 1024 * 1024 + 1 - len(data)))
                if not part:
                    break
                data.extend(part)
            after = os.fstat(fd)
            key = lambda st: (st.st_dev, st.st_ino, st.st_size, st.st_mtime_ns, st.st_ctime_ns)
            if key(before) != key(after) or len(data) != before.st_size or (required and not data):
                raise epochs.EpochError('unstable intent evidence')
            return key(before), bytes(data)
        finally:
            os.close(fd)

    original_identity, original_contents = read_evidence(original, required=True)
    intent = original + '.epoch-%06d' % number
    prior_paths = [original + '.epoch-%06d' % i for i in range(1, number)]
    prior_snapshots = tuple((path, read_evidence(path)) for path in prior_paths)
    prior_intents = tuple((path, snapshot[1]) for path, snapshot in prior_snapshots)
    resolution = []
    epoch_snapshot = []
    intent_snapshot = []

    def check_epochs():
        if not epoch_snapshot:
            return
        names = sorted(name for name in os.listdir(journal.dirfd)
                       if name.startswith((epochs.PREFIX, '.epoch-testonly-')))
        if tuple((name, epochs._read(journal, name, True)) for name in names) != epoch_snapshot[0]:
            raise epochs.EpochError('epoch evidence changed during restore')

    def resolve(context):
        if resolve_prior(context) is not True:
            return False
        resolution[:] = [context]
        return True

    def check_intents():
        current_intent = read_evidence(intent, required=bool(intent_snapshot), private=True)
        if intent_snapshot:
            key, contents = current_intent
            if (key, hashlib.sha256(contents).digest()) != intent_snapshot[0]:
                raise epochs.EpochError('epoch intent changed')
        elif current_intent != (None, None):
            raise epochs.EpochError('epoch intent published unexpectedly')
        if read_evidence(original, required=True) != (original_identity, original_contents):
            raise epochs.EpochError('original intent changed')
        if tuple((path, read_evidence(path)) for path in prior_paths) != prior_snapshots:
            raise epochs.EpochError('prior intent changed')
        entries = os.listdir(os.path.dirname(original))
        if any(name.startswith('.restore-intent-') for name in entries):
            raise epochs.EpochError('unresolved temporary restore intent')
        prefix = os.path.basename(original) + '.epoch-'
        allowed = {os.path.basename(path) for path in prior_paths + [intent]}
        if any(name.startswith(prefix) and name not in allowed for name in entries):
            raise epochs.EpochError('unexpected restore intent evidence')
    if os.path.lexists(intent):
        raise epochs.EpochError('epoch intent already exists')

    destination = os.path.join(os.fspath(restore_args['synthetic_volume_root']), restore_args['volume_name'])

    def check_destination(volume_name, destination_identity):
        fd = os.open(destination, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC)
        try:
            current = os.fstat(fd)
            actual_identity = (current.st_dev, current.st_ino)
            actual_mount = mounts.mount_id(fd)
        finally:
            os.close(fd)
        if actual_identity != destination_identity or str(actual_mount) != mount_id:
            raise epochs.EpochError('destination identity or mount ID changed')
        if identity.volume != volume_name or identity.root_inode != actual_identity[1]:
            raise epochs.EpochError('synthetic volume identity mismatch')

    def gate(phase, volume_name, destination_identity):
        check_inventory()
        if (fence() != lease or _state(journal, ('rollback',)) != state
                or authority(state['operation_id'], evidence_digest) != identity):
            raise epochs.EpochError('fence, journal, or identity changed')
        check_intents()
        check_epochs()
        if resolution and resolve_prior(resolution[0]) is not True:
            raise epochs.EpochError('external resolution is required at every restore gate')
        check_intents()
        check_destination(volume_name, destination_identity)
        if verify_evidence(state.copy(), evidence_digest, restore_args['snapshot_sha256'],
                           restore_args['expected_inventory'], original) is not True:
            raise epochs.EpochError('recovery evidence is not independently verified')
        if verify_mount(phase, mount_id, volume_name, destination_identity, identity) is not True:
            raise epochs.EpochError('mount mapping is not independently verified')
        check_intents()
        check_epochs()
        check_inventory()
        if (fence() != lease or _state(journal, ('rollback',)) != state
                or authority(state['operation_id'], evidence_digest) != identity):
            raise epochs.EpochError('fence, journal, or identity changed')
        check_inventory()
        check_intents()
        check_epochs()
        check_journal()
        # No external callbacks may run between these final checks and return.
        check_destination(volume_name, destination_identity)
        return True
    destination_stat = os.stat(destination, follow_symlinks=False)
    gate('publish', restore_args['volume_name'], (destination_stat.st_dev, destination_stat.st_ino))

    def effect(context):
        if not resolution or context != resolution[0]:
            raise epochs.EpochError('resolution context changed')
        names = sorted(name for name in os.listdir(journal.dirfd)
                       if name.startswith((epochs.PREFIX, '.epoch-testonly-')))
        check_inventory()
        epoch_snapshot.append(tuple((name, epochs._read(journal, name, True)) for name in names))
        gate('publish', restore_args['volume_name'], (destination_stat.st_dev, destination_stat.st_ino))
        if os.path.lexists(intent):
            raise epochs.EpochError('epoch intent already exists')
        def intent_published():
            if intent_snapshot:
                raise epochs.EpochError('epoch intent published more than once')
            key, contents = read_evidence(intent, required=True, private=True)
            expected = {'version': 2, 'destination': os.path.abspath(destination),
                        'identity': list((destination_stat.st_dev, destination_stat.st_ino)),
                        'root_mount_id': int(mount_id),
                        'snapshot_sha256': restore_args['snapshot_sha256'],
                        'inventory_sha256': inventory_hash}
            if contents != json.dumps(expected, sort_keys=True).encode():
                raise epochs.EpochError('epoch intent content mismatch')
            intent_snapshot.append((key, hashlib.sha256(contents).digest()))
            gate('intent-published', restore_args['volume_name'],
                 (destination_stat.st_dev, destination_stat.st_ino))

        restore_testonly(intent_path=intent, verify_rollback_journal=gate,
                         on_intent_published=intent_published, **restore_args)

    def checked_fence():
        check_inventory()
        current = fence()
        check_inventory()
        return current if current == lease else None

    def checked_authority(operation, digest):
        check_inventory()
        result = authority(operation, digest)
        check_inventory()
        return result

    epochs.attempt(journal, evidence_digest=evidence_digest, mount_id=mount_id,
                   number=number, authority=checked_authority,
                   fence=checked_fence, effect=effect, resolve_prior=resolve if callable(resolve_prior) else None,
                   original_intent_identity=original_identity, original_intent_contents=original_contents,
                   prior_intents=prior_intents,
                   destination_identity=(destination_stat.st_dev, destination_stat.st_ino, restore_args['volume_name']))
