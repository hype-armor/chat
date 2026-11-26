import copy
import json
import subprocess
import tempfile
import unittest
from pathlib import Path

from username_migration_compose_runtime import ComposeRuntime
from username_migration_compose_resources_testonly import FakeDocker, InventoryError, capture, verify, operational

CID = 'a' * 64
IMAGE = 'sha256:' + 'b' * 64
NID = 'c' * 64
OP = '12345678-1234-4234-8234-123456789abc'


class Fake(FakeDocker):
    def __init__(self):
        self.tags = {}
        self.config = {'name': 'chat', 'services': {'server': {'volumes': [{'type': 'volume', 'source': 'data', 'target': '/data'}], 'networks': {'default': None}, 'ports': [{'target': 80, 'published': '8080', 'protocol': 'tcp', 'host_ip': '0.0.0.0'}]}}, 'volumes': {'data': {'name': 'chat_data'}}, 'networks': {'default': {'name': 'chat_default'}}}
        self.container = {'Id': CID, 'Image': IMAGE, 'Config': {'Labels': {'com.docker.compose.project': 'chat', 'com.docker.compose.service': 'server', 'com.docker.compose.config-hash': 'd' * 64, 'com.docker.compose.container-number': '1'}}, 'Mounts': [{'Type': 'volume', 'Name': 'chat_data', 'Destination': '/data', 'RW': True, 'Driver': 'local', 'Source': '/var/lib/docker/volumes/chat_data/_data'}], 'HostConfig': {'PortBindings': {'80/tcp': [{'HostIp': '0.0.0.0', 'HostPort': '8080'}]}}, 'NetworkSettings': {'Networks': {'chat_default': {'NetworkID': NID, 'IPAddress': '172.29.0.10'}}, 'Ports': {'80/tcp': [{'HostIp': '0.0.0.0', 'HostPort': '8080'}]}}}
        self.volume = {'Name': 'chat_data', 'Driver': 'local', 'Options': None, 'Mountpoint': '/var/lib/docker/volumes/chat_data/_data', 'CreatedAt': '2026-01-01T00:00:00Z', 'Labels': {'com.docker.compose.project': 'chat', 'com.docker.compose.volume': 'data'}}
        self.network = {'Name': 'chat_default', 'Id': NID, 'Driver': 'bridge', 'Options': {}, 'Labels': {'com.docker.compose.project': 'chat', 'com.docker.compose.network': 'default'}, 'Containers': {CID: {'Name': 'chat-server', 'IPv4Address': '172.29.0.10/24'}}, 'IPAM': {'Driver': 'default', 'Options': None, 'Config': [{'Subnet': '172.29.0.0/24', 'Gateway': '172.29.0.1'}]}}
        self.extra = False
        self.second = None

    def run(self, args, **kwargs):
        cmd = args[3:]
        out, rc = '', 0
        if cmd[0] == 'compose' and 'config' in cmd and '--hash' in cmd:
            out = '\n'.join(name + ' ' + 'd' * 64 for name in self.config['services'])
        elif cmd[0] == 'compose' and 'config' in cmd:
            path = cmd[cmd.index('-f') + 1]
            out = Path(path).read_text() if path.endswith('/config.json') else json.dumps(self.config)
        elif cmd[0] == 'compose' and 'ps' in cmd:
            out = CID + (' ' + self.second['Id'] if self.second else '')
        elif cmd[:2] == ['container', 'ls']:
            out = CID + (' ' + self.second['Id'] if self.second else '') + (' ' + 'f' * 64 if self.extra else '')
        elif cmd[0] == 'inspect':
            out = json.dumps([self.container] + ([self.second] if self.second else []))
        elif cmd[:2] == ['volume', 'inspect']:
            out = json.dumps([self.volume])
        elif cmd[:2] == ['network', 'inspect']:
            out = json.dumps([self.network])
        elif cmd[:2] == ['image', 'ls']:
            out = '\n'.join(self.tags)
        elif cmd[:2] == ['image', 'tag']:
            self.tags[cmd[3]] = cmd[2]
        elif cmd[:2] == ['image', 'inspect']:
            out = IMAGE if cmd[-1] == IMAGE else self.tags.get(cmd[-1], '')
            rc = int(not out)
        else:
            raise AssertionError(cmd)
        return subprocess.CompletedProcess(args, rc, out, '')


