import copy
import unittest

from username_migration_private_plan import PlanError, private_plan

OP = '12345678-1234-4234-8234-123456789abc'
IMAGE = 'sha256:' + 'a' * 64


def config():
    return {'name': 'chat', 'services': {
        'server': {'image': IMAGE, 'ports': [{'target': 8080, 'published': '8080'}],
                   'networks': {'default': {}}, 'restart': 'always'},
        'postgres': {'image': IMAGE, 'volumes': [{'type': 'volume', 'source': 'postgres', 'target': '/data'}]},
        'https': {'image': IMAGE, 'ports': [{'target': 443, 'published': '8443'}],
                  'volumes': [{'type': 'bind', 'source': '/snap/bind_0', 'target': '/etc/caddy/Caddyfile', 'read_only': True}]},
    }, 'networks': {'default': {'name': 'chat_default'}},
        'volumes': {'postgres': {'name': 'chat_postgres'}}}


RECORDS = [{'service': 'https', 'index': 0, 'snapshot': '/snap/bind_0', 'content': {}}]


class PrivatePlanTests(unittest.TestCase):
    def test_private_and_no_mutation(self):
        source = config()
        before = copy.deepcopy(source)
        result = private_plan(source, OP, RECORDS)
        self.assertEqual(source, before)
        self.assertEqual(result['volumes'], before['volumes'])
        self.assertEqual(result['services']['postgres']['volumes'], before['services']['postgres']['volumes'])
        self.assertEqual(result['services']['https']['volumes'][0]['source'], '/snap/bind_0')
        self.assertEqual(result['services']['https']['volumes'][0]['bind'], {'create_host_path': False})
        for spec in result['services'].values():
            self.assertNotIn('ports', spec)
            self.assertEqual(spec['restart'], 'no')
        self.assertEqual(result['networks']['default'], {'name': 'chat-private-' + OP + '-default', 'driver': 'bridge', 'internal': True})
        self.assertNotEqual(private_plan(source, '22345678-1234-4234-8234-123456789abc', RECORDS)['networks'], result['networks'])

    def test_https_static_network_is_replaced_by_private_dns_network(self):
        source = config()
        source['networks']['https-proxy'] = {'name': 'chat_https-proxy',
            'ipam': {'config': [{'subnet': '172.30.0.0/29'}]}}
        source['services']['https']['networks'] = {'https-proxy': {'ipv4_address': '172.30.0.3'}}
        result = private_plan(source, OP, RECORDS)
        self.assertEqual(result['services']['https']['networks'], {'https-proxy': {}})
        self.assertTrue(result['networks']['https-proxy']['internal'])
        self.assertNotIn('ipam', result['networks']['https-proxy'])

    def test_rejections(self):
        variants = []
        def variant(service, key, value):
            value_config = config()
            value_config['services'][service][key] = value
            variants.append(value_config)
        variant('server', 'network_mode', 'host')
        variant('server', 'privileged', True)
        variant('server', 'build', {})
        variant('server', 'image', 'chat:latest')
        variant('server', 'networks', {'default': {'aliases': ['chat-server']}})
        variant('server', 'container_name', 'chat-server')
        variant('server', 'volumes', [{'type': 'bind', 'source': '/var/run/docker.sock', 'target': '/sock', 'read_only': True}])
        variant('server', 'pid', 'host')
        variant('server', 'labels', {'traefik.enable': 'true'})
        external = config(); external['networks']['default']['external'] = True; variants.append(external)
        driver = config(); driver['volumes']['postgres']['driver_opts'] = {'device': '/'}; variants.append(driver)
        for bad in variants:
            with self.subTest(bad=bad):
                with self.assertRaises(PlanError):
                    private_plan(bad, OP, RECORDS)
        with self.assertRaises(PlanError):
            private_plan(config(), OP, [])
        with self.assertRaises(PlanError):
            private_plan(config(), 'not-a-uuid', RECORDS)


if __name__ == '__main__':
    unittest.main()
