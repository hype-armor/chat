import hashlib
import json
import os
import tempfile
import unittest
import uuid
from unittest.mock import patch

from username_migration_ordered_fence_testonly import FakeDocker, FakeGate, OrderedFakeFence
from username_migration_stop_order_testonly import StopOrderError


class OrderedFenceTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.fd = os.open(self.tmp.name, os.O_RDONLY | os.O_DIRECTORY)
        self.addCleanup(os.close, self.fd)
        self.op = str(uuid.uuid4())
        self.raw = json.dumps({'services': {'app': {'depends_on': ['db']}, 'worker': {}, 'db': {}}}).encode()
        self.roles = [('app', 'writer'), ('worker', 'writer'), ('db', 'storage')]
        self.order = ['app', 'worker', 'db']
        self.profiles = []
        self.services = {'app': 'a' * 64, 'worker': 'b' * 64, 'db': 'c' * 64}
        self.runner = FakeDocker(self.services, 'db')
        self.gate = FakeGate(self.op)
        self.anchor = (self.op, hashlib.sha256(self.raw).hexdigest(), (), tuple(self.roles), 'db', tuple(self.order))
        self.kw = dict(journal_fd=self.fd, config_bytes=self.raw, operation=self.op,
                       profiles=self.profiles, classifications=self.roles, postgres='db',
                       explicit_order=self.order, verify_anchor=lambda *args: args == self.anchor,
                       services=self.services, gates=[self.gate], runner=self.runner,
                       clean_drain_services={'app', 'worker'})

    def test_valid_order_reaches_real_fence_with_fakes(self):
        wrapper = OrderedFakeFence(**self.kw)
        wrapper.engage()
        stops = [call[-1] for call in self.runner.calls if call[3:5] == ['container', 'stop']]
        self.assertEqual(stops, [self.services[s] for s in self.order])
        with open(os.path.join(self.tmp.name, 'docker-fence.json')) as f:
            journal = json.load(f)
        self.assertEqual(journal['operation_id'], self.op)
        self.assertEqual(journal['stop_order'], self.order)

    def test_unanchored_inputs_fail_before_construction_or_effects(self):
        cases = [dict(config_bytes=self.raw + b' '), dict(operation=str(uuid.uuid4())),
                 dict(profiles=['extra']), dict(classifications=[('app', 'other'), *self.roles[1:]]),
                 dict(explicit_order=['worker', 'app', 'db']), dict(explicit_order=None),
                 dict(verify_anchor=lambda *args: True, explicit_order=['db', 'app', 'worker']),
                 dict(verify_anchor=lambda *args: False), dict(runner=lambda *args, **kwargs: None)]
        for change in cases:
            with self.subTest(change=change), patch('username_migration_ordered_fence_testonly.DockerFence') as fence:
                with self.assertRaises(StopOrderError):
                    OrderedFakeFence(**(self.kw | change))
                fence.assert_not_called()
                self.assertEqual(self.runner.calls, [])
                self.assertFalse(self.gate.engaged)

    def test_changes_after_validation_fail_before_fence_or_effects(self):
        for field, value in [('config_bytes', self.raw + b' '), ('operation', str(uuid.uuid4())),
                             ('profiles', ['x']), ('classifications', [('app', 'other'), *self.roles[1:]]),
                             ('explicit_order', ['worker', 'app', 'db'])]:
            with self.subTest(field=field):
                wrapper = OrderedFakeFence(**self.kw)
                setattr(wrapper, field, value)
                with patch('username_migration_ordered_fence_testonly.DockerFence') as fence:
                    with self.assertRaises(StopOrderError): wrapper.engage()
                    fence.assert_not_called()
                self.assertEqual(self.runner.calls, [])
                self.assertFalse(self.gate.engaged)

    def test_new_anchor_cannot_rebind_existing_wrapper(self):
        wrapper = OrderedFakeFence(**self.kw)
        self.order[:] = ['worker', 'app', 'db']
        self.anchor = (*self.anchor[:-1], tuple(self.order))
        with self.assertRaises(StopOrderError): wrapper.engage()
        self.assertEqual(self.runner.calls, [])
        self.assertFalse(self.gate.engaged)

    def test_incomplete_classification_or_services_rejected(self):
        self.kw['classifications'] = self.roles[:-1]
        self.anchor = (*self.anchor[:3], tuple(self.roles[:-1]), *self.anchor[4:])
        with self.assertRaises(StopOrderError): OrderedFakeFence(**self.kw)
        self.assertEqual(self.runner.calls, [])


if __name__ == '__main__':
    unittest.main()
