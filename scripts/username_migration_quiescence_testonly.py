"""Read-only SQL evidence for a fresh, disposable IsolatedPostgres fixture only.

Covered: storage_objects reserved/writing/ready/live; blob_uploads rows,
retiring and completion claims (including stale claims); blob_upload_transfers
uploading/complete/expired. Counts overlap. Unknown states and changed covered
column names and types fail closed. Constraints and other schema changes are
not verified. Uncovered tables: accounts, devices, key_packages,
queued_envelopes, group_epochs, blobs, verification_codes, code_requests,
conversation_members, key_package_claims, rate_limits, link_requests, reports,
invites, backups, storage_policy, account_storage_policy, account_send_limits,
username_reservations, username_changes, account_deletion_authorizations.
Their states and claims are not checked. Deletion has no separate durable
storage state in PR #158: interrupted deletion can leave live rows or orphaned
objects and is NOT detected reliably.

A clean SQL result cannot prove DB/blob consistency or SeaweedFS durability.
Object reconciliation and a physical fence remain required. This is not a
production gate. The supervisor and its binary tree must be trusted; same-UID
endpoint substitution remains outside its guarantees.
"""
import json
import subprocess

from isolated_pg_supervisor import IsolatedPostgres

# Exact column names and PostgreSQL types for the three covered PR #158 tables.
_COLUMNS = {
    'storage_objects': 'account_id:uuid,object_key:text,size_bytes:bigint,state:text',
    'blob_uploads': 'completion_claim:uuid,completion_claimed_at:timestamp with time zone,device_id:uuid,expires_at:timestamp with time zone,parts:integer,received:integer[],retiring:boolean,size_bytes:bigint,upload_id:uuid',
    'blob_upload_transfers': 'blob_id:uuid,ciphertext_sha256:bytea,device_id:uuid,size_bytes:bigint,state:text,transfer_id:uuid,upload_id:uuid',
}


def check(cluster):
    """Return aggregate counts; raise on an unknown schema or state.

    The caller must create and own this supervisor's disposable fixture. No
    arbitrary connection string, database name, runner, or SQL is accepted.
    """
    if type(cluster) is not IsolatedPostgres or cluster.closed or cluster.process is None:
        raise ValueError('a running disposable IsolatedPostgres fixture is required')
    expected = json.dumps(_COLUMNS, sort_keys=True, separators=(',', ':'))
    # All reads use one repeatable-read snapshot, with writes prohibited by PG.
    sql = r"""
BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;
SELECT json_build_object(
 'schema', (SELECT json_object_agg(t.name, COALESCE((SELECT string_agg(a.attname || ':' || pg_catalog.format_type(a.atttypid,a.atttypmod), ',' ORDER BY a.attname)
   FROM pg_catalog.pg_attribute a WHERE a.attrelid = pg_catalog.to_regclass('public.' || t.name) AND a.attnum > 0 AND NOT a.attisdropped), ''))
   FROM (VALUES ('storage_objects'), ('blob_uploads'), ('blob_upload_transfers')) t(name)),
 'storage_reserved', (SELECT count(*) FROM public.storage_objects WHERE state = 'reserved'),
 'storage_writing', (SELECT count(*) FROM public.storage_objects WHERE state = 'writing'),
 'storage_ready', (SELECT count(*) FROM public.storage_objects WHERE state = 'ready'),
 'storage_live', (SELECT count(*) FROM public.storage_objects WHERE state = 'live'),
 'storage_unknown', (SELECT count(*) FROM public.storage_objects WHERE state IS NULL OR state NOT IN ('reserved','writing','ready','live')),
 'uploads', (SELECT count(*) FROM public.blob_uploads),
 'uploads_retiring', (SELECT count(*) FROM public.blob_uploads WHERE retiring IS TRUE),
 'uploads_invalid', (SELECT count(*) FROM public.blob_uploads WHERE retiring IS NULL OR ((completion_claim IS NULL) <> (completion_claimed_at IS NULL))),
 'completion_claims', (SELECT count(*) FROM public.blob_uploads WHERE completion_claim IS NOT NULL OR completion_claimed_at IS NOT NULL),
 'transfers_uploading', (SELECT count(*) FROM public.blob_upload_transfers WHERE state = 'uploading'),
 'transfers_complete', (SELECT count(*) FROM public.blob_upload_transfers WHERE state = 'complete'),
 'transfers_expired', (SELECT count(*) FROM public.blob_upload_transfers WHERE state = 'expired'),
 'transfers_unknown', (SELECT count(*) FROM public.blob_upload_transfers WHERE state IS NULL OR state NOT IN ('uploading','complete','expired'))
)::text;
COMMIT;
"""
    try:
        result = cluster.run('psql', ['-X', '-qAt', '-w', '-v', 'ON_ERROR_STOP=1', '-d', 'postgres', '-f', '-'], input=sql.encode(), stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=20)
        data = json.loads(result.stdout)
        schema = data.pop('schema')
        if json.dumps(schema, sort_keys=True, separators=(',', ':')) != expected:
            raise ValueError('unexpected covered schema')
        if any(type(v) is not int or v < 0 for v in data.values()):
            raise ValueError('invalid counts')
        if any(data.pop(k) for k in ('storage_unknown', 'uploads_invalid', 'transfers_unknown')):
            raise ValueError('unexpected state')
        return data
    except (subprocess.SubprocessError, OSError, json.JSONDecodeError, KeyError) as exc:
        raise ValueError('quiescence query failed') from exc
