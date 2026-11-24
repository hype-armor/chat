"""Disposable PostgreSQL integration tests; never connect to an existing server."""
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

from isolated_pg_supervisor import IsolatedPostgres
import username_migration_quiescence_testonly as checker

ROOT = Path(os.environ.get('TEST_PG_ROOT', '/tmp/chat-irc-pg-isolated-root/usr')).resolve()
BIN = Path(os.environ.get('TEST_PG_BIN', ROOT / 'bin')).resolve()
LIB = Path(os.environ.get('TEST_PG_LIB', ROOT / 'lib64')).resolve()
SHARE = Path(os.environ.get('TEST_PG_SHARE', ROOT / 'share/pgsql')).resolve()
MIGRATIONS = Path(os.environ.get('TEST_USERNAME_MIGRATIONS', '/tmp/chat-irc-username-release/crates/chat-server/migrations'))


@unittest.skipUnless((BIN / 'initdb').is_file() and MIGRATIONS.is_dir(), 'fixture dependencies unavailable')
class QuiescenceTest(unittest.TestCase):
    def test_read_only_counts_and_fail_closed(self):
        with tempfile.TemporaryDirectory(prefix='quiescence-fixture-') as temp:
            with IsolatedPostgres(bindir=str(BIN), share=str(SHARE),
                                  library_path=str(LIB), parent=temp) as pg:
                def sql(query):
                    return pg.run('psql', ['-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-d', 'postgres', '-c', query],
                                  stdout=subprocess.PIPE, stderr=subprocess.PIPE).stdout
                for path in sorted(MIGRATIONS.glob('*.sql')):
                    sql(path.read_text())
                clean = checker.check(pg)
                self.assertTrue(all(v == 0 for v in clean.values()))
                sql("""INSERT INTO storage_objects(object_key,size_bytes,state) VALUES
                    ('secret-reserved',1,'reserved'),('secret-writing',1,'writing'),
                    ('secret-ready',1,'ready'),('secret-live',1,'live');
                    INSERT INTO blob_uploads(upload_id,device_id,size_bytes,parts,expires_at,retiring,completion_claim,completion_claimed_at)
                    VALUES ('00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000002',1,1,now(),true,'00000000-0000-0000-0000-000000000003',now()-interval '1 day');
                    INSERT INTO blob_upload_transfers(transfer_id,device_id,size_bytes,ciphertext_sha256,upload_id,state)
                    VALUES ('00000000-0000-0000-0000-000000000004','00000000-0000-0000-0000-000000000002',1,decode(repeat('00',32),'hex'),'00000000-0000-0000-0000-000000000001','uploading');""")
                before = sql('SELECT count(*) FROM storage_objects')
                counts = checker.check(pg)
                for name in ('storage_reserved','storage_writing','storage_ready','storage_live','uploads','uploads_retiring','completion_claims','transfers_uploading'):
                    self.assertEqual(counts[name], 1, name)
                self.assertNotIn('secret', str(counts))
                self.assertEqual(before, sql('SELECT count(*) FROM storage_objects'))
                sql("ALTER TABLE storage_objects DROP CONSTRAINT storage_objects_state_check; UPDATE storage_objects SET state='unexpected' WHERE state='ready'")
                with self.assertRaises(ValueError):
                    checker.check(pg)
                sql("UPDATE storage_objects SET state='ready' WHERE state='unexpected'; ALTER TABLE blob_uploads ADD COLUMN unexpected text")
                with self.assertRaises(ValueError):
                    checker.check(pg)

    def test_reject_non_fixture(self):
        with self.assertRaises(ValueError):
            checker.check(object())
