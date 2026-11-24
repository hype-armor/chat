import copy
import json
import subprocess
import sys
import unittest
from pathlib import Path

from username_migration_topology import diagnose


def container(name, service, **changes):
    item = {'id': name, 'project': 'chat', 'service': service, 'running': True,
            'networks': ['chat_default'], 'mounts': [], 'ports': [],
            'database_url': None, 'restart': 'no'}
    item.update(changes)
    return item


def snapshot():
    return {'project': 'chat', 'database_volume': 'chat_postgres',
            'containers': [container('s', 'server', ports=['8080/tcp'], database_url='postgres://chat:secret@postgres:5432/chat'),
                           container('p', 'postgres', mounts=['chat_postgres'])],
            'networks': {'chat_default': ['s', 'p'], 'chat_https-proxy': []},
            'systemd': {'active': False, 'enabled': False, 'restart': False},
            'tcp_connections': [],
            'privileges': {'docker_admins_fenced': False, 'host_admins_fenced': False, 'database_admins_fenced': False}}


class TopologyTests(unittest.TestCase):
    def assertFinding(self, data, fragment):
        result = diagnose(data)
        self.assertEqual(result['status'], 'unsupported')
        self.assertTrue(any(fragment in text for text in result['findings']), result)
        self.assertNotIn('secret', json.dumps(result))

    def test_direct_ingress_and_admins(self):
        self.assertFinding(snapshot(), 'direct published TCP')
        self.assertFinding(snapshot(), 'Administrative access')

    def test_external_database_options(self):
        for url in ('postgres://x@remote/chat', 'postgres://x@postgres/chat?host=remote',
                    'postgres://x@postgres:9999/chat', 'not a url'):
            with self.subTest(url=url):
                data = snapshot()
                data['containers'][0]['database_url'] = url
                self.assertFinding(data, 'External or unsupported')

    def test_competitors(self):
        data = snapshot()
        data['containers'].append(container('x', 'other', project='other', mounts=['chat_postgres']))
        data['networks']['chat_default'].append('x')
        data['systemd']['enabled'] = True
        data['tcp_connections'] = ['unidentified']
        data['containers'][0]['restart'] = 'always'
        for reason in ('shares a Compose network', 'mounts the database volume', 'pi-chat.service', 'TCP connections', 'automatic restart'):
            self.assertFinding(data, reason)

    def test_missing_and_inconsistent_evidence(self):
        data = snapshot()
        data['networks']['chat_default'].remove('s')
        self.assertFinding(data, 'membership does not match')
        del data['privileges']
        self.assertFinding(data, 'Invalid or incomplete')

    def test_never_authorizes_even_claimed_fences(self):
        data = snapshot()
        data['containers'][0]['ports'] = []
        data['privileges'] = {key: True for key in data['privileges']}
        result = diagnose(data)
        self.assertEqual(result['status'], 'unsupported')
        self.assertTrue(any('cannot fence' in s for s in result['findings']))

    def test_cli_no_docker(self):
        script = Path(__file__).with_name('username_migration_topology.py')
        result = subprocess.run([sys.executable, str(script), '--mock-snapshot', '/nonexistent'], capture_output=True, text=True, check=False)
        self.assertEqual(result.returncode, 2)
        self.assertEqual(json.loads(result.stdout)['status'], 'unsupported')

    def test_duplicate_container(self):
        data = snapshot()
        data['containers'].append(copy.deepcopy(data['containers'][0]))
        self.assertFinding(data, 'Invalid or incomplete')


if __name__ == '__main__':
    unittest.main()
