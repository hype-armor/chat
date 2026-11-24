#!/usr/bin/env python3
"""Test-only model: no persistence, authorization protocol, network, or MLS.

All methods simulate one linearizable transaction under a process-wide lock.
Accounts are stable identities, not device identities. Recovery preserves the
selected audience but invalidates all active groups and old device operations.
Migration from device/direct-scoped history is deliberately unsupported:
activation requires a new, empty registry with proof that no legacy history
exists. An incomplete inventory, even if apparently empty, must fail closed.
The model does not establish how such proof or durable storage is obtained.
"""
import threading
import unittest
from concurrent.futures import ThreadPoolExecutor


class Reject(Exception):
    pass


class Registry:
    def __init__(self, max_accounts=2, max_audience=2, max_groups=4,
                 max_ops=8, global_groups=6, global_ops=12, max_devices=3):
        self.lock = threading.Lock()
        self.accounts = {}
        self.max_accounts, self.max_audience = max_accounts, max_audience
        self.max_groups, self.max_ops = max_groups, max_ops
        self.global_groups, self.global_ops = global_groups, global_ops
        self.max_devices = max_devices

    @staticmethod
    def identifiers(*values):
        if any(not isinstance(v, str) or not 1 <= len(v.encode('utf-8')) <= 128 for v in values):
            raise Reject('invalid identifier')

    def create(self, account, device, *, verified_empty_legacy):
        self.identifiers(account, device)
        with self.lock:
            if not verified_empty_legacy or account in self.accounts or len(self.accounts) >= self.max_accounts:
                raise Reject('activation prohibited')
            self.accounts[account] = {'epoch': 0, 'devices': {device},
                                      'audience': {}, 'used': set(), 'ops': {}}

    def recover(self, account, device):
        self.identifiers(account, device)
        with self.lock:
            a = self.accounts[account]
            a['epoch'] += 1
            a['devices'] = {device}
            # Keep consent and generation, but never keep an active group.
            for recipient, (generation, selected, _) in a['audience'].items():
                a['audience'][recipient] = (generation, selected, None)
            return a['epoch']

    def add_device(self, account, epoch, device):
        # Represents an already authorized device enrollment transaction.
        self.identifiers(account, device)
        with self.lock:
            a = self.accounts[account]
            if epoch != a['epoch']:
                raise Reject('stale enrollment')
            if device not in a['devices'] and len(a['devices']) >= self.max_devices:
                raise Reject('device limit')
            a['devices'].add(device)

    def change(self, account, device, epoch, recipient, expected, operation,
               selected, group=None):
        self.identifiers(account, device, recipient, operation, *([group] if group is not None else []))
        with self.lock:
            a = self.accounts[account]
            if epoch != a['epoch'] or device not in a['devices']:
                raise Reject('stale device or recovery epoch')
            if selected != (group is not None):
                raise Reject('selection requires exactly one fresh group')
            current = a['audience'].get(recipient, (0, False, None))
            proposal = (device, epoch, recipient, expected, selected, group)
            if operation in a['ops']:
                previous, result = a['ops'][operation]
                if previous != proposal or current != result:
                    raise Reject('operation reused or superseded')
                return result
            if expected != current[0]:
                raise Reject('generation conflict')
            if recipient not in a['audience'] and len(a['audience']) >= self.max_audience:
                raise Reject('audience history full')
            if len(a['ops']) >= self.max_ops or sum(len(x['ops']) for x in self.accounts.values()) >= self.global_ops:
                raise Reject('operation history full')
            if selected:
                if group in a['used']:
                    raise Reject('group replay')
                if len(a['used']) >= self.max_groups or sum(len(x['used']) for x in self.accounts.values()) >= self.global_groups:
                    raise Reject('group history full')
            result = (expected + 1, selected, group)
            a['audience'][recipient] = result
            if selected:
                a['used'].add(group)
            a['ops'][operation] = (proposal, result)
            return result

    def valid(self, account, recipient, snapshot):
        with self.lock:
            a = self.accounts[account]
            return (snapshot[1] and snapshot[2] is not None and
                    a['audience'].get(recipient) == snapshot)


