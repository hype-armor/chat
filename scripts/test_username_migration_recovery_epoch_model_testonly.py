import unittest
from dataclasses import replace

from username_migration_recovery_epoch_model_testonly import Identity, Journal, Rejected, attempt


class RecoveryEpochTests(unittest.TestCase):
    def setUp(self):
        self.identity = Identity('trusted-authority', 'filesystem', 'volume-id',
                                 'driver-and-volume-metadata', 42)
        self.journal = Journal()
        self.effects = []
        self.lease = 'lease-1'
        self.authority = lambda operation, evidence: self.identity

    def run_attempt(self, mount='mount-1', operation='op', evidence='snapshot-digest',
                    interrupt=lambda phase: None):
        attempt(self.journal, operation, evidence, mount, self.authority,
                lambda: self.lease, lambda: self.effects.append('effect'), interrupt)

    def test_reboot_with_new_mount_and_new_fence_publishes_epoch(self):
        self.run_attempt()
        self.lease = 'lease-2'
        self.run_attempt(mount='mount-2')
        self.assertEqual([r['kind'] for r in self.journal.records], ['intent', 'epoch', 'epoch'])
        self.assertEqual(self.journal.records[-1]['mount_id'], 'mount-2')
        self.assertEqual(len(self.effects), 2)

    def test_replacements_and_mismatched_operation_or_evidence_fail(self):
        self.run_attempt()
        original = self.identity
        for field, value in [('authority', 'other'), ('filesystem', 'other'),
                             ('volume', 'other'), ('volume_metadata', 'other'),
                             ('root_inode', 43)]:
            self.identity = replace(original, **{field: value})
            with self.subTest(field=field), self.assertRaises(Rejected):
                self.run_attempt(mount='mount-2')
        self.identity = original
        for kwargs in ({'operation': 'other'}, {'evidence': 'other'}):
            with self.assertRaises(Rejected):
                self.run_attempt(**kwargs)
        self.assertEqual(len(self.effects), 1)
        self.assertEqual(len(self.journal.records), 2)

    def test_ambiguous_authority_and_fence_rejected(self):
        for invalid in (None, [self.identity, self.identity], replace(self.identity, volume=''),
                        replace(self.identity, root_inode=0)):
            self.authority = lambda op, evidence, value=invalid: value
            with self.subTest(invalid=invalid), self.assertRaises(Rejected):
                self.run_attempt()
        self.authority = lambda op, evidence: self.identity
        self.lease = ''
        with self.assertRaises(Rejected):
            self.run_attempt()
        self.assertEqual(self.journal.records, [])

    def test_lost_fence_or_changed_identity_before_effect(self):
        for change in ('fence', 'identity'):
            self.setUp()
            def interrupt(phase):
                if phase == 'epoch':
                    if change == 'fence':
                        self.lease = 'replaced'
                    else:
                        self.identity = replace(self.identity, root_inode=99)
            with self.subTest(change=change), self.assertRaises(Rejected):
                self.run_attempt(interrupt=interrupt)
            self.assertEqual(self.effects, [])
            self.assertEqual(len(self.journal.records), 2)

    def test_ambiguous_append_and_fsync_block_all_retries(self):
        for failure in ('append', 'fsync'):
            self.setUp()
            def fault(phase):
                if phase == failure:
                    raise OSError('unknown outcome')
            self.journal.fault = fault
            with self.subTest(failure=failure), self.assertRaises(Rejected):
                self.run_attempt()
            self.journal.fault = lambda phase: None
            with self.assertRaises(Rejected):
                self.run_attempt(mount='mount-2')
            self.assertEqual(self.effects, [])

    def test_crash_after_each_durable_publication_retries_with_new_epoch(self):
        for crash in ('intent', 'epoch'):
            self.setUp()
            def interrupt(phase):
                if phase == crash:
                    raise RuntimeError('crash')
            with self.subTest(crash=crash), self.assertRaises(RuntimeError):
                self.run_attempt(interrupt=interrupt)
            before = list(self.journal.records)
            self.lease = 'lease-2'
            self.run_attempt(mount='mount-2')
            self.assertEqual(self.journal.records[:len(before)], before)
            self.assertEqual(self.journal.records[-1]['kind'], 'epoch')
            self.assertEqual(self.effects, ['effect'])


if __name__ == '__main__':
    unittest.main()
