"""Test-only state machine, not a filesystem adapter or production authority.

The journal and callbacks are simulated. No claim is made about actual fsync,
Docker metadata, authority trust, fence enforcement, or safe live recovery.
The caller must provide a trusted, unambiguous authority and a fence that can
prove continuous exclusion for the entire attempt. A filesystem UUID alone is
not an identity. Ambiguous journal outcomes require external resolution; this
model deliberately provides no resolution or deletion operation.
"""
from dataclasses import dataclass

operational = False


class Rejected(Exception):
    pass


@dataclass(frozen=True)
class Identity:
    authority: str
    filesystem: str
    volume: str
    volume_metadata: str
    root_inode: int

    def validate(self):
        fields = (self.authority, self.filesystem, self.volume, self.volume_metadata)
        if any(not isinstance(x, str) or not x.strip() for x in fields):
            raise Rejected('missing or ambiguous identity')
        if type(self.root_inode) is not int or self.root_inode <= 0:
            raise Rejected('missing or ambiguous root inode')


class Journal:
    """Abstract append+fsync journal. The fault hook can model unknown outcomes."""
    def __init__(self, fault=lambda phase: None):
        self.records = []
        self.ambiguous = False
        self.fault = fault

    def publish(self, record):
        if self.ambiguous:
            raise Rejected('ambiguous journal')
        # Once publication starts, any failure may have left a durable record.
        try:
            self.fault('append')
            self.records.append(record)
            self.fault('fsync')
        except Exception as exc:
            self.ambiguous = True
            raise Rejected('ambiguous publication or fsync') from exc


def attempt(journal, operation, evidence, mount_id, authority, fence, effect,
    interrupt=lambda phase: None):
    """Model one fenced attempt. Callback fence() returns one continuous lease ID.

    The authority returns exactly one Identity, bound to the operation and
    evidence supplied to it. Its external trust and lease continuity are
    assumptions, not properties this model can establish.
    """
    if journal.ambiguous:
        raise Rejected('ambiguous journal')
    if any(not isinstance(x, str) or not x.strip()
           for x in (operation, evidence, mount_id)):
        raise Rejected('missing operation, evidence, or mount')
    lease = fence()
    if not isinstance(lease, str) or not lease.strip():
        raise Rejected('invalid fence')

    def check():
        if fence() != lease:
            raise Rejected('fence lost or replaced')
        identity = authority(operation, evidence)
        if type(identity) is not Identity:
            raise Rejected('ambiguous authority')
        identity.validate()
        return identity

    identity = check()
    if journal.records:
        first = journal.records[0]
        if first['kind'] != 'intent' or first['operation'] != operation or first['evidence'] != evidence or first['identity'] != identity:
            raise Rejected('intent mismatch')
        if any(r['operation'] != operation or r['evidence'] != evidence or r['identity'] != identity for r in journal.records):
            raise Rejected('journal mismatch')
    else:
        journal.publish(dict(kind='intent', operation=operation, evidence=evidence,
                             identity=identity, mount_id=mount_id))
        interrupt('intent')
    if check() != identity:
        raise Rejected('identity changed')
    # Each attempt publishes a fresh epoch, including a retry after a crash.
    journal.publish(dict(kind='epoch', operation=operation, evidence=evidence,
                         identity=identity, mount_id=mount_id, lease=lease,
                         number=len(journal.records)))
    interrupt('epoch')
    if check() != identity:
        raise Rejected('identity changed')
    effect()
