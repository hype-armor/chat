"""Focused tests for the synthetic model; no real build or deployment occurs."""
import copy
import unittest

import build_provenance_model_testonly as model


class ProvenanceTests(unittest.TestCase):
    def setUp(self):
        self.authority_key = b'independent authority fixture'
        self.producer_key = b'producer fixture'
        self.approved = {
            'operation': 'operation-1', 'generation': 'generation-1',
            'commit': 'a' * 40, 'snapshot': 'b' * 64,
            'services': {s: {'dockerfile': s + '/Dockerfile', 'platform': 'linux/amd64',
                             'inputs': {'context': 'snapshot', 'arg': s}}
                         for s in sorted(model.SERVICES)},
        }
        self.authority = model.envelope(self.authority_key, self.approved)
        self.ledger = model.FixtureLedger()
        self.ledger.register('operation-1', 'generation-1')
        self.runner = model.FakeRunner(self.producer_key)
        self.evidence = [self.runner.build(self.approved, s, ['sha256:' + str(i) * 64])
                         for i, s in enumerate(sorted(model.SERVICES), 1)]
        self.plan = [{k: item['payload'][k] for k in ('service', 'image_id', 'tag')}
                     for item in self.evidence]

    def verify(self):
        return model.verify(self.authority, self.evidence, self.plan, self.runner.lookup,
                            self.authority_key, self.producer_key, 'operation-1',
                            'generation-1', self.ledger)

    def test_valid_fixture(self):
        result = self.verify()
        self.assertEqual(result, tuple(sorted((p['service'], p['image_id']) for p in self.plan)))
        self.runner.tags.clear()
        self.assertEqual(result, tuple(sorted((p['service'], p['image_id']) for p in self.plan)))
        with self.assertRaises(model.Rejected):
            self.verify()

    def test_authority_is_independent_and_operation_bound(self):
        for key, value in [('operation', 'other'), ('generation', 'other'), ('commit', 'bad'), ('snapshot', 'bad')]:
            with self.subTest(key=key):
                original = copy.deepcopy(self.approved)
                self.approved[key] = value
                self.authority = model.envelope(self.authority_key, self.approved)
                with self.assertRaises(model.Rejected):
                    self.verify()
                self.approved = original
        self.authority = model.envelope(self.producer_key, self.approved)
        with self.assertRaises(model.Rejected):
            self.verify()
        with self.assertRaises(model.Rejected):
            model.verify(self.authority, self.evidence, self.plan, self.runner.lookup,
                         self.producer_key, self.producer_key, 'operation-1',
                         'generation-1', self.ledger)

    def test_service_set_must_be_exact(self):
        for mutation in ('missing', 'extra'):
            with self.subTest(mutation=mutation):
                approved = copy.deepcopy(self.approved)
                if mutation == 'missing':
                    approved['services'].pop('server')
                else:
                    approved['services']['extra'] = approved['services']['server']
                self.authority = model.envelope(self.authority_key, approved)
                with self.assertRaises(model.Rejected):
                    self.verify()

    def test_evidence_mismatch_and_untrusted(self):
        for field, value in [('operation', 'other'), ('generation', 'other'), ('commit', 'c' * 40),
                             ('snapshot', 'c' * 64), ('dockerfile', 'other'),
                             ('platform', 'linux/arm64'), ('inputs', {'arg': 'wrong'}),
                             ('image_id', 'sha256:abcd'), ('tag', '')]:
            with self.subTest(field=field):
                old = self.evidence[0]
                payload = copy.deepcopy(old['payload'])
                payload[field] = value
                self.evidence[0] = model.envelope(self.producer_key, payload)
                with self.assertRaises(model.Rejected):
                    self.verify()
                self.evidence[0] = old
        self.evidence[0]['signature'] = '0' * 64
        with self.assertRaises(model.Rejected):
            self.verify()

    def test_missing_extra_duplicate_and_malformed_evidence(self):
        original = self.evidence[:]
        for evidence in (original[:-1], original + [original[0]],
                         [original[0], original[0], *original[2:]],
                         [None, *original[1:]]):
            self.evidence = evidence
            with self.assertRaises(model.Rejected):
                self.verify()

    def test_plan_mapping_and_tag_drift(self):
        original = copy.deepcopy(self.plan)
        variants = [original[:-1], original + [original[0]],
                    [original[0], original[0], *original[2:]],
                    [dict(original[0], image_id=original[1]['image_id']), *original[1:]],
                    [dict(original[0], tag='other'), *original[1:]],
                    [dict(original[0], extra=True), *original[1:]]]
        for plan in variants:
            with self.subTest(plan=plan):
                self.plan = plan
                with self.assertRaises(model.Rejected):
                    self.verify()
        self.plan = original
        tag = original[0]['tag']
        for result in ([], ['sha256:' + 'f' * 64], [original[0]['image_id']] * 2):
            self.runner.tags[tag] = result
            with self.assertRaises(model.Rejected):
                self.verify()

    def test_ledger_freshness_and_ambiguous_consumption(self):
        for pair in [('operation-1', 'generation-2'), ('operation-2', 'generation-1')]:
            with self.assertRaises(model.Rejected):
                self.ledger.register(*pair)
        self.ledger = model.FixtureLedger()
        with self.assertRaises(model.Rejected):
            self.verify()
        for result in (None, 1, [], 'yes'):
            class AmbiguousLedger:
                def consume(self, operation, generation):
                    return result
            self.ledger = AmbiguousLedger()
            with self.assertRaises(model.Rejected):
                self.verify()
        class FailedLedger:
            def consume(self, operation, generation):
                raise RuntimeError('unknown outcome')
        self.ledger = FailedLedger()
        with self.assertRaises(model.Rejected):
            self.verify()

    def test_failed_validation_does_not_consume(self):
        original = self.plan
        self.plan = []
        with self.assertRaises(model.Rejected):
            self.verify()
        self.plan = original
        self.assertTrue(self.verify())
        with self.assertRaises(model.Rejected):
            self.verify()

    def test_ambiguous_build_replies(self):
        full = 'sha256:' + 'f' * 64
        for replies in ([], [full, full], ['sha256:abcd'], ['fixture/server:test'], None):
            with self.subTest(replies=replies), self.assertRaises(model.Rejected):
                self.runner.build(self.approved, 'server', replies)


if __name__ == '__main__':
    unittest.main()
