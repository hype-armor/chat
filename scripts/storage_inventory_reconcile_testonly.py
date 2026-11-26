"""Synthetic inventory comparison only; not an inventory collector or migration gate.

PR #158, commit 28c8cc3217abc964707cf2acfee5e55426ece18b:
0014_storage_quotas.sql defines reserved, writing, ready and live. Direct and
multipart writes can fail after object I/O and before a state transition (see
storage.rs, blobs.rs and backup.rs). A ready row can precede the live
commit, including after a direct PUT. This checker accepts only live rows;
it rejects reserved, writing and ready rows even when their keys occur in S3.

The caller must authenticate both sources, obtain complete inventories, and
hold a fence across both captures and this check. Boolean attestations and
matching opaque tokens do not prove any of these requirements. Page cursors
must form one chain ending in None; each page has the same fence token.
Matching sizes do not prove list completeness, object integrity, or SeaweedFS
durability. A successful comparison does not authorize migration. No I/O is
performed and no keys or data are included in errors or results.
"""

MAX_ENTRIES = 100_000  # per inventory, including across pages
MAX_PAGES = 10_000  # per inventory, including empty pages
MAX_KEY_BYTES = 1024
MAX_TOKEN_BYTES = 1024
MAX_SIZE_BYTES = (1 << 63) - 1  # PostgreSQL bigint


class ReconcileError(ValueError):
    """A deliberately non-identifying failure."""


def _fail():
    raise ReconcileError("inventory reconciliation rejected")


def _text(value, maximum):
    if type(value) is not str or not value or len(value) > maximum:
        _fail()
    try:
        encoded = value.encode("utf-8")
    except UnicodeError:
        _fail()
    if not encoded or len(encoded) > maximum or "\x00" in value:
        _fail()
    return value


def _pages(pages, fence, database):
    if type(pages) is not list or not 1 <= len(pages) <= MAX_PAGES:
        _fail()
    keys = {}
    cursors = set()
    expected = None
    count = 0
    for index, page in enumerate(pages):
        if type(page) is not dict or set(page) != {
            "authenticated", "fence", "cursor", "next_cursor", "entries"
        }:
            _fail()
        if page["authenticated"] is not True or _text(page["fence"], MAX_TOKEN_BYTES) != fence:
            _fail()
        cursor, next_cursor = page["cursor"], page["next_cursor"]
        if cursor is not None:
            _text(cursor, MAX_TOKEN_BYTES)
        if next_cursor is not None:
            _text(next_cursor, MAX_TOKEN_BYTES)
        if cursor != expected or (cursor is not None and cursor in cursors):
            _fail()
        if cursor is not None:
            cursors.add(cursor)
        if (next_cursor is None) != (index == len(pages) - 1):
            _fail()
        expected = next_cursor
        entries = page["entries"]
        if type(entries) is not list:
            _fail()
        count += len(entries)
        if count > MAX_ENTRIES:
            _fail()
        for entry in entries:
            if database:
                if type(entry) is not dict or set(entry) != {"object_key", "state", "size_bytes"}:
                    _fail()
                if type(entry["state"]) is not str or entry["state"] != "live":
                    _fail()
                key = entry["object_key"]
            else:
                if type(entry) is not dict or set(entry) != {"key", "size"}:
                    _fail()
                key = entry["key"]
            size = entry["size_bytes"] if database else entry["size"]
            if type(size) is not int or not 0 <= size <= MAX_SIZE_BYTES:
                _fail()
            _text(key, MAX_KEY_BYTES)
            if key in keys:
                _fail()
            keys[key] = size
    return keys


def reconcile(database_pages, s3_pages, fence_before, fence_after):
    """Return None only when the attested inventories match exactly.

    Pages are dictionaries with authenticated, fence, cursor, next_cursor and
    entries fields. DB entries contain object_key, state, and size_bytes; state
    must be live. S3 entries contain key and size. Sizes are nonnegative signed
    64-bit integers. Initial cursor and terminal next_cursor must be None.
    The caller must keep the fence held until after fence_after is captured.
    """
    fence = _text(fence_before, MAX_TOKEN_BYTES)
    if _text(fence_after, MAX_TOKEN_BYTES) != fence:
        _fail()
    db = _pages(database_pages, fence, True)
    s3 = _pages(s3_pages, fence, False)
    if db != s3:
        _fail()
