import json
import os
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

from username_migration_compose_runtime import ComposeRuntime, RuntimeErrorSafe

CID = 'a' * 64
IMAGE = 'sha256:' + 'b' * 64
OP = '12345678-1234-4234-8234-123456789abc'


class Fake:
    def __init__(self):
        self.tags = {}
        self.bind = False
        self.config = None
        self.service = 'server'
        self.label_hash = 'd' * 64
        self.calls = []

    def __call__(self, args, **kwargs):
        self.calls.append((args, kwargs))
        assert args[:3] == ['docker', '--host', 'unix:///var/run/docker.sock']
        cmd = args[3:]
        out = ''
        rc = 0
        if cmd[0] == 'compose' and 'config' in cmd and '--hash' in cmd:
            out = self.service + ' ' + ('d' * 64)
        elif cmd[0] == 'compose' and 'config' in cmd:
            path = cmd[cmd.index('-f') + 1]
            if path.endswith('/snapshot/config.json'):
                out = Path(path).read_text()
            else:
                volumes = [{'type': 'bind', 'source': '/tmp/x'}] if self.bind else []
                out = json.dumps(self.config or {'name': 'chat', 'services': {'server': {'volumes': volumes}}})
        elif cmd[0] == 'compose' and 'ps' in cmd:
            out = CID
        elif cmd[0] == 'inspect':
            out = json.dumps([{'Id': CID, 'Image': IMAGE, 'Config': {'Labels': {'com.docker.compose.project': 'chat', 'com.docker.compose.service': self.service, 'com.docker.compose.config-hash': self.label_hash}}}])
        elif cmd[:2] == ['image', 'ls']:
            out = '\n'.join(self.tags)
        elif cmd[:2] == ['image', 'tag']:
            self.tags[cmd[3]] = cmd[2]
        elif cmd[:2] == ['image', 'inspect']:
            out = IMAGE if cmd[-1] == IMAGE else self.tags.get(cmd[-1], '')
            rc = 0 if out else 1
        else:
            raise AssertionError(cmd)
        return subprocess.CompletedProcess(args, rc, out, 'synthetic secret')


