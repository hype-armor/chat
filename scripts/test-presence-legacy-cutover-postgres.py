#!/usr/bin/env python3
"""Test the actual cutover migration in a new isolated PostgreSQL cluster."""
import concurrent.futures
import importlib.util
from pathlib import Path
import subprocess
import time
import unittest

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('pg_prototype', HERE / 'test-presence-account-registry-postgres.py')
pg = importlib.util.module_from_spec(spec)
spec.loader.exec_module(pg)

class Cutover(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        # Reuse the isolated cluster lifecycle, not its registry schema or tests.
        pg.PostgreSQLRegistry.setUpClass()
        cls.db = pg.PostgreSQLRegistry
        cls.db.run_sql('DROP SCHEMA public CASCADE; CREATE SCHEMA public;')
        cls.db.run_sql((HERE.parent / 'crates/chat-server/migrations/0022_experimental_presence_replacement.sql').read_text())
        # Migration must succeed with legacy data and leave writes enabled.
        cls.db.run_sql(cls.insert)
        cls.db.run_sql((HERE.parent / 'crates/chat-server/migrations/0023_presence_legacy_cutover_guard.sql').read_text())
        assert cls.db.run_sql('SELECT frozen FROM presence_legacy_cutover_guard;') == 'f'
        assert cls.db.run_sql('SELECT count(*) FROM presence_replacement_scopes;') == '1'

    @classmethod
    def tearDownClass(cls):
        pg.PostgreSQLRegistry.tearDownClass()

    def setUp(self):
        self.db.run_sql('UPDATE presence_legacy_cutover_guard SET frozen=false; TRUNCATE presence_replacement_history, presence_replacement_scopes;')

    insert = "INSERT INTO presence_replacement_scopes(sender_device,recipient,direct_id) VALUES ('00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000002',decode('01','hex'));"
    freeze = 'SELECT presence_freeze_empty_legacy();'

    def start_transaction(self, name, sql):
        p = subprocess.Popen(self.db.command(), stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, env=pg.ENV)
        p.stdin.write(f"SET application_name='{name}'; BEGIN; {sql}\n")
        p.stdin.flush()
        for _ in range(100):
            if self.db.run_sql(f"SELECT count(*) FROM pg_stat_activity WHERE application_name='{name}' AND state='idle in transaction';") == '1':
                return p
            if p.poll() is not None:
                break
            time.sleep(.05)
        p.kill()
        p.communicate()
        self.fail('transaction did not reach idle state')

    def end_transaction(self, p, action):
        p.stdin.write(action + ';\n')
        p.stdin.close()
        p.stdin = None
        _, stderr = p.communicate(timeout=5)
        self.assertEqual(p.returncode, 0, stderr)

    def test_empty_freeze_rejects_all_old_writes_and_is_idempotent(self):
        self.db.run_sql(self.freeze + self.freeze)
        for table in ['presence_replacement_scopes', 'presence_replacement_history']:
            for sql in [f'UPDATE {table} SET recipient=recipient;',
                        f'DELETE FROM {table};', f'TRUNCATE {table};']:
                self.db.run_sql(sql, False)
        self.db.run_sql(self.insert, False)
        self.db.run_sql("""INSERT INTO presence_replacement_history
            (sender_device,recipient,direct_id,operation,expected,generation,group_id)
            VALUES ('00000000-0000-0000-0000-000000000001',
                    '00000000-0000-0000-0000-000000000002',decode('01','hex'),
                    '00000000-0000-0000-0000-000000000003',0,1,decode('02','hex'));""", False)

    def test_missing_guard_fails_closed(self):
        self.db.run_sql('DELETE FROM presence_legacy_cutover_guard;')
        try:
            self.db.run_sql(self.insert, False)
            self.db.run_sql(self.freeze, False)
        finally:
            self.db.run_sql('INSERT INTO presence_legacy_cutover_guard DEFAULT VALUES;')

    def test_orphan_scope_blocks_cutover(self):
        self.db.run_sql(self.insert)
        self.db.run_sql(self.freeze, False)
        self.assertEqual(self.db.run_sql('SELECT frozen FROM presence_legacy_cutover_guard;'), 'f')
        self.assertEqual(self.db.run_sql('SELECT count(*) FROM presence_replacement_scopes;'), '1')

    def test_orphan_history_alone_blocks_cutover(self):
        # Simulate an orphan left by older or inconsistent data. The migration
        # must not assume that the scope foreign key proves global emptiness.
        self.db.run_sql(self.insert + """
            INSERT INTO presence_replacement_history
              (sender_device,recipient,direct_id,operation,expected,generation,group_id)
            VALUES ('00000000-0000-0000-0000-000000000001',
                    '00000000-0000-0000-0000-000000000002',decode('01','hex'),
                    '00000000-0000-0000-0000-000000000003',0,1,decode('02','hex'));
            SET session_replication_role=replica;
            DELETE FROM presence_replacement_scopes;
            SET session_replication_role=origin;
        """)
        self.db.run_sql(self.freeze, False)
        self.assertEqual(self.db.run_sql('SELECT frozen FROM presence_legacy_cutover_guard;'), 'f')
        self.assertEqual(self.db.run_sql('SELECT count(*) FROM presence_replacement_history;'), '1')

    def test_old_writer_commits_before_waiting_freeze(self):
        p = self.start_transaction('legacy_writer', self.insert)
        try:
            with concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
                future = pool.submit(self.db.run_sql, self.freeze, False)
                time.sleep(.25)
                self.assertFalse(future.done())
                self.end_transaction(p, 'COMMIT')
                future.result(timeout=5)
            self.assertEqual(self.db.run_sql('SELECT frozen FROM presence_legacy_cutover_guard;'), 'f')
        finally:
            if p.poll() is None:
                p.kill(); p.communicate()

    def test_freeze_proof_is_not_visible_before_commit(self):
        # An activation transaction must observe a previously committed freeze.
        # The transaction that creates the freeze cannot establish that proof by
        # reading its own uncommitted update.
        p = self.start_transaction('uncommitted_freeze_proof', self.freeze)
        try:
            self.assertEqual(self.db.run_sql('SELECT frozen FROM presence_legacy_cutover_guard;'), 'f')
            self.end_transaction(p, 'ROLLBACK')
            self.assertEqual(self.db.run_sql('SELECT frozen FROM presence_legacy_cutover_guard;'), 'f')
            self.db.run_sql(self.freeze)
            self.assertEqual(self.db.run_sql('SELECT frozen FROM presence_legacy_cutover_guard;'), 't')
            self.assertEqual(self.db.run_sql('SELECT count(*) FROM presence_replacement_scopes;'), '0')
            self.assertEqual(self.db.run_sql('SELECT count(*) FROM presence_replacement_history;'), '0')
        finally:
            if p.poll() is None:
                p.kill(); p.communicate()

    def test_freeze_commit_blocks_waiting_writer_and_rollback_unblocks(self):
        for action, rejected in [('COMMIT', True), ('ROLLBACK', False)]:
            if action == 'ROLLBACK':
                self.db.run_sql('UPDATE presence_legacy_cutover_guard SET frozen=false;')
            p = self.start_transaction('legacy_freeze', self.freeze)
            try:
                with concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
                    future = pool.submit(self.db.run_sql, self.insert, not rejected)
                    time.sleep(.25)
                    self.assertFalse(future.done())
                    self.end_transaction(p, action)
                    future.result(timeout=5)
            finally:
                if p.poll() is None:
                    p.kill(); p.communicate()
        self.assertEqual(self.db.run_sql('SELECT count(*) FROM presence_replacement_scopes;'), '1')

if __name__ == '__main__':
    unittest.main()
