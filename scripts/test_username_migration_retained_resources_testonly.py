import copy
import json
import os
import tempfile
import unittest
from types import SimpleNamespace

from username_migration_compose_resources_testonly import FakeDocker, _canonical
from username_migration_compose_runtime import _digest
from username_migration_retained_resources_testonly import verify, RetainedResourcesError


class Docker(FakeDocker):
    def __init__(self, volume, network):
        self.volume, self.network = copy.deepcopy(volume), copy.deepcopy(network)
        self.network['Containers'] = {}
        self.attachments = []
        self.calls = []
        self.records = {}

    def run(self, args, **kwargs):
        command = args[3:]
        self.calls.append(command)
        if command[:1] == ['inspect']:
            result = self.records[command[1]]
        elif command[:2] == ['volume', 'inspect']:
            result = self.volume
        elif command[:2] == ['network', 'inspect']:
            result = self.network
        elif command[:2] == ['container', 'ls']:
            return SimpleNamespace(returncode=0, stdout='\n'.join(self.attachments))
        else:
            raise AssertionError(command)
        return SimpleNamespace(returncode=0, stdout=json.dumps(result if isinstance(result, list) else [result]))


class RetainedTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.path = os.path.join(self.tmp.name, 'inventory')
        self.op = '00000000-0000-4000-8000-000000000001'
        self.cid, self.nid = 'a' * 64, 'b' * 64
        self.volume = {'Name': 'p_data', 'Driver': 'local', 'Options': None, 'Mountpoint': '/vol', 'CreatedAt': 'time', 'Labels': {'com.docker.compose.project': 'p', 'com.docker.compose.volume': 'data'}}
        self.network = {'Name': 'p_net', 'Id': self.nid, 'Driver': 'bridge', 'Options': {}, 'Labels': {'com.docker.compose.project': 'p', 'com.docker.compose.network': 'net'}, 'Containers': {self.cid: {'IPv4Address': '172.20.0.2/16'}}, 'IPAM': {'Driver': 'default', 'Config': [{'Subnet': '172.20.0.0/16', 'Gateway': '172.20.0.1'}]}}
        self.evidence = {'version': 1, 'operation': self.op, 'runtime_digest': 'c' * 64, 'containers': {'app': {'id': self.cid, 'labels': {'com.docker.compose.project': 'p', 'com.docker.compose.service': 'app'}, 'mounts': [{'Type': 'volume', 'Name': 'p_data', 'Source': '/vol'}], 'networks': {'p_net': {'id': self.nid}}}}, 'volumes': {'p_data': self.volume}, 'networks': {'p_net': self.network}}
        self.docker = Docker(self.volume, self.network)
        self.save()

    def save(self):
        data = _canonical(self.evidence)
        with open(self.path, 'wb') as f:
            f.write(data)
        os.chmod(self.path, 0o600)
        self.digest = _digest(data)

    def check(self, **kwargs):
        args = dict(inventory_path=self.path, inventory_digest=self.digest, operation=self.op, project='p', fake_docker=self.docker)
        args.update(kwargs)
        return verify(**args)

    def test_original_containers_absent(self):
        self.assertTrue(self.check())
        self.assertTrue(all(c[:2] in (['volume', 'inspect'], ['network', 'inspect'], ['container', 'ls']) for c in self.docker.calls))

    def test_runtime_evidence_binding(self):
        self.assertTrue(self.check(expected_runtime_digest='c' * 64))
        for digest in ('d' * 64, '', 'C' * 64, 42):
            with self.subTest(digest=digest), self.assertRaises(RetainedResourcesError):
                self.check(expected_runtime_digest=digest)

    def test_replacement_and_drift(self):
        for resource, field, value in [('volume', 'CreatedAt', 'new'), ('volume', 'Mountpoint', '/new'), ('network', 'Id', 'd' * 64), ('network', 'IPAM', {})]:
            with self.subTest(resource=resource, field=field):
                docker = Docker(self.volume, self.network)
                getattr(docker, resource)[field] = value
                with self.assertRaises(RetainedResourcesError):
                    self.check(fake_docker=docker)

    def test_missing_ambiguous_and_unknown(self):
        for resource, value in [('volume', []), ('network', []), ('volume', [self.volume, self.volume]), ('network', [self.network, self.network])]:
            with self.subTest(resource=resource, value=value):
                docker = Docker(self.volume, self.network)
                setattr(docker, resource, value)
                with self.assertRaises(RetainedResourcesError):
                    self.check(fake_docker=docker)
        self.docker.attachments = ['e' * 64]
        with self.assertRaises(RetainedResourcesError): self.check()
        self.docker.attachments = []
        self.docker.network['Containers'] = {'e' * 64: {}}
        with self.assertRaises(RetainedResourcesError): self.check()

    def prepare_replacement(self, replacement):
        endpoint_id = 'f' * 64
        self.docker.attachments = [replacement]
        self.docker.network['Containers'] = {replacement: {'IPv4Address': '172.20.0.3/16', 'EndpointID': endpoint_id}}
        self.docker.records[replacement] = {'Id': replacement, 'State': {'Running': False},
            'Mounts': copy.deepcopy(self.evidence['containers']['app']['mounts']),
            'NetworkSettings': {'Networks': {'p_net': {'NetworkID': self.nid, 'IPAddress': '172.20.0.3', 'EndpointID': endpoint_id}}}}

    def test_verified_replacement(self):
        replacement = 'd' * 64
        calls = []
        def verifier(**kwargs):
            calls.append(kwargs)
            return kwargs == {'operation': self.op, 'project': 'p', 'service': 'app', 'container_id': replacement}
        self.prepare_replacement(replacement)
        with self.assertRaises(RetainedResourcesError):
            self.check(replacements={'app': replacement}, replacement_verifier=verifier)
        with self.assertRaises(RetainedResourcesError):
            self.check(replacements={'app': replacement}, expected_runtime_digest='c' * 64)
        self.assertTrue(self.check(replacements={'app': replacement}, replacement_verifier=verifier, expected_runtime_digest='c' * 64))
        self.assertEqual(len(calls), 1)
        for callback in (lambda **kw: False, lambda **kw: 1, lambda **kw: None):
            with self.assertRaises(RetainedResourcesError):
                self.check(replacements={'app': replacement}, replacement_verifier=callback, expected_runtime_digest='c' * 64)
        self.docker.volume['CreatedAt'] = 'changed'
        with self.assertRaises(RetainedResourcesError):
            self.check(replacements={'app': replacement}, replacement_verifier=verifier, expected_runtime_digest='c' * 64)

    def test_replacement_observation_failures(self):
        replacement = 'd' * 64
        def check_bad():
            with self.assertRaises(RetainedResourcesError):
                self.check(replacements={'app': replacement}, replacement_verifier=lambda **kw: True,
                           expected_runtime_digest='c' * 64)
        for mutation in ('empty', 'subnet', 'address', 'mounts', 'network_id', 'endpoint_id',
                         'missing_network', 'extra_network', 'missing_endpoint', 'duplicate', 'running', 'missing_volume'):
            with self.subTest(mutation=mutation):
                self.prepare_replacement(replacement)
                record = self.docker.records[replacement]
                endpoint = self.docker.network['Containers'][replacement]
                observed = record['NetworkSettings']['Networks']['p_net']
                if mutation == 'empty': self.docker.network['Containers'][replacement] = {}
                elif mutation == 'subnet': endpoint['IPv4Address'] = '172.21.0.3/16'
                elif mutation == 'address': observed['IPAddress'] = '172.20.0.4'
                elif mutation == 'mounts': record['Mounts'] = []
                elif mutation == 'network_id': observed['NetworkID'] = 'e' * 64
                elif mutation == 'endpoint_id': observed['EndpointID'] = 'e' * 64
                elif mutation == 'missing_network': record['NetworkSettings']['Networks'] = {}
                elif mutation == 'extra_network': record['NetworkSettings']['Networks']['extra'] = {}
                elif mutation == 'missing_endpoint': self.docker.network['Containers'] = {}
                elif mutation == 'duplicate': self.docker.network['Containers'][self.cid] = self.network['Containers'][self.cid]
                elif mutation == 'running': record['State']['Running'] = True
                elif mutation == 'missing_volume': self.docker.attachments = []
                check_bad()

    def test_replacement_scope_and_ids(self):
        replacement = 'd' * 64
        self.evidence['containers']['other'] = {'id': 'e' * 64, 'labels': {
            'com.docker.compose.project': 'p', 'com.docker.compose.service': 'other'},
            'mounts': [], 'networks': {}}
        self.save()
        yes = lambda **kw: True
        self.docker.records[replacement] = {"Id": replacement, "State": {"Running": False}, "Mounts": [], "NetworkSettings": {"Networks": {}}}
        for mapping in ({'missing': replacement}, {'app': self.cid},
                        {'app': replacement, 'other': replacement}, {'app': 'bad'}):
            with self.subTest(mapping=mapping), self.assertRaises(RetainedResourcesError):
                self.check(replacements=mapping, replacement_verifier=yes, expected_runtime_digest='c' * 64)
        self.docker.attachments = [replacement]
        with self.assertRaises(RetainedResourcesError):
            self.check(replacements={'other': replacement}, replacement_verifier=yes, expected_runtime_digest='c' * 64)
        self.docker.attachments = []
        self.docker.network['Containers'] = {replacement: {}}
        with self.assertRaises(RetainedResourcesError):
            self.check(replacements={'other': replacement}, replacement_verifier=yes, expected_runtime_digest='c' * 64)
        self.docker.network['Containers'] = {self.cid: {'IPv4Address': 'changed'}}
        with self.assertRaises(RetainedResourcesError):
            self.check(replacements={'app': replacement}, replacement_verifier=yes, expected_runtime_digest='c' * 64)

    def test_anchor_privacy_and_schema(self):
        with self.assertRaises(RetainedResourcesError): self.check(inventory_digest='0' * 64)
        with self.assertRaises(RetainedResourcesError): self.check(project='other')
        with self.assertRaises(RetainedResourcesError): self.check(operation='00000000-0000-4000-8000-000000000002')
        os.chmod(self.path, 0o644)
        with self.assertRaises(RetainedResourcesError): self.check()
        self.evidence['version'] = 0
        self.save()
        with self.assertRaises(RetainedResourcesError): self.check()


if __name__ == '__main__':
    unittest.main()
