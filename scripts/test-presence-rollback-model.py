#!/usr/bin/env python3
"""Isolated state-machine model, not a protocol or cryptographic implementation.

Assumes an honest, durable, linearizable authority and authenticated callers.
The authority is not implemented by this repository. No network or MLS is used.
"""
import unittest


class Registry:
    def __init__(self):
        self.rows = {}

    def replace(self, scope, expected, generation, group, operation):
        # Model one serializable transaction. Tombstones survive revocation.
        row = self.rows.get(scope, (0, None, frozenset(), {}))
        current, active, used, operations = row
        proposal = (expected, generation, group)
        if operation in operations:
            if operations[operation] != proposal:
                raise ValueError('operation reused')
            if (current, active) != (generation, group):
                raise ValueError('operation superseded')
            return (generation, group)
        if expected != current or generation <= current or group in used:
            raise ValueError('conflict or replay')
        operations = {**operations, operation: proposal}
        self.rows[scope] = (generation, group, used | {group}, operations)
        return (generation, group)

    def validate(self, scope, snapshot):
        row = self.rows.get(scope)
        return row is not None and snapshot == row[:2]


class RollbackModelTest(unittest.TestCase):
    def test_rollback_and_group_reuse_fail(self):
        r = Registry()
        scope = ('sender-device', 'recipient-account', 'direct')
        old = r.replace(scope, 0, 1, 'A', 'op1')
        new = r.replace(scope, 1, 2, 'B', 'op2')
        self.assertFalse(r.validate(scope, old))
        self.assertTrue(r.validate(scope, new))
        with self.assertRaises(ValueError):
            r.replace(scope, 2, 3, 'A', 'op3')

    def test_lost_response_and_concurrent_proposals(self):
        r = Registry()
        scope = ('s', 'r', 'd')
        result = r.replace(scope, 0, 1, 'A', 'op1')
        self.assertEqual(r.replace(scope, 0, 1, 'A', 'op1'), result)
        with self.assertRaises(ValueError):
            r.replace(scope, 0, 1, 'B', 'op2')
        with self.assertRaises(ValueError):
            r.replace(scope, 0, 1, 'B', 'op1')
        r.replace(scope, 1, 2, 'B', 'op2')
        # A retry must not return success after another replacement wins.
        with self.assertRaises(ValueError):
            r.replace(scope, 0, 1, 'A', 'op1')
        self.assertFalse(r.validate(scope, result))

    def test_server_rollback_defeats_the_model(self):
        r = Registry()
        scope = ('s', 'r', 'd')
        old = r.replace(scope, 0, 1, 'A', 'op1')
        restored_rows = dict(r.rows)
        r.replace(scope, 1, 2, 'B', 'op2')
        r.rows = restored_rows  # malicious authority or restored server backup
        self.assertTrue(r.validate(scope, old))


if __name__ == '__main__':
    unittest.main()
