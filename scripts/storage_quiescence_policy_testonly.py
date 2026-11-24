"""Offline synthetic policy, not a collector, physical fence, or authorization.

Counts have the exact shape returned by username_migration_quiescence_testonly.
The caller supplies a fence token captured with those counts, and independently
supplies authenticated, complete DB and object inventory pages. Attestations and
matching tokens cannot prove authentication, completeness, or a physical fence.
The caller must hold the same fence throughout all collection and checks.
Matching inventories and counts do not prove object integrity, listing
completeness, durability, or permission to perform any operation.
"""
import storage_inventory_reconcile_testonly as inventory


class PolicyError(ValueError):
    """A non-identifying synthetic policy failure."""


_COUNT_FIELDS = frozenset({
    'storage_reserved', 'storage_writing', 'storage_ready', 'storage_live',
    'uploads', 'uploads_retiring', 'completion_claims',
    'transfers_uploading', 'transfers_complete', 'transfers_expired',
})
_ZERO_FIELDS = frozenset({
    'storage_reserved', 'storage_writing', 'storage_ready', 'uploads',
    'uploads_retiring', 'completion_claims', 'transfers_uploading',
})


def check(counts, counts_fence, database_pages, object_pages, fence_before, fence_after):
    """Apply the synthetic policy to separately collected, attested inputs.

    fence_before and fence_after bracket collection. The caller must keep the
    fence held through this check. Each page must attest authentication and
    carry the same token; pagination must end. The helper does not independently
    verify these caller-provided values.
    Return None on acceptance, or raise PolicyError without identifying data.
    """
    if (type(counts) is not dict or set(counts) != _COUNT_FIELDS
            or any(type(value) is not int or value < 0 for value in counts.values())
            or any(counts[name] != 0 for name in _ZERO_FIELDS)):
        raise PolicyError('storage quiescence policy rejected')
    try:
        # The inventory checker validates token type, bounds, pages, and matches.
        inventory.reconcile(database_pages, object_pages, fence_before, fence_after)
        if type(counts_fence) is not str or counts_fence != fence_before:
            raise PolicyError('storage quiescence policy rejected')
        if counts['storage_live'] != sum(len(page['entries']) for page in database_pages):
            raise PolicyError('storage quiescence policy rejected')
    except inventory.ReconcileError as exc:
        raise PolicyError('storage quiescence policy rejected') from exc
