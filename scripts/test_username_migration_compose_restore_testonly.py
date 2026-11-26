import copy
import unittest

import username_migration_compose_restore_testonly as subject


def capture():
    config = {'services': {'server': {'image': 'example/server@sha256:' + 'a' * 64,
                                      'ports': [], 'network_mode': 'none'}}}
    return {'config': config, 'sha256': subject._digest(config)}


class Fake:
    def __init__(self, snapshot):
        self.config = copy.deepcopy(snapshot['config'])
        self.journal = 'restoring'
        self.runtime = 'absent'
        self.fenced = True
        self.capture_ok = True
        self.images_ok = True
        self.restores = 0
        self.starts = 0
        self.lose = None

    def verify_independent_fence(self, digest): return self.fenced
    def read_journal(self, digest): return self.journal
    def verify_capture(self, snapshot): return self.capture_ok
    def normalized_config(self): return self.config
    def verify_images(self, config): return self.images_ok
    def inspect_runtime(self, config): return self.runtime
    def verify_restored_data(self): return True

    def restore_data(self):
        self.restores += 1
        if self.lose == 'restore':
            self.lose = None
            raise RuntimeError('lost reply')

    def record_old_ready(self, digest):
        self.journal = 'old_ready'
        if self.lose == 'journal':
            self.lose = None
            raise RuntimeError('lost reply')

    def start_runtime(self, config):
        self.starts += 1
        self.runtime = 'running'
        if self.lose == 'start':
            self.lose = None
            raise RuntimeError('lost reply')


class ReconstructionTests(unittest.TestCase):
    def setUp(self):
        self.snapshot = capture()
        self.fake = Fake(self.snapshot)

    def run_model(self):
        return subject.reconstruct_testonly(self.snapshot, self.fake)

    def test_idempotent(self):
        self.assertFalse(subject.operational)
        self.assertEqual(self.run_model(), 'old_ready')
        self.assertEqual(self.run_model(), 'old_ready')
        self.assertEqual((self.fake.restores, self.fake.starts), (1, 1))

    def test_lost_replies(self):
        for point in ('restore', 'journal', 'start'):
            with self.subTest(point=point):
                self.fake = Fake(self.snapshot)
                self.fake.lose = point
                with self.assertRaises(subject.ReconstructionError): self.run_model()
                before = self.fake.restores
                boundary = self.fake.journal == 'old_ready'
                self.run_model()
                if boundary: self.assertEqual(self.fake.restores, before)
                self.assertEqual(self.fake.starts, 1)

    def test_rejects_untrusted_or_drifting_inputs(self):
        for field, value in [('fenced', False), ('capture_ok', False),
                             ('images_ok', False), ('journal', None),
                             ('runtime', 'drift')]:
            with self.subTest(field=field):
                self.fake = Fake(self.snapshot)
                setattr(self.fake, field, value)
                with self.assertRaises(subject.ReconstructionError): self.run_model()
                self.assertEqual(self.fake.restores, 0)
        self.fake = Fake(self.snapshot)
        self.fake.config['services']['server']['ports'] = ['80:80']
        with self.assertRaises(subject.ReconstructionError): self.run_model()

    def test_snapshot_rejects_network_and_unpinned_images(self):
        for key, value in [('ports', ['80:80']), ('network_mode', 'host'),
                           ('image', 'example:latest')]:
            with self.subTest(key=key):
                self.snapshot = capture()
                self.snapshot['config']['services']['server'][key] = value
                self.snapshot['sha256'] = subject._digest(self.snapshot['config'])
                self.fake = Fake(self.snapshot)
                with self.assertRaises(subject.ReconstructionError): self.run_model()
                self.assertEqual(self.fake.restores, 0)

    def test_running_before_boundary_rejected(self):
        self.fake.runtime = 'running'
        with self.assertRaises(subject.ReconstructionError): self.run_model()
        self.assertEqual(self.fake.restores, 0)

    def test_after_boundary_drift_never_restores(self):
        self.fake.journal = 'old_ready'
        self.fake.runtime = 'drift'
        with self.assertRaises(subject.ReconstructionError): self.run_model()
        self.assertEqual(self.fake.restores, 0)


if __name__ == '__main__':
    unittest.main()