class TestRuntime(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.env = self.root / 'env'
        self.env.write_text('PASSWORD=synthetic-secret\n')
        self.env.chmod(0o600)
        self.fake = Fake()
        self.adapter = ComposeRuntime(str(self.root), str(self.env), str(self.root / 'compose.yml'), self.fake)
        self.out = str(self.root / 'snapshot')

    def test_capture_verify_and_tamper(self):
        anchor = self.adapter.capture(OP, ['echo'], self.out)
        self.assertTrue(self.adapter.verify(self.out, anchor))
        self.assertEqual(os.stat(self.out + '/env').st_mode & 0o777, 0o600)
        self.assertTrue(all(call[1]['env'].get('DOCKER_HOST') is None for call in self.fake.calls))
        Path(self.out, 'env').write_text('changed')
        with self.assertRaises(RuntimeErrorSafe):
            self.adapter.verify(self.out, anchor)

    def test_capture_known_binds_and_detect_tampering(self):
        proxy = self.root / 'api-proxy.conf'
        proxy.write_text('synthetic config')
        tiles = self.root / 'tiles'
        tiles.mkdir()
        (tiles / 'tile').write_text('synthetic tile')
        self.fake.service = 'web'
        self.fake.config = {'name': 'chat', 'services': {'web': {'build': {'context': 'synthetic'}, 'volumes': [
            {'type': 'bind', 'source': str(proxy), 'target': '/etc/nginx/conf.d/extra/api-proxy.conf', 'read_only': True},
            {'type': 'bind', 'source': str(tiles), 'target': '/srv/tiles', 'read_only': True}]}}}
        anchor = self.adapter.capture(OP, [], self.out)
        self.assertTrue(self.adapter.verify(self.out, anchor))
        rewritten = json.loads(Path(self.out, 'config.json').read_text())
        self.assertEqual(rewritten['services']['web']['image'], IMAGE)
        self.assertNotIn('build', rewritten['services']['web'])
        snapshot = Path(rewritten['services']['web']['volumes'][0]['source'])
        self.assertEqual(snapshot.read_text(), 'synthetic config')
        snapshot.write_text('changed snapshot')
        with self.assertRaises(RuntimeErrorSafe):
            self.adapter.verify(self.out, anchor)

    def test_compose_configuration_drift_rejected_before_pinning(self):
        self.fake.label_hash = 'e' * 64
        with self.assertRaises(RuntimeErrorSafe):
            self.adapter.capture(OP, [], self.out)
        self.assertFalse(self.fake.tags)

    def test_missing_pin(self):
        anchor = self.adapter.capture(OP, [], self.out)
        self.fake.tags.clear()
        with self.assertRaises(RuntimeErrorSafe):
            self.adapter.verify(self.out, anchor)

    def test_bind_rejected_before_pinning(self):
        self.fake.bind = True
        with self.assertRaises(RuntimeErrorSafe):
            self.adapter.capture(OP, [], self.out)
        self.assertFalse(self.fake.tags)

    def test_symlink_input_rejected(self):
        self.env.unlink()
        self.env.symlink_to('/dev/null')
        with self.assertRaises(OSError):
            self.adapter.capture(OP, [], self.out)

    def test_existing_pin_mismatch_rejected(self):
        self.fake.tags['chat-migration-evidence:' + OP + '-server'] = 'sha256:' + 'c' * 64
        with self.assertRaises(RuntimeErrorSafe):
            self.adapter.capture(OP, [], self.out)

    def test_matching_pin_is_retryable(self):
        self.fake.tags['chat-migration-evidence:' + OP + '-server'] = IMAGE
        anchor = self.adapter.capture(OP, [], self.out)
        self.assertTrue(self.adapter.verify(self.out, anchor))

    @unittest.skipUnless(shutil.which('docker'), 'Docker Compose CLI is unavailable')
    def test_real_compose_config_round_trip_without_daemon(self):
        env_file = self.root / 'synthetic.env'
        env_file.write_text("FOO='$BAR'\n")
        source = {'name': 'chat-test', 'services': {'server': {'image': IMAGE,
                  'environment': {'X': '${FOO}'}, 'ports': ['8080:8080']},
                  'echo': {'image': IMAGE, 'profiles': ['echo']}}}
        command = ['docker', 'compose', '--project-directory', str(self.root),
                   '--env-file', str(env_file), '--profile', 'echo', '-f', '-',
                   'config', '--format', 'json']
        clean_env = {'PATH': '/usr/bin:/bin', 'HOME': str(self.root), 'DOCKER_CONFIG': '/nonexistent'}
        first = subprocess.run(command, input=json.dumps(source), capture_output=True,
                               text=True, env=clean_env, check=True)
        normalized = json.loads(first.stdout)
        second = subprocess.run(command, input=json.dumps(normalized), capture_output=True,
                                text=True, env=clean_env, check=True)
        self.assertEqual(json.loads(second.stdout), normalized)
        self.assertIn('$BAR', normalized['services']['server']['environment']['X'])
        self.assertTrue(normalized['services']['server']['ports'])
        hash_command = command[:-3] + ['config', '--hash', '*']
        hashes = subprocess.run(hash_command, input=json.dumps(source), capture_output=True,
                                text=True, env=clean_env, check=True).stdout.splitlines()
        self.assertEqual({line.split()[0] for line in hashes}, {'server', 'echo'})

    def test_restore_always_disabled(self):
        with self.assertRaisesRegex(RuntimeErrorSafe, 'Restore disabled'):
            self.adapter.restore(None, None)
        self.assertFalse(self.fake.calls)


if __name__ == '__main__':
    unittest.main()