class Tests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.env = self.root / 'env'
        self.env.write_text('X=synthetic\n')
        self.env.chmod(0o600)
        self.fake = Fake()
        runtime = ComposeRuntime(str(self.root), str(self.env), str(self.root / 'compose.yml'), self.fake.run)
        self.evidence = self.root / 'snapshot'
        self.anchor = runtime.capture(OP, [], str(self.evidence))
        self.path = self.root / 'resources.json'

    def capture(self):
        return capture(evidence_dir=self.evidence, trusted_digest=self.anchor, fake_docker=self.fake, output_path=self.path)

    def verify(self, digest):
        return verify(evidence_dir=self.evidence, trusted_digest=self.anchor, fake_docker=self.fake, inventory_path=self.path, inventory_digest=digest)

    def test_roundtrip_and_private_digest(self):
        self.assertFalse(operational)
        digest = self.capture()
        self.assertEqual(self.path.stat().st_mode & 0o777, 0o600)
        self.assertTrue(self.verify(digest))
        self.fake.volume['CreatedAt'] = 'changed'
        with self.assertRaises(InventoryError):
            self.verify(digest)

    def test_discrepancies_rejected(self):
        for target, change in [('mount', lambda f: f.container['Mounts'][0].update(Name='other')), ('network', lambda f: f.network.update(Id='e' * 64)), ('ports', lambda f: f.container['NetworkSettings']['Ports']['80/tcp'][0].update(HostPort='8081')), ('labels', lambda f: f.container['Config']['Labels'].update({'com.docker.compose.service': 'other'})), ('volume', lambda f: f.volume.update(Driver='other')), ('unknown', lambda f: f.network['Containers'].update({'e' * 64: {}})), ('project', lambda f: setattr(f, 'extra', True))]:
            with self.subTest(target=target):
                saved = copy.deepcopy(self.fake)
                change(self.fake)
                with self.assertRaises(InventoryError):
                    self.capture()
                self.fake = saved

    def test_read_only_bind_and_localhost_port(self):
        source = self.root / 'api-proxy.conf'
        source.write_text('synthetic config')
        self.fake.config['services']['web'] = self.fake.config['services'].pop('server')
        spec = self.fake.config['services']['web']
        spec['volumes'].append({'type': 'bind', 'source': str(source),
                                'target': '/etc/nginx/conf.d/extra/api-proxy.conf', 'read_only': True})
        spec['ports'][0]['host_ip'] = '127.0.0.1'
        self.fake.container['Config']['Labels']['com.docker.compose.service'] = 'web'
        self.fake.container['Mounts'].append({'Type': 'bind', 'Source': str(source),
                                              'Destination': '/etc/nginx/conf.d/extra/api-proxy.conf', 'RW': False})
        for port_set in (self.fake.container['HostConfig']['PortBindings'], self.fake.container['NetworkSettings']['Ports']):
            port_set['80/tcp'][0]['HostIp'] = '127.0.0.1'
        runtime = ComposeRuntime(str(self.root), str(self.env), str(self.root / 'compose.yml'), self.fake.run)
        self.evidence = self.root / 'bind-snapshot'
        self.anchor = runtime.capture(OP, [], str(self.evidence))
        digest = self.capture()
        self.assertTrue(self.verify(digest))
        original = copy.deepcopy(self.fake.container['Mounts'])
        for change in ('source', 'target', 'rw', 'missing', 'extra'):
            with self.subTest(change=change):
                self.fake.container['Mounts'] = copy.deepcopy(original)
                mount = self.fake.container['Mounts'][-1]
                if change == 'source': mount['Source'] = str(self.root / 'other')
                if change == 'target': mount['Destination'] = '/other'
                if change == 'rw': mount['RW'] = True
                if change == 'missing': self.fake.container['Mounts'].pop()
                if change == 'extra': self.fake.container['Mounts'].append(dict(mount, Destination='/extra'))
                with self.assertRaises(InventoryError): self.verify(digest)
        self.fake.container['Mounts'] = original
        source.rename(self.root / 'old-source')
        source.write_text('synthetic config')
        with self.assertRaises(InventoryError): self.verify(digest)

    def test_nonlocal_published_address_rejected(self):
        self.fake.config['services']['server']['ports'][0]['host_ip'] = '192.0.2.1'
        for port_set in (self.fake.container['HostConfig']['PortBindings'], self.fake.container['NetworkSettings']['Ports']):
            port_set['80/tcp'][0]['HostIp'] = '192.0.2.1'
        runtime = ComposeRuntime(str(self.root), str(self.env), str(self.root / 'compose.yml'), self.fake.run)
        self.evidence = self.root / 'nonlocal-snapshot'
        self.anchor = runtime.capture(OP, [], str(self.evidence))
        with self.assertRaises(InventoryError): self.capture()

    def static_network(self):
        self.fake.config['networks']['default']['ipam'] = {'config': [{'subnet': '172.29.0.0/24', 'gateway': '172.29.0.1'}]}
        self.fake.config['services']['server']['networks']['default'] = {'ipv4_address': '172.29.0.10'}
        self.fake.container['NetworkSettings']['Networks']['chat_default']['IPAddress'] = '172.29.0.10'
        self.fake.network['IPAM'] = {'Driver': 'default', 'Options': None, 'Config': [{'Subnet': '172.29.0.0/24', 'Gateway': '172.29.0.1'}]}
        self.fake.network['Containers'][CID]['IPv4Address'] = '172.29.0.10/24'
        runtime = ComposeRuntime(str(self.root), str(self.env), str(self.root / 'compose.yml'), self.fake.run)
        self.evidence = self.root / 'static-snapshot'
        self.anchor = runtime.capture(OP, [], str(self.evidence))

    def test_implicit_ipam_rejects_malformed_and_inconsistent_inspections(self):
        changes = [
            lambda f: f.network['IPAM'].update(Driver='other'),
            lambda f: f.network['IPAM'].update(Options={'foo': 'bar'}),
            lambda f: f.network['IPAM'].update(Config=[]),
            lambda f: f.network['IPAM']['Config'].append({'Subnet': '172.30.0.0/24', 'Gateway': '172.30.0.1'}),
            lambda f: f.network['IPAM']['Config'][0].update(Subnet='invalid'),
            lambda f: f.network['IPAM']['Config'][0].update(Subnet='2001:db8::/64', Gateway='2001:db8::1'),
            lambda f: f.network['IPAM']['Config'][0].update(Gateway='172.30.0.1'),
            lambda f: f.container['NetworkSettings']['Networks']['chat_default'].update(IPAddress='172.30.0.10'),
            lambda f: f.container['NetworkSettings']['Networks']['chat_default'].update(IPAddress='172.29.0.1'),
            lambda f: f.network['Containers'][CID].update(IPv4Address='172.29.0.11/24'),
            lambda f: f.network['Containers'][CID].update(IPv4Address='172.29.0.10/25'),
        ]
        original = copy.deepcopy(self.fake)
        for index, change in enumerate(changes):
            self.fake = copy.deepcopy(original)
            change(self.fake)
            with self.subTest(index=index), self.assertRaises(InventoryError):
                self.capture()

    def test_implicit_duplicate_addresses_rejected(self):
        self.fake.config['services']['other'] = copy.deepcopy(self.fake.config['services']['server'])
        self.fake.second = copy.deepcopy(self.fake.container)
        self.fake.second['Id'] = 'e' * 64
        self.fake.second['Config']['Labels']['com.docker.compose.service'] = 'other'
        self.fake.network['Containers'][self.fake.second['Id']] = {'IPv4Address': '172.29.0.10/24'}
        runtime = ComposeRuntime(str(self.root), str(self.env), str(self.root / 'compose.yml'), self.fake.run)
        self.evidence = self.root / 'implicit-duplicate'
        self.anchor = runtime.capture(OP, [], str(self.evidence))
        with self.assertRaises(InventoryError):
            self.capture()

    def test_implicit_ipam_changes_between_capture_inspections(self):
        original_run = self.fake.run
        calls = []
        def changing_run(args, **kwargs):
            if args[3:5] == ['network', 'inspect']:
                calls.append(1)
                if len(calls) == 2:
                    self.fake.network['IPAM']['Config'][0].update(Subnet='172.30.0.0/24', Gateway='172.30.0.1')
                    self.fake.network['Containers'][CID]['IPv4Address'] = '172.30.0.10/24'
            if args[3] == 'inspect' and calls:
                self.fake.container['NetworkSettings']['Networks']['chat_default']['IPAddress'] = '172.30.0.10'
            return original_run(args, **kwargs)
        self.fake.run = changing_run
        with self.assertRaises(InventoryError):
            self.capture()
        self.assertEqual(len(calls), 2)

    def test_implicit_ipam_valid_identity_drift_rejected(self):
        digest = self.capture()
        self.fake.network['IPAM']['Config'][0].update(Subnet='172.30.0.0/24', Gateway='172.30.0.1')
        self.fake.container['NetworkSettings']['Networks']['chat_default']['IPAddress'] = '172.30.0.10'
        self.fake.network['Containers'][CID]['IPv4Address'] = '172.30.0.10/24'
        with self.assertRaises(InventoryError):
            self.verify(digest)

    def test_static_ipv4_and_drift(self):
        self.static_network()
        digest = self.capture()
        self.assertTrue(self.verify(digest))
        changes = [
            lambda f: f.network['IPAM']['Config'][0].update(Subnet='172.30.0.0/24'),
            lambda f: f.network['IPAM']['Config'][0].update(Gateway='172.29.0.2'),
            lambda f: f.network['IPAM'].update(Driver='other'),
            lambda f: f.container['NetworkSettings']['Networks']['chat_default'].update(IPAddress='172.29.0.11'),
            lambda f: f.network['Containers'][CID].update(IPv4Address='172.29.0.11/24'),
            lambda f: f.network['Containers'].update({'e' * 64: {'IPv4Address': '172.29.0.10/24'}}),
            lambda f: f.network.update(Driver='overlay'),
        ]
        original = copy.deepcopy(self.fake)
        for change in changes:
            self.fake = copy.deepcopy(original)
            change(self.fake)
            with self.subTest(change=change), self.assertRaises(InventoryError):
                self.verify(digest)

    def test_duplicate_static_addresses_rejected(self):
        self.static_network()
        self.fake.config['services']['other'] = copy.deepcopy(self.fake.config['services']['server'])
        self.fake.second = copy.deepcopy(self.fake.container)
        second_id = 'e' * 64
        self.fake.second['Id'] = second_id
        self.fake.second['Config']['Labels']['com.docker.compose.service'] = 'other'
        self.fake.network['Containers'][second_id] = {'IPv4Address': '172.29.0.10/24'}
        runtime = ComposeRuntime(str(self.root), str(self.env), str(self.root / 'compose.yml'), self.fake.run)
        self.evidence = self.root / 'duplicate-snapshot'
        self.anchor = runtime.capture(OP, [], str(self.evidence))
        with self.assertRaises(InventoryError):
            self.capture()

    def test_static_invalid_config_rejected(self):
        changes = [
            lambda f: f.config['networks']['default'].update(external=True),
            lambda f: f.config['networks']['default'].update(driver='overlay'),
            lambda f: f.config['networks']['default']['ipam']['config'][0].update(subnet='172.30.0.0/24'),
            lambda f: f.config['services']['server']['networks']['default'].update(ipv4_address='172.30.0.10'),
            lambda f: f.config['networks']['default']['ipam']['config'][0].update(ip_range='172.29.0.0/25'),
        ]
        for index, change in enumerate(changes):
            self.fake = Fake()
            self.static_network()
            change(self.fake)
            runtime = ComposeRuntime(str(self.root), str(self.env), str(self.root / 'compose.yml'), self.fake.run)
            self.evidence = self.root / ('invalid-' + str(index))
            self.anchor = runtime.capture(OP, [], str(self.evidence))
            with self.subTest(index=index), self.assertRaises(InventoryError):
                self.capture()
            # The next synthetic snapshot needs a fresh path.
            import shutil
            shutil.rmtree(self.root / 'static-snapshot')

    def test_tamper_and_anchor(self):
        digest = self.capture()
        self.path.write_text('{}')
        with self.assertRaises(InventoryError):
            self.verify(digest)
        with self.assertRaises(InventoryError):
            capture(evidence_dir=self.evidence, trusted_digest='0' * 64, fake_docker=self.fake, output_path=self.root / 'other')

    def test_fake_required_and_no_overwrite(self):
        self.capture()
        with self.assertRaises(InventoryError):
            self.capture()
        with self.assertRaises(InventoryError):
            capture(evidence_dir=self.evidence, trusted_digest=self.anchor, fake_docker=object(), output_path=self.root / 'other')


if __name__ == '__main__':
    unittest.main()
