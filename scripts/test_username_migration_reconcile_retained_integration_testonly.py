"""Synthetic integration only. No Docker process or operational authorization.

Created network endpoints are not modeled as Docker behavior. Networked
replacements without observed endpoints must fail closed.
"""
import copy
import os
import tempfile
import unittest

from test_username_migration_retained_resources_testonly import Docker
from username_migration_compose_resources_testonly import _canonical
from username_migration_compose_runtime import _digest
from username_migration_reconcile_testonly import reconcile, ReconcileError
from username_migration_retained_resources_testonly import verify, RetainedResourcesError


class Integration(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.path = os.path.join(tmp.name, 'inventory')
        self.op = '00000000-0000-4000-8000-000000000001'
        self.runtime_digest = _digest(b'independently anchored synthetic runtime')
        self.nid = 'b' * 64
        self.volume = {'Name': 'p_data', 'Driver': 'local', 'Options': None,
                       'Mountpoint': '/vol', 'CreatedAt': 'time', 'Labels': {
                           'com.docker.compose.project': 'p', 'com.docker.compose.volume': 'data'}}
        self.network = {'Name': 'p_net', 'Id': self.nid, 'Driver': 'bridge', 'Options': {},
                        'Labels': {'com.docker.compose.project': 'p', 'com.docker.compose.network': 'net'},
                        'Containers': {'2' * 64: {'IPv4Address': '172.20.0.2/16'}},
                        'IPAM': {'Driver': 'default', 'Config': [{'Subnet': '172.20.0.0/16', 'Gateway': '172.20.0.1'}]}}
        self.mounts = [{'Type': 'volume', 'Name': 'p_data', 'Source': '/vol'}]
        def original(service, cid, mounts, networks):
            return {'id': cid, 'labels': {'com.docker.compose.project': 'p',
                    'com.docker.compose.service': service}, 'mounts': mounts, 'networks': networks}
        self.evidence = {'version': 1, 'operation': self.op, 'runtime_digest': self.runtime_digest,
                         'containers': {'db': original('db', '1' * 64, self.mounts, {}),
                                        'app': original('app', '2' * 64, [], {'p_net': {'id': self.nid}})},
                         'volumes': {'p_data': self.volume}, 'networks': {'p_net': self.network}}
        data = _canonical(self.evidence)
        with open(self.path, 'wb') as f:
            f.write(data)
        os.chmod(self.path, 0o600)
        self.digest = _digest(data)
        self.docker = Docker(self.volume, self.network)
        self.observed = {}
        self.events = []
        self.lost = False
        self.mutation = None
        # This separate synthetic authority represents independently anchored
        # operation/service/container bindings, not labels on Docker records.
        self.authorized = {'db': '3' * 64, 'app': '4' * 64}

    def inspect(self):
        self.events.append(('inspect', dict(self.observed)))
        return list(self.observed.items())

    def independently_verify(self, service, identity):
        self.events.append(('verify', service, identity))
        record = self.docker.records.get(identity, {})
        return (self.authorized.get(service) == identity and record.get('Id') == identity
                and record.get('State', {}).get('Running') is False)

    def resources(self, observed):
        self.events.append(('resources', dict(observed)))
        def replacement_verifier(*, operation, project, service, container_id):
            return (operation == self.op and project == 'p'
                    and self.independently_verify(service, container_id))
        try:
            return verify(inventory_path=self.path, inventory_digest=self.digest,
                          operation=self.op, project='p', fake_docker=self.docker,
                          expected_runtime_digest=self.runtime_digest, replacements=observed,
                          replacement_verifier=replacement_verifier)
        except RetainedResourcesError:
            return False

    def create(self, service):
        self.events.append(('create', service))
        cid = self.authorized[service]
        self.observed[service] = cid
        self.docker.records[cid] = {'Id': cid, 'State': {'Running': False},
                                    'Mounts': copy.deepcopy(self.evidence['containers'][service]['mounts']),
                                    'NetworkSettings': {'Networks': {}}}
        if service == 'db':
            self.docker.attachments.append(cid)
        if self.mutation:
            self.mutation()
        if self.lost:
            self.lost = False
            raise RuntimeError('synthetic lost reply after effect')

    def run_reconcile(self, expected=('db',)):
        return reconcile(expected, inspect=self.inspect, create=self.create,
                         verify_resources=self.resources, verify_container=self.independently_verify,
                         fence=lambda: True)

    def test_missing_service_and_lost_reply_discovery(self):
        for lost in (False, True):
            with self.subTest(lost=lost):
                self.setUp()
                self.lost = lost
                self.assertEqual(self.run_reconcile(), {'db': '3' * 64})
                self.assertEqual([e for e in self.events if e[0] == 'create'], [('create', 'db')])
                create = self.events.index(('create', 'db'))
                inspect = next(i for i, e in enumerate(self.events) if i > create and e[0] == 'inspect')
                verified = next(i for i, e in enumerate(self.events) if i > inspect and e[0] == 'verify')
                checked = next(i for i, e in enumerate(self.events) if i > verified and e[0] == 'resources')
                self.assertLess(create, inspect)
                self.assertLess(verified, checked)
                self.assertEqual(self.events[checked][1], {'db': '3' * 64})

    def test_changed_resources_block_next_create(self):
        for resource, field, value in [('volume', 'CreatedAt', 'changed'), ('network', 'Id', 'e' * 64)]:
            with self.subTest(resource=resource):
                self.setUp()
                self.mutation = lambda: getattr(self.docker, resource).__setitem__(field, value)
                with self.assertRaisesRegex(ReconcileError, 'resource check failed'):
                    self.run_reconcile(('db', 'app'))
                self.assertEqual([e for e in self.events if e[0] == 'create'], [('create', 'db')])

    def test_unknown_attachment_blocks_create(self):
        for resource in ('volume', 'network'):
            with self.subTest(resource=resource):
                self.setUp()
                if resource == 'volume':
                    self.docker.attachments.append('e' * 64)
                else:
                    self.docker.network['Containers']['e' * 64] = {}
                with self.assertRaisesRegex(ReconcileError, 'resource check failed'):
                    self.run_reconcile()
                self.assertFalse(any(e[0] == 'create' for e in self.events))

    def test_unverified_replacement_fails_before_next_create(self):
        self.lost = True
        self.mutation = lambda: self.authorized.__setitem__('db', 'f' * 64)
        with self.assertRaisesRegex(ReconcileError, 'container check failed'):
            self.run_reconcile(('db', 'app'))
        self.assertEqual([e for e in self.events if e[0] == 'create'], [('create', 'db')])

    def test_networked_created_container_without_endpoint_fails_closed(self):
        # No claim is made about what real Docker reports before start.
        with self.assertRaisesRegex(ReconcileError, 'resource check failed'):
            self.run_reconcile(('app',))
        self.assertEqual([e for e in self.events if e[0] == 'create'], [('create', 'app')])


if __name__ == '__main__':
    unittest.main()