class RecoveryModelTest(unittest.TestCase):
    def setUp(self):
        self.r = Registry()
        self.r.create('alice', 'phone', verified_empty_legacy=True)

    def change(self, device, epoch, recipient, generation, op, selected, group=None):
        return self.r.change('alice', device, epoch, recipient, generation, op, selected, group)

    def test_recovery_preserves_audience_and_fences_replay(self):
        old = self.change('phone', 0, 'bob', 0, 'one', True, 'A')
        self.assertEqual(self.r.recover('alice', 'new'), 1)
        self.assertEqual(self.r.accounts['alice']['audience']['bob'], (1, True, None))
        self.assertFalse(self.r.valid('alice', 'bob', old))
        with self.assertRaises(Reject):
            self.change('phone', 0, 'bob', 0, 'one', True, 'A')
        with self.assertRaises(Reject):
            self.change('new', 1, 'bob', 1, 'two', True, 'A')
        fresh = self.change('new', 1, 'bob', 1, 'two', True, 'B')
        self.assertTrue(self.r.valid('alice', 'bob', fresh))
        with self.assertRaises(Reject):
            self.change('new', 1, 'carol', 0, 'three', True, 'A')

    def test_revoke_regrant_and_stale_retry(self):
        first = self.change('phone', 0, 'bob', 0, 'a', True, 'A')
        self.assertEqual(first, self.change('phone', 0, 'bob', 0, 'a', True, 'A'))
        self.change('phone', 0, 'bob', 1, 'b', False)
        with self.assertRaises(Reject):
            self.change('phone', 0, 'bob', 2, 'c', True, 'A')
        self.change('phone', 0, 'bob', 2, 'c', True, 'B')
        with self.assertRaises(Reject):
            self.change('phone', 0, 'bob', 0, 'a', True, 'A')
        with self.assertRaises(Reject):
            self.change('phone', 0, 'bob', 3, 'c', True, 'C')

    def test_concurrent_devices_and_shared_group_history(self):
        self.r.add_device('alice', 0, 'laptop')
        barrier = threading.Barrier(2)
        def attempt(device, recipient):
            barrier.wait()
            try:
                return self.change(device, 0, recipient, 0, device, True, 'same')
            except Reject:
                return None
        with ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(lambda x: attempt(*x), [('phone', 'bob'), ('laptop', 'carol')]))
        self.assertEqual(sum(x is not None for x in results), 1)
        self.assertEqual(len(self.r.accounts['alice']['used']), 1)

    def test_bounds_fail_closed_without_partial_mutation(self):
        r = Registry(max_accounts=2, max_audience=1, max_groups=1, max_ops=2,
                     global_groups=1, global_ops=2)
        r.create('a', 'd', verified_empty_legacy=True)
        r.create('b', 'd', verified_empty_legacy=True)
        with self.assertRaises(Reject):
            r.create('c', 'd', verified_empty_legacy=True)
        r.change('a', 'd', 0, 'x', 0, '1', True, 'G')
        with self.assertRaises(Reject):
            r.change('a', 'd', 0, 'y', 0, '2', True, 'H')
        with self.assertRaises(Reject):
            r.change('b', 'd', 0, 'x', 0, '1', True, 'H')
        r.change('a', 'd', 0, 'x', 1, '2', False)
        with self.assertRaises(Reject):
            r.change('a', 'd', 0, 'x', 2, '3', False)
        with self.assertRaises(Reject):
            r.change('b', 'd', 0, 'x', 0, '2', False)
        self.assertEqual(r.accounts['a']['used'], {'G'})
        self.assertEqual(len(r.accounts['a']['ops']), 2)
        self.assertEqual(r.accounts['b']['audience'], {})

    def test_device_and_identifier_bounds(self):
        self.r.add_device('alice', 0, 'laptop')
        self.r.add_device('alice', 0, 'tablet')
        with self.assertRaises(Reject):
            self.r.add_device('alice', 0, 'extra')
        with self.assertRaises(Reject):
            self.change('phone', 0, 'x' * 129, 0, 'op', True, 'G')
        self.assertEqual(self.r.accounts['alice']['audience'], {})

    def test_no_legacy_activation_without_complete_proof(self):
        with self.assertRaises(Reject):
            self.r.create('legacy', 'd', verified_empty_legacy=False)
        self.assertNotIn('legacy', self.r.accounts)


if __name__ == '__main__':
    unittest.main()
