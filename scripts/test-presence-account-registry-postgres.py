#!/usr/bin/env python3
"""Isolated PostgreSQL integration prototype; never connect to an existing server."""
import concurrent.futures
import os
from pathlib import Path
import subprocess
import tempfile
import time
import unittest

ROOT = Path(os.environ.get('PRESENCE_TEST_PG_ROOT', '/tmp/chat-irc-pg-isolated-root'))
BIN = ROOT / 'usr/bin'
ENV = dict(os.environ, LD_LIBRARY_PATH=str(ROOT / 'usr/lib64'), PGCONNECT_TIMEOUT='3')
SQL = Path(__file__).with_name('presence-account-registry-prototype.sql')

class PostgreSQLRegistry(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory(prefix='presence-pg-')
        cls.base = Path(cls.tmp.name)
        cls.data = cls.base / 'data'
        cls.sock = cls.base / 'socket'
        cls.sock.mkdir()
        cls.started = False
        try:
            subprocess.run([str(BIN/'initdb'), '-L', str(ROOT/'usr/share/pgsql'), '-D', str(cls.data), '-A', 'trust', '--no-locale', '-U', 'prototype'], env=ENV, check=True, capture_output=True, text=True)
            subprocess.run([str(BIN/'pg_ctl'), '-D', str(cls.data), '-l', str(cls.base/'server.log'), '-o', f"-k {cls.sock} -p 55439 -c listen_addresses=''", '-w', 'start'], env=ENV, check=True, capture_output=True, text=True)
            cls.started = True
            cls.run_sql(SQL.read_text())
        except BaseException:
            cls.tearDownClass()
            raise

    @classmethod
    def tearDownClass(cls):
        if cls.started:
            subprocess.run([str(BIN/'pg_ctl'), '-D', str(cls.data), '-m', 'immediate', '-w', 'stop'], env=ENV, check=True, capture_output=True, text=True)
            cls.started = False
        cls.tmp.cleanup()

    @classmethod
    def command(cls):
        return [str(BIN/'psql'), '-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1', '-h', str(cls.sock), '-p', '55439', '-U', 'prototype', '-d', 'postgres']

    @classmethod
    def run_sql(cls, sql, ok=True):
        p = subprocess.run(cls.command(), input=sql, text=True, capture_output=True, env=ENV, timeout=15)
        if ok and p.returncode: raise AssertionError(p.stderr)
        if not ok and not p.returncode: raise AssertionError('expected rejection: '+sql)
        return p.stdout.strip()

    def setUp(self):
        self.run_sql('TRUNCATE operations, used_groups, audience, devices, accounts;')
        self.run_sql("SELECT activate('alice','phone',true);")

    def change(self, device, epoch, recipient, gen, op, selected, group):
        g = 'NULL' if group is None else "'"+group+"'"
        return f"SELECT change_grant('alice','{device}',{epoch},'{recipient}',{gen},'{op}',{str(selected).lower()},{g});"

    def test_recovery_revoke_and_current_retry(self):
        first = self.change('phone',0,'bob',0,'one',True,'A')
        self.assertEqual(self.run_sql(first), '1')
        self.assertEqual(self.run_sql(first), '1')
        self.run_sql("SELECT recover('alice','new',false);", False)
        self.run_sql("SELECT recover('alice','new',true);")
        self.assertEqual(self.run_sql("SELECT generation,selected,active_group IS NULL FROM audience WHERE account='alice' AND recipient='bob';"), '1|t|t')
        self.run_sql(first, False)
        self.run_sql(self.change('new',1,'bob',1,'two',True,'A'), False)
        self.run_sql(self.change('new',1,'carol',0,'other',True,'A'), False)
        self.run_sql(self.change('new',1,'bob',1,'two',True,'B'))
        self.run_sql(self.change('new',1,'bob',2,'three',False,None))
        self.run_sql(self.change('new',1,'bob',3,'four',True,'B'), False)
        self.run_sql(self.change('new',1,'bob',3,'four',True,'C'))
        self.run_sql(self.change('new',1,'bob',1,'two',True,'B'), False)
        self.run_sql(self.change('new',1,'bob',4,'four',True,'D'), False)

    def test_real_concurrent_device_cas_and_shared_group(self):
        self.run_sql("SELECT enroll('alice','laptop',0);")
        def race(queries):
            with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
                return list(pool.map(lambda q: subprocess.run(self.command(), input=q, text=True, capture_output=True, env=ENV, timeout=15).returncode, queries))
        codes = race([self.change('phone',0,'bob',0,'a',True,'A'), self.change('laptop',0,'bob',0,'b',True,'B')])
        self.assertEqual(sorted(codes), [0,3])
        self.run_sql('TRUNCATE operations, used_groups, audience, devices, accounts;')
        self.run_sql("SELECT activate('alice','phone',true); SELECT enroll('alice','laptop',0);")
        codes = race([self.change('phone',0,'carol',0,'c',True,'C'), self.change('laptop',0,'dave',0,'d',True,'C')])
        self.assertEqual(sorted(codes), [0,3])
        self.assertEqual(self.run_sql("SELECT count(*) FROM used_groups WHERE account='alice' AND group_id='C';"), '1')

    def test_bounds_and_atomic_failure(self):
        self.run_sql("SELECT activate('legacy','d',false);", False)
        self.run_sql("SELECT activate('other','d',true);")
        self.run_sql("SELECT activate('third','d',true);", False)
        self.run_sql("SELECT enroll('alice','laptop',0); SELECT enroll('alice','tablet',0);")
        self.run_sql("SELECT enroll('alice','extra',0);", False)
        self.run_sql(self.change('phone',0,'x'*129,0,'op',True,'G'), False)
        self.run_sql(self.change('phone',0,'bob',0,'a',True,'A'))
        self.run_sql(self.change('phone',0,'carol',0,'b',True,'B'))
        self.run_sql(self.change('phone',0,'dave',0,'c',True,'C'), False)
        self.run_sql(self.change('phone',0,'bob',1,'c',True,'C'))
        self.run_sql(self.change('phone',0,'bob',2,'d',True,'D'))
        self.run_sql(self.change('phone',0,'bob',3,'e',True,'E'), False)
        self.assertEqual(self.run_sql("SELECT count(*) FROM operations WHERE account='alice';"), '4')
        for i in range(4,8): self.run_sql(self.change('phone',0,'bob',i-1,'op'+str(i),False,None))
        self.run_sql(self.change('phone',0,'bob',7,'overflow',False,None), False)
        self.assertEqual(self.run_sql("SELECT count(*) FROM operations WHERE account='alice';"), '8')

    def test_global_limits_and_account_scope(self):
        self.run_sql("SELECT activate('other','d',true);")
        self.run_sql(self.change('phone',0,'bob',0,'a',True,'shared'))
        self.run_sql("SELECT change_grant('other','d',0,'bob',0,'a',true,'shared');")
        for i in range(1,4):
            self.run_sql(self.change('phone',0,'bob',i,'a'+str(i),True,'A'+str(i)))
        self.run_sql("SELECT change_grant('other','d',0,'bob',1,'b',true,'B');")
        self.run_sql("SELECT change_grant('other','d',0,'bob',2,'c',true,'C');", False)
        self.assertEqual(self.run_sql('SELECT count(*) FROM used_groups;'), '6')
        for i in range(4,8):
            self.run_sql(self.change('phone',0,'bob',i,'a'+str(i),False,None))
        for i in range(2,4):
            self.run_sql(f"SELECT change_grant('other','d',0,'bob',{i},'b{i}',false,NULL);")
        self.run_sql("SELECT change_grant('other','d',0,'bob',4,'overflow',false,NULL);", False)
        self.assertEqual(self.run_sql('SELECT count(*) FROM operations;'), '12')

    def test_committed_grant_precedes_waiting_recovery(self):
        p = subprocess.Popen(self.command(), stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, env=ENV)
        try:
            p.stdin.write("SET application_name='presence_commit_test'; BEGIN; SELECT change_grant('alice','phone',0,'bob',0,'a',true,'A');\n")
            p.stdin.flush()
            for _ in range(100):
                if self.run_sql("SELECT count(*) FROM pg_stat_activity WHERE application_name='presence_commit_test' AND state='idle in transaction';") == '1':
                    break
                time.sleep(.05)
            else:
                self.fail('grant transaction did not become idle')
            with concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
                f = pool.submit(self.run_sql, "SELECT recover('alice','new',true);")
                time.sleep(.2)
                self.assertFalse(f.done(), 'recovery bypassed grant lock')
                p.stdin.write('COMMIT;\n')
                p.stdin.flush()
                f.result(timeout=5)
            p.stdin.close()
            p.stdin = None
            _, stderr = p.communicate(timeout=5)
            self.assertEqual(p.returncode, 0, stderr)
        finally:
            if p.poll() is None:
                p.kill()
            if p.stdin is not None and not p.stdin.closed:
                p.stdin.close()
            if p.stdout is not None:
                p.stdout.close()
            if p.stderr is not None:
                p.stderr.close()
            p.wait(timeout=5)
        self.assertEqual(self.run_sql("SELECT generation,selected,active_group IS NULL FROM audience WHERE account='alice' AND recipient='bob';"), '1|t|t')
        self.assertEqual(self.run_sql("SELECT count(*) FROM used_groups WHERE account='alice' AND group_id='A';"), '1')
        self.run_sql(self.change('new',1,'bob',1,'new',True,'A'), False)
        self.run_sql(self.change('new',1,'bob',1,'new',True,'B'))
        self.run_sql(self.change('phone',0,'bob',0,'a',True,'A'), False)

    def test_transaction_lock_order_and_rollback_on_disconnect(self):
        # A grant holds the same mutex that recovery acquires. Recovery must wait.
        p = subprocess.Popen(self.command(), stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, env=ENV)
        p.stdin.write("SET application_name='presence_crash_test'; BEGIN; SELECT lock_registry(); SELECT change_grant('alice','phone',0,'bob',0,'a',true,'A'); SELECT pg_sleep(30);\n")
        p.stdin.flush()
        for _ in range(100):
            if self.run_sql("SELECT count(*) FROM pg_locks WHERE relation='mutex'::regclass AND mode='RowShareLock' AND granted;") == '1': break
            time.sleep(.05)
        else: self.fail('transaction did not acquire mutex')
        with concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
            f = pool.submit(self.run_sql, "SELECT recover('alice','new',true);")
            time.sleep(.2)
            self.assertFalse(f.done(), 'recovery bypassed grant lock')
            self.run_sql("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name='presence_crash_test';")
            p.communicate(timeout=5)
            f.result(timeout=5)
        self.assertEqual(self.run_sql("SELECT count(*) FROM used_groups;"), '0')
        self.assertEqual(self.run_sql("SELECT count(*) FROM audience;"), '0')
        self.run_sql(self.change('new',1,'bob',0,'a',True,'A'))

if __name__ == '__main__': unittest.main(verbosity=2)
