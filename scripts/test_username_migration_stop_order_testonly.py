import copy
import hashlib
import json
import unittest

from username_migration_stop_order_testonly import derive_stop_order, StopOrderError

OP = '2e19bd45-c517-4f58-a254-31d985b31efc'


class StopOrderTests(unittest.TestCase):
    def setUp(self):
        self.services = {
            'server': {'depends_on': {'postgres': {'condition': 'service_healthy', 'required': True, 'restart': False}, 'seaweedfs-init': {'condition': 'service_completed_successfully'}}},
            'seaweedfs-init': {'depends_on': ['seaweedfs']},
            'seaweedfs': {}, 'postgres': {},
            'web': {'depends_on': ['server']},
            'https': {'profiles': ['https'], 'depends_on': ['web']},
        }
        self.roles = [('server', 'writer'), ('seaweedfs-init', 'writer'), ('seaweedfs', 'storage'), ('postgres', 'storage'), ('web', 'other'), ('https', 'other')]

    def run_graph(self, services=None, roles=None, profiles=('https',), postgres='postgres', verifier=None, explicit_order=None):
        raw = json.dumps({'services': self.services if services is None else services}).encode()
        digest = hashlib.sha256(raw).hexdigest()
        def verify(operation, actual_digest, active):
            return (operation, actual_digest, active) == (OP, digest, tuple(profiles))
        return derive_stop_order(config_bytes=raw, operation=OP, profiles=profiles,
                                 classifications=self.roles if roles is None else roles,
                                 postgres=postgres, verify_evidence=verifier or verify,
                                 explicit_order=explicit_order)

    def test_synthetic_topology(self):
        self.assertEqual(self.run_graph(), ('https', 'web', 'server', 'seaweedfs-init', 'seaweedfs', 'postgres'))

    def test_without_profile(self):
        services = copy.deepcopy(self.services)
        del services['https']
        self.assertEqual(self.run_graph(services, self.roles[:-1], ()), ('web', 'server', 'seaweedfs-init', 'seaweedfs', 'postgres'))
        with self.assertRaises(StopOrderError):
            self.run_graph(profiles=())

    def test_bad_classifications(self):
        for roles in (self.roles[:-1], self.roles + [('server', 'writer')], self.roles + [('absent', 'other')], [('server', 'unknown')] + self.roles[1:], self.roles[:-3] + [('postgres', 'writer')] + self.roles[-2:]):
            with self.subTest(roles=roles), self.assertRaises(StopOrderError):
                self.run_graph(roles=roles)
        with self.assertRaises(StopOrderError):
            self.run_graph(postgres='server')

    def test_cycle_and_ambiguity(self):
        services = copy.deepcopy(self.services)
        services['postgres']['depends_on'] = ['server']
        with self.assertRaises(StopOrderError):
            self.run_graph(services)
        services = copy.deepcopy(self.services)
        services['https'].pop('depends_on')
        with self.assertRaises(StopOrderError):
            self.run_graph(services)

    def test_explicit_order_with_independent_services(self):
        services = copy.deepcopy(self.services)
        services['worker'] = {'depends_on': ['postgres']}
        services['metrics'] = {}
        roles = self.roles + [('worker', 'writer'), ('metrics', 'other')]
        order = ('https', 'metrics', 'web', 'worker', 'server',
                 'seaweedfs-init', 'seaweedfs', 'postgres')
        with self.assertRaises(StopOrderError):
            self.run_graph(services, roles)
        self.assertEqual(self.run_graph(services, roles, explicit_order=order), order)
        invalid_orders = [
            order[:-1], order + ('worker',),
            order[:-1] + ('worker',),
            ('web', 'https') + order[2:],  # declared dependency
            ('https', 'metrics', 'web', 'server', 'seaweedfs-init',
             'seaweedfs', 'worker', 'postgres'),  # writer before storage
            order[:-2] + ('postgres', 'seaweedfs'),
            'not a service list',
        ]
        for invalid in invalid_orders:
            with self.subTest(order=invalid), self.assertRaises(StopOrderError):
                self.run_graph(services, roles, explicit_order=invalid)
        services['postgres']['depends_on'] = ['server']
        with self.assertRaises(StopOrderError):
            self.run_graph(services, roles, explicit_order=order)

    def test_bad_dependencies(self):
        for dep in (['missing'], ['web', 'web'], None, {'web': {'condition': 'unknown'}}, {'web': {'required': 'false'}}, {'web': {'extra': True}}):
            services = copy.deepcopy(self.services)
            services['https']['depends_on'] = dep
            with self.subTest(dep=dep), self.assertRaises(StopOrderError):
                self.run_graph(services)

    def test_evidence_and_profiles(self):
        with self.assertRaises(StopOrderError):
            self.run_graph(verifier=lambda *args: False)
        with self.assertRaises(StopOrderError):
            self.run_graph(profiles=('https', 'https'))
        with self.assertRaises(StopOrderError):
            derive_stop_order(config_bytes=b'{"services":{},"services":{}}', operation=OP, profiles=(), classifications=[], postgres='postgres', verify_evidence=lambda *args: True)


if __name__ == '__main__':
    unittest.main()
