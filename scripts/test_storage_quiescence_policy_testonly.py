"""Synthetic policy tests only; no external services or physical fence."""
import copy
import unittest

import storage_quiescence_policy_testonly as policy


def page(entries):
    return {'authenticated': True, 'fence': 'token', 'cursor': None,
            'next_cursor': None, 'entries': entries}


def inputs():
    return {
        'counts': {'storage_reserved': 0, 'storage_writing': 0,
                   'storage_ready': 0, 'storage_live': 1, 'uploads': 0,
                   'uploads_retiring': 0, 'completion_claims': 0,
                   'transfers_uploading': 0, 'transfers_complete': 2,
                   'transfers_expired': 3},
        'counts_fence': 'token',
        'database_pages': [page([{'object_key': 'key', 'state': 'live', 'size_bytes': 4}])],
        'object_pages': [page([{'key': 'key', 'size': 4}])],
        'fence_before': 'token', 'fence_after': 'token',
    }


class PolicyTests(unittest.TestCase):
    def reject(self, data):
        with self.assertRaises(policy.PolicyError) as error:
            policy.check(**data)
        self.assertEqual(str(error.exception), 'storage quiescence policy rejected')

    def test_valid_and_empty(self):
        data = inputs()
        self.assertIsNone(policy.check(**data))
        data['counts']['storage_live'] = 0
        data['database_pages'] = [page([])]
        data['object_pages'] = [page([])]
        self.assertIsNone(policy.check(**data))

    def test_every_non_quiescent_count(self):
        for name in policy._ZERO_FIELDS:
            with self.subTest(name=name):
                data = inputs()
                data['counts'][name] = 1
                self.reject(data)

    def test_exact_and_valid_counts(self):
        for name in policy._COUNT_FIELDS:
            with self.subTest(name=name):
                data = inputs()
                del data['counts'][name]
                self.reject(data)
                for value in (-1, True, None, 0.0, '0'):
                    data = inputs()
                    data['counts'][name] = value
                    self.reject(data)
        data = inputs()
        data['counts']['unexpected'] = 0
        self.reject(data)
        for value in (None, [], 'counts'):
            data = inputs()
            data['counts'] = value
            self.reject(data)

    def test_live_count_must_match(self):
        for count in (0, 2):
            data = inputs()
            data['counts']['storage_live'] = count
            self.reject(data)

    def test_fence_at_each_point(self):
        for field in ('counts_fence', 'fence_before', 'fence_after'):
            for value in ('changed', '', None, True):
                data = inputs()
                data[field] = value
                self.reject(data)
        for field in ('database_pages', 'object_pages'):
            data = inputs()
            data[field][0]['fence'] = 'changed'
            self.reject(data)

    def test_independent_authentication_and_complete_pages(self):
        for field in ('database_pages', 'object_pages'):
            for mutation in ('unauthenticated', 'missing', 'unfinished'):
                with self.subTest(field=field, mutation=mutation):
                    data = inputs()
                    if mutation == 'unauthenticated':
                        data[field][0]['authenticated'] = False
                    elif mutation == 'missing':
                        data[field] = []
                    else:
                        data[field][0]['next_cursor'] = 'next'
                    self.reject(data)

    def test_inventory_reconciliation_is_required(self):
        for field, entry in (('database_pages', {'object_key': 'key', 'state': 'ready', 'size_bytes': 4}),
                             ('object_pages', {'key': 'other', 'size': 4}),
                             ('object_pages', {'key': 'key', 'size': 5})):
            data = inputs()
            data[field][0]['entries'] = [copy.deepcopy(entry)]
            self.reject(data)


if __name__ == '__main__':
    unittest.main()
