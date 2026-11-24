import hashlib
import json
import os
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

from username_migration_compose_recreate_testonly import FakeDocker, RecreateError, recreate_testonly

IMAGE = 'sha256:' + 'a' * 64
CID = 'b' * 64
HASH = 'c' * 64
OPERATION = '12345678-1234-4234-8234-123456789abc'

class Fake(FakeDocker):
    def __init__(self):
        self.records = []
        self.calls = []
        self.drift = False
        self.hash = HASH
    def run(self, args, **kwargs):
        self.calls.append(args)
        cmd = args[3:]
        out = ''
        if cmd[0] == 'compose' and 'config' in cmd:
            if '--hash' in cmd:
                out = 'server ' + self.hash
            else:
                out = Path(cmd[cmd.index('-f') + 1]).read_text()
                if self.drift:
                    out = '{}'
        elif cmd[:2] == ['image', 'inspect']:
            out = IMAGE
        elif cmd[:3] == ['container', 'ls', '--all']:
            out = '\n'.join(r['Id'] for r in self.records)
        elif cmd[0] == 'inspect':
            out = json.dumps(self.records)
        elif cmd[0] == 'compose' and 'create' in cmd:
            self.records.append({'Id': CID, 'Image': IMAGE, 'Config': {'Labels': {
                'com.docker.compose.project': 'chat', 'com.docker.compose.service': 'server',
                'com.docker.compose.config-hash': self.hash, 'com.docker.compose.container-number': '1'}},
                'State': {'Status': 'created'}, 'HostConfig': {'RestartPolicy': {'Name': 'no'}}})
        else:
            raise AssertionError(cmd)
        return subprocess.CompletedProcess(args, 0, out, '')

class TestRecreate(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.path = Path(self.tmp.name)
        self.fake = Fake()
        self.phase = {'phase': 'rollback', 'ingress_closed': True}
        self.config = {'name': 'chat', 'services': {'server': {'image': IMAGE}}}
        self.write_evidence()
    def write_evidence(self, profiles=None):
        raw = json.dumps(self.config).encode()
        env = b''
        manifest = {'version': 1, 'operation': OPERATION, 'profiles': profiles or [], 'binds': [], 'containers': {'server': {'image': IMAGE}},
                    'pins': {'server': 'synthetic:pin'}, 'config_sha256': hashlib.sha256(raw).hexdigest(),
                    'env_sha256': hashlib.sha256(env).hexdigest()}
        data = json.dumps(manifest).encode()
        for name, content in [('config.json', raw), ('env', env), ('manifest.json', data)]:
            p = self.path / name
            p.write_bytes(content)
            p.chmod(0o600)
        self.digest = hashlib.sha256(data).hexdigest()
    def invoke(self):
        return recreate_testonly(evidence_dir=self.path, trusted_digest=self.digest,
                                 fake_docker=self.fake, check_boundary=lambda operation, digest: (
                                     operation == OPERATION and digest == self.digest and
                                     self.phase == {'phase': 'rollback', 'ingress_closed': True}))
    def test_create_and_reconcile_without_start(self):
        self.assertEqual(self.invoke(), {'server': CID})
        self.assertEqual(self.invoke(), {'server': CID})
        creates = [x for x in self.fake.calls if 'create' in x]
        self.assertEqual(len(creates), 1)
        self.assertIn('--no-build', creates[0])
        self.assertIn('--no-deps', creates[0])
        self.assertFalse(any('start' in x or 'up' in x for x in self.fake.calls))
    def test_drift_and_untrusted_evidence(self):
        self.fake.drift = True
        with self.assertRaises(RecreateError): self.invoke()
        self.assertFalse(any('create' in x for x in self.fake.calls))
        self.fake.drift = False
        self.digest = '0' * 64
        with self.assertRaises(RecreateError): self.invoke()
    def test_old_ready_and_open_ingress_rejected(self):
        for phase in ({'phase': 'old_ready', 'ingress_closed': True}, {'phase': 'rollback', 'ingress_closed': False}):
            self.phase = phase
            with self.assertRaises(RecreateError): self.invoke()
        self.assertEqual(self.fake.calls, [])
    def test_wrong_label_and_extra_container(self):
        self.invoke()
        self.fake.records[0]['Image'] = 'sha256:' + 'd' * 64
        with self.assertRaises(RecreateError): self.invoke()
        self.fake.records[0]['Image'] = IMAGE
        self.fake.records[0]['Config']['Labels']['com.docker.compose.service'] = 'other'
        with self.assertRaises(RecreateError): self.invoke()
    @unittest.skipUnless(shutil.which('docker'), 'Docker Compose CLI unavailable')
    def test_real_compose_config_with_fake_effects(self):
        command = ['docker', 'compose', '--project-directory', str(self.path), '-f', '-', 'config', '--format', 'json']
        result = subprocess.run(command, input=json.dumps(self.config), text=True, capture_output=True, check=True)
        self.config = json.loads(result.stdout)
        self.write_evidence()
        class RealConfigFakeEffects(Fake):
            def run(inner, args, **kwargs):
                if args[3] == 'compose' and 'config' in args:
                    result = subprocess.run(args, **kwargs)
                    if '--hash' in args and result.returncode == 0:
                        inner.hash = result.stdout.split()[1]
                    return result
                return super().run(args, **kwargs)
        self.fake = RealConfigFakeEffects()
        self.assertEqual(self.invoke(), {'server': CID})

    def test_unsupported_resource_features_fail_before_docker(self):
        features = [
            ('ports', [{'target': 80, 'published': '8080', 'protocol': 'tcp'}]),
            ('volumes', [{'type': 'volume', 'source': 'data', 'target': '/data'}]),
            ('volumes', [{'type': 'bind', 'source': '/snapshot', 'target': '/data'}]),
            ('depends_on', {'postgres': {'condition': 'service_healthy'}}),
            ('networks', {'custom': {'aliases': ['server']}}),
            ('profiles', ['optional']),
        ]
        for key, value in features:
            with self.subTest(feature=key, value=value):
                self.config = {'name': 'chat', 'services': {'server': {'image': IMAGE, key: value}}}
                self.write_evidence()
                with self.assertRaises(RecreateError): self.invoke()
                self.assertFalse(self.fake.calls)

    def test_captured_profiles_are_explicitly_rejected(self):
        self.write_evidence(profiles=['https'])
        with self.assertRaises(RecreateError): self.invoke()
        self.assertFalse(self.fake.calls)

    def test_unexpected_running_container_rejected(self):
        self.invoke()
        self.fake.records[0]['State']['Status'] = 'running'
        with self.assertRaises(RecreateError): self.invoke()

    def test_operation_fence_must_return_true(self):
        with self.assertRaises(RecreateError):
            recreate_testonly(evidence_dir=self.path, trusted_digest=self.digest,
                              fake_docker=self.fake, check_boundary=lambda operation, digest: False)
        self.assertFalse(self.fake.calls)

if __name__ == '__main__':
    unittest.main()
