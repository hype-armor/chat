#!/usr/bin/env python3
"""Opt-in synthetic Compose fence rehearsal; never a migration entry point."""
import argparse
import fcntl
from hashlib import sha256
import json
import os
from pathlib import Path
import re
import shlex
import shutil
import socket
import stat
import struct
import subprocess
import sys
import time
import uuid


FLOOR = 800 * 1024**2
BOOT = Path('/proc/sys/kernel/random/boot_id')
DOCKER = '/usr/bin/docker'
IMAGES = {
    'app': 'ghcr.io/hype-armor/chat-server:sha-4e04c0b',
    'pg': 'docker.io/library/postgres:18.6',
    's3': 'docker.io/chrislusf/seaweedfs:4.50',
    'curl': 'docker.io/curlimages/curl:8.17.0',
}
PG_IP, S3_IP, APP_IP = '172.29.227.10', '172.29.227.11', '172.29.227.12'
S3_HOST = 'fixture-seaweed'
WRITERS = ('app', 's3', 'pg')
OBSERVERS = ('outside-pg', 'outside-s3')
ORIGINALS = WRITERS + OBSERVERS
MAINT = ('maint-pg', 'maint-s3', 'inside-s3')
VOLUMES = {'pgdata': '/var/lib/postgresql', 's3data': '/data'}
PG_SECRET = 'disposable-only-pg-password'
S3_KEY, S3_SECRET = 'disposable-probe', 'disposable-only-s3-secret'
PG_ENV = {'POSTGRES_USER': 'fixture', 'POSTGRES_DB': 'fixture', 'POSTGRES_PASSWORD': PG_SECRET,
          'POSTGRES_INITDB_ARGS': '--auth-host=scram-sha-256'}
AUTH = {'identities': [{'name': 'fixture', 'credentials': [{'accessKey': S3_KEY, 'secretKey': S3_SECRET}],
                        'actions': ['Admin', 'Read', 'List', 'Write']}]}
PHASES = {'provisioning', 'baseline', 'fencing', 'fenced', 'maintenance', 'proven',
          'awaiting-reboot', 'reboot-check', 'reboot-proven', 'abort-pending', 'aborted'}
SHA = r'sha256:[0-9a-f]{64}'
ID = r'[0-9a-f]{64}'
PROJECT = r'chat-fence-[0-9a-f]{20}'
BUCKET = '/fence-fixture'


class Refusal(Exception):
    pass


def require(condition, reason):
    if not condition:
        raise Refusal(reason)


def matches(pattern, value):
    return isinstance(value, str) and re.fullmatch(pattern, value) is not None


def image_refs(value):
    require(isinstance(value, dict) and set(value) == set(IMAGES), 'Wrong image manifest keys')
    for key, prefix in IMAGES.items():
        require(matches(re.escape(prefix) + '@' + SHA, value[key]), f'Wrong version or missing digest: {key}')
    return value


def plan(project, refs):
    require(matches(PROJECT, project), 'Invalid fixture project')
    refs = image_refs(refs)

    def service(key, **extra):
        # Docker enables compression by default, but rejects it for a single log file.
        return {'image': refs[key], 'pull_policy': 'never', 'restart': 'no',
                'labels': {'chat.fence.fixture': project},
                'logging': {'driver': 'local', 'options': {'max-size': '1m', 'max-file': '1', 'compress': 'false'}},
                **extra}

    def writer_net(ip=None):
        return {'networks': {'writers': {'ipv4_address': ip} if ip else {}}}

    def pg(maintenance):
        address = '127.0.0.1' if maintenance else PG_IP
        return service('pg', environment=PG_ENV, volumes=['pgdata:' + VOLUMES['pgdata']],
                       command=['postgres', '-c', 'listen_addresses=' + address],
                       **({'network_mode': 'none'} if maintenance else writer_net(PG_IP)))

    def s3(maintenance):
        ip = '127.0.0.1' if maintenance else S3_IP
        # Keep the Raft address string stable when the same data moves to loopback.
        cmd = ['weed', 'server', '-s3', '-dir=/data', '-ip=' + S3_HOST, '-ip.bind=' + ip,
               '-s3.ip.bind=' + ip, '-s3.config=/tmp/fixture-s3.json', '-master.telemetry=false',
               '-master.volumeSizeLimitMB=32', '-master.volumePreallocate=false',
               '-volume.max=4', '-volume.minFreeSpace=800MiB']
        auth = json.dumps(AUTH, separators=(',', ':'))
        script = f"umask 077; printf '%s\\n' {shlex.quote(auth)} >/tmp/fixture-s3.json; exec {shlex.join(cmd)}"
        return service('s3', volumes=['s3data:' + VOLUMES['s3data']], entrypoint=['/bin/sh', '-ec'],
                       environment={'WEED_MASTER_VOLUME_GROWTH_COPY_1': '1'}, command=[script],
                       extra_hosts=[S3_HOST + ':' + ip],
                       **({'network_mode': 'none'} if maintenance else writer_net(S3_IP)))

    def probe(image, **extra):
        return service(image, entrypoint=['/bin/sh', '-ec'],
                       command=["trap 'exit 0' TERM INT; while :; do sleep 86400 & wait; done"], **extra)

    services = {
        'pg': pg(False), 's3': s3(False), 'maint-pg': pg(True), 'maint-s3': s3(True),
        'app': service('app', environment={
            'DATABASE_URL': f'postgres://fixture:{PG_SECRET}@{PG_IP}:5432/fixture',
            'CHAT_BLOB_STORE': 's3://fence-fixture', 'AWS_ENDPOINT': f'http://{S3_IP}:8333',
            'AWS_ACCESS_KEY_ID': S3_KEY, 'AWS_SECRET_ACCESS_KEY': S3_SECRET,
            'AWS_ALLOW_HTTP': 'true', 'AWS_REGION': 'us-east-1', 'CHAT_TILES_SOURCE': '',
            'CHAT_EXPERIMENTAL_PRESENCE': 'false',
        }, **writer_net(APP_IP)),
        'outside-pg': probe('pg', tmpfs=[VOLUMES['pgdata']], **writer_net()),
        'outside-s3': probe('curl', **writer_net()),
        'inside-s3': probe('curl', network_mode='service:maint-s3'),
    }
    label = {'labels': {'chat.fence.fixture': project}}
    return {'name': project, 'services': services,
            'networks': {'writers': {'driver': 'bridge', 'internal': True,
                                     'ipam': {'config': [{'subnet': '172.29.227.0/24',
                                                          'ip_range': '172.29.227.128/25'}]}, **label}},
            'volumes': {v: {'driver': 'local', **label} for v in VOLUMES}}


def space(path):
    disk = shutil.disk_usage(path)
    require(disk.free >= FLOOR, 'Less than 800 MiB free on a fixture filesystem')


def private_file(path, kind, mode=None):
    info = path.lstat()
    require(kind(info.st_mode) and info.st_uid == os.getuid()
            and (mode is None or stat.S_IMODE(info.st_mode) == mode), f'Unsafe fixture path: {path.name}')
    return info


def durable_json(path, value):
    temp = path.with_name('.new-' + uuid.uuid4().hex)
    with os.fdopen(os.open(temp, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600), 'w') as output:
        json.dump(value, output, sort_keys=True, indent=2)
        output.write('\n')
        output.flush()
        os.fsync(output.fileno())
    os.replace(temp, path)
    fd = os.open(path.parent, os.O_DIRECTORY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def current_boot():
    value = BOOT.read_text().strip()
    require(str(uuid.UUID(value)) == value, 'Invalid Linux boot ID')
    return value


class Engine:
    def __init__(self, work):
        require(os.getuid() != 0, 'Use an unprivileged fixture user in a disposable guest')
        require(work.is_absolute() and work.resolve() == work and work.parent != work
                and not work.is_relative_to('/srv/chat') and not work.is_relative_to('/run'),
                'Use a real, absolute, private fixture directory outside /run and /srv/chat')
        private_file(work, stat.S_ISDIR, 0o700)
        self.work, self.sock, self.data = work, work / 'engine.sock', work / 'engine-data'
        self.config = work / 'cli'
        # No ambient contexts, Compose files, credentials, proxies, plugin overrides or .env.
        self.config.mkdir(mode=0o700, exist_ok=True)
        private_file(self.config, stat.S_ISDIR, 0o700)
        require(not any(self.config.iterdir()), 'Docker CLI directory must be empty')
        self.env = {'PATH': '/usr/bin:/bin', 'HOME': str(self.config), 'DOCKER_CONFIG': str(self.config),
                    'COMPOSE_DISABLE_ENV_FILE': '1', 'LC_ALL': 'C'}
        self.check_endpoint()

    def check_endpoint(self):
        private_file(self.data, stat.S_ISDIR, 0o700)
        space(self.work)
        space(self.data)
        info = private_file(self.sock, stat.S_ISSOCK, 0o600)
        require(info.st_nlink == 1, 'Fixture socket must not have hard links')
        with socket.socket(socket.AF_UNIX) as peer:
            peer.settimeout(2)
            peer.connect(str(self.sock))
            pid, uid, _ = struct.unpack('3i', peer.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12))
            require(pid > 1 and uid == os.getuid(), 'Fixture socket peer must be a local unprivileged process')
            proc = Path('/proc') / str(pid)
            require((proc / 'exe').readlink() == Path('/usr/bin/dockerd'), 'Fixture socket must be served directly by dockerd')
            args = (proc / 'cmdline').read_bytes().split(b'\0')
            host_args = [a for a in args if a.startswith((b'--host', b'-H'))]
            require(os.fsencode('--data-root=' + str(self.data)) in args and
                    host_args == [os.fsencode('--host=unix://' + str(self.sock))],
                    'dockerd must explicitly select only this fixture socket and data root')
        now = self.sock.lstat()
        require((now.st_dev, now.st_ino, now.st_mode, now.st_uid) ==
                (info.st_dev, info.st_ino, info.st_mode, info.st_uid), 'Fixture socket changed during validation')

    def run(self, *argv, allow_failure=False):
        self.check_endpoint()
        result = subprocess.run([DOCKER, '--host', 'unix://' + str(self.sock), *argv],
                                cwd=self.work, env=self.env, stdin=subprocess.DEVNULL,
                                pass_fds=(self.owner_lock,), capture_output=True, text=True, timeout=65, check=False)
        if not allow_failure:
            require(result.returncode == 0, f'Docker {argv[0]} failed: {result.stderr.strip()[:500]}')
        return result

    def json(self, *argv):
        return json.loads(self.run(*argv).stdout)

    def ids(self, *argv):
        values = self.run(*argv).stdout.splitlines()
        require(len(values) == len(set(values)), 'Duplicate objects in daemon inventory')
        return values

    def identity(self):
        info = self.json('info', '--format', '{{json .}}')
        require(info.get('DockerRootDir') == str(self.data) and info.get('NCPU') == 1
                and info.get('OSType') == 'linux' and info.get('Swarm', {}).get('LocalNodeState') == 'inactive'
                and 'name=rootless' in info.get('SecurityOptions', []) and info.get('LiveRestoreEnabled') is False
                and bool(info.get('ID')), 'Expected a dedicated one-CPU rootless Linux daemon without live restore or swarm')
        root = self.data.stat()
        return {'engine': info['ID'], 'data_device': root.st_dev, 'data_inode': root.st_ino}

    def image_ids(self, refs):
        ids = {}
        for key, ref in refs.items():
            row, = self.json('image', 'inspect', ref)
            tag, digest = ref.split('@')
            repo, _ = tag.rsplit(':', 1)
            canonical = repo + '@' + digest
            variants = {canonical, canonical.removeprefix('docker.io/'), canonical.removeprefix('docker.io/library/')}
            require(variants.intersection(row.get('RepoDigests') or []) and matches(SHA, row.get('Id')),
                    f'Missing independently pinned local image: {key}')
            ids[ref] = row['Id']
        return ids

    def create(self, project, *services):
        self.run('compose', '--env-file', '/dev/null', '--file', str(self.work / 'fixture.json'),
                 '--project-name', project, 'create', '--no-build', '--pull', 'never', '--no-recreate', *services)


class Rehearsal:
    def __init__(self, engine, journal, spec):
        self.engine, self.journal, self.spec = engine, journal, spec
        self.project = spec['name']
        self.net = self.project + '_writers'

    def save(self, phase, **updates):
        self.journal.update(phase=phase, **updates)
        durable_json(self.engine.work / 'journal.json', self.journal)

    def no_pending(self):
        require(not self.journal.get('pending'), 'Unresolved Docker mutation; dispose of the dedicated guest')

    def mutate(self, operation, callback, *args):
        # A client timeout or death says nothing about the daemon's final effect.
        # Do not automatically reconcile or issue more mutations in that case.
        self.no_pending()
        phase = self.journal['phase']
        self.save(phase, pending=operation)
        callback(*args)
        self.save(phase, pending=None)

    def inventory(self, *, allow_partial=False):
        """Bind all fixture objects, including stopped containers. Reject anything foreign."""
        engine, project = self.engine, self.project
        records = self.journal.get('containers', {})
        net_info = engine.ids('network', 'ls', '--format', '{{.Name}}')
        builtins = {'bridge', 'host', 'none'}
        require(builtins <= set(net_info) <= builtins | {self.net}, 'Foreign network in dedicated daemon')
        network_id = None
        if self.net in net_info:
            network, = engine.json('network', 'inspect', self.net)
            labels = network.get('Labels') or {}
            require(network.get('Name') == self.net and labels.get('chat.fence.fixture') == project
                    and labels.get('com.docker.compose.project') == project and network.get('Driver') == 'bridge'
                    and network.get('Internal') is True and not network.get('EnableIPv6')
                    and [(c.get('Subnet'), c.get('IPRange')) for c in network['IPAM']['Config']] ==
                    [('172.29.227.0/24', '172.29.227.128/25')]
                    and matches(ID, network.get('Id')), 'Writer network identity or isolation mismatch')
            network_id = network['Id']
        expected_net = self.journal.get('network')
        require(not expected_net or network_id == expected_net, 'Writer network changed')
        names = engine.ids('volume', 'ls', '--format', '{{.Name}}')
        volume_ids = {}
        for name in names:
            logical = name.removeprefix(project + '_')
            require(logical in VOLUMES and name == project + '_' + logical, 'Foreign volume in dedicated daemon')
            volume, = engine.json('volume', 'inspect', name)
            labels = volume.get('Labels') or {}
            mount = engine.data / 'volumes' / name / '_data'
            require(volume.get('Name') == name and volume.get('Driver') == 'local' and volume.get('Scope') == 'local'
                    and not volume.get('Options') and labels.get('chat.fence.fixture') == project
                    and labels.get('com.docker.compose.project') == project and volume.get('Mountpoint') == str(mount)
                    and bool(volume.get('CreatedAt')), 'Wrong volume identity or driver')
            # Rootless mounts can have remapped ownership. Docker metadata and the
            # store canaries bind them without traversing their private contents.
            volume_ids[logical] = [volume['CreatedAt'], str(mount)]
        observed = {}
        ids = sorted(engine.ids('container', 'ls', '--all', '--no-trunc', '--quiet'))
        require(all(matches(ID, cid) for cid in ids), 'Malformed container ID')
        rows = engine.json('container', 'inspect', *ids) if ids else []
        require(sorted(row['Id'] for row in rows) == sorted(ids), 'Container inventory changed')
        for row in rows:
            labels = row['Config']['Labels'] or {}
            name = labels.get('com.docker.compose.service')
            host = row['HostConfig']
            require(name in self.spec['services'] and name not in observed
                    and labels.get('com.docker.compose.project') == project
                    and labels.get('chat.fence.fixture') == project and not row.get('Config', {}).get('Tty'),
                    'Foreign or duplicate container in dedicated daemon')
            service = self.spec['services'][name]
            require(row['Image'] == self.journal['images'][service['image']]
                    and host['RestartPolicy']['Name'] == 'no' and not host.get('AutoRemove')
                    and not any(row['State'].get(k) for k in ('Restarting', 'Dead', 'Paused'))
                    and not host.get('Privileged') and not host.get('PublishAllPorts') and not host.get('PortBindings')
                    and not any(host.get(k) for k in ('VolumesFrom', 'Devices', 'DeviceRequests', 'CapAdd',
                                                      'Links', 'PidMode', 'UTSMode'))
                    and host.get('IpcMode') in ('private', 'none', '')
                    and not any(row['NetworkSettings'].get('Ports', {}).values() if
                                row['NetworkSettings'].get('Ports') else []), 'Unexpected container runtime or restart settings: ' + name)
            require(all(row['Config'].get(config) == service[field] for config, field in
                        (('Entrypoint', 'entrypoint'), ('Cmd', 'command')) if field in service),
                    'Container command changed: ' + name)
            actual_hosts = [entry.replace('=', ':', 1) for entry in (host.get('ExtraHosts') or [])]
            require(actual_hosts == service.get('extra_hosts', []), 'Container hosts mapping changed: ' + name)
            for key, value in service.get('environment', {}).items():
                require([v for v in row['Config']['Env'] if v.startswith(key + '=')] == [key + '=' + value],
                        'Container environment changed: ' + name)
            expected_mode = self.net if 'networks' in service else 'none'
            if name == 'inside-s3':
                require(matches(ID, host['NetworkMode'].removeprefix('container:')) and
                        host['NetworkMode'].startswith('container:'), 'Invalid private S3 probe namespace')
            else:
                require(host['NetworkMode'] == expected_mode, 'Unexpected network mode: ' + name)
            endpoints = row['NetworkSettings']['Networks'] or {}
            permitted = set() if name == 'inside-s3' else {expected_mode}
            require(set(endpoints) <= permitted, 'Container has an extra network attachment: ' + name)
            if row['State']['Running'] and expected_mode == self.net:
                endpoint = endpoints.get(self.net, {})
                ip = service['networks']['writers'].get('ipv4_address')
                require(endpoint.get('NetworkID') == network_id and endpoint.get('IPAddress')
                        and (not ip or endpoint['IPAddress'] == ip), 'Writer network endpoint drift: ' + name)
            expected_mounts = {}
            for item in service.get('volumes', []):
                logical, target = item.split(':')
                require(logical in volume_ids, 'Expected fixture volume is missing')
                expected_mounts[target] = (project + '_' + logical, volume_ids[logical][1])
            found = {}
            for mount in row['Mounts']:
                target = mount['Destination']
                if mount['Type'] == 'tmpfs' and name == 'outside-pg' and target == VOLUMES['pgdata']:
                    continue
                require(target not in found and mount['Type'] == 'volume' and mount.get('Driver') == 'local'
                        and mount['RW'] is True, 'Unexpected mount: ' + name)
                found[target] = mount['Name'], mount['Source']
            named_binds = {source + ':' + target + suffix for target, (source, _) in expected_mounts.items()
                           for suffix in ('', ':rw')}
            require(found == expected_mounts and set(host.get('Binds') or []) <= named_binds
                    and set(host.get('Tmpfs') or {}) == set(service.get('tmpfs', [])),
                    'Volume attachment mismatch: ' + name)
            require(name not in records or records[name] == row['Id'], 'Container identity changed: ' + name)
            observed[name] = row
        if 'inside-s3' in observed:
            require('maint-s3' in observed and observed['inside-s3']['HostConfig']['NetworkMode'] ==
                    'container:' + observed['maint-s3']['Id'], 'Private S3 probe joined the wrong container')
        require(set(records) <= set(observed) and self.journal.get('volumes', volume_ids) == volume_ids,
                'Recorded object disappeared or changed')
        if not allow_partial:
            require(set(observed) == set(records), 'Unrecorded container in fixture')
        if network_id:
            attached = set(network.get('Containers') or {})
            expected = {row['Id'] for name, row in observed.items() if row['State']['Running']
                        and 'networks' in self.spec['services'][name]}
            require(attached == expected, 'Unexpected writer network membership')
        require(sorted(engine.ids('container', 'ls', '--all', '--no-trunc', '--quiet')) == ids,
                'Container inventory changed during inspection')
        return observed, network_id, volume_ids

    def check_fence(self, rows):
        require(set(WRITERS) <= set(rows), 'Missing original writer')
        for name in WRITERS:
            state = rows[name]['State']
            require(state.get('Running') is False and state.get('Pid') == 0 and
                    not state.get('OOMKilled') and state.get('ExitCode') in ((0,) if name == 'pg' else (0, 143)),
                    'Original writer did not stop with an expected exit status: ' + name)

    def operation(self, action, names, *, require_fence=False):
        require(action in ('start', 'stop'), 'Unknown lifecycle operation')
        phase = self.journal['phase']
        if action == 'start':
            require(not set(names).intersection(WRITERS) or phase == 'baseline',
                    'Original writers can start only during baseline')
            require(not set(names).intersection(MAINT) or (require_fence and phase in ('maintenance', 'reboot-check')),
                    'Only the fenced maintenance owner can start a maintenance container')
        for name in names:
            rows, _, _ = self.inventory()
            if require_fence:
                self.check_fence(rows)
            if name in rows and rows[name]['State']['Running'] != (action == 'start'):
                args = ('--time', '45') if action == 'stop' else ()
                self.mutate([action, name, rows[name]['Id']], self.engine.run,
                            'container', action, *args, rows[name]['Id'])

    def exec(self, name, *args):
        require(name in self.journal['containers'], 'Probe container not recorded')
        return self.engine.run('container', 'exec', self.journal['containers'][name], *args, allow_failure=True)

    def sql(self, name, host, sql):
        return self.exec(name, 'env', 'PGPASSWORD=' + PG_SECRET, 'PGCONNECT_TIMEOUT=2', 'psql', '-XAtw',
                         '-v', 'ON_ERROR_STOP=1', '-h', host, '-U', 'fixture', '-d', 'fixture', '-c', sql)

    def curl(self, name, ip, port, method, path, body=None, *, signed=True, transport_only=False):
        auth = ()
        if signed:
            digest = sha256((body or '').encode('utf-8')).hexdigest()
            auth = ('--aws-sigv4', 'aws:amz:us-east-1:s3', '--user', S3_KEY + ':' + S3_SECRET,
                    '--header', 'x-amz-content-sha256: ' + digest)
        data = ('--data-binary', body) if body is not None else ()
        report = '\n%{http_code} %{time_connect}' if transport_only else '\n%{http_code}'
        return self.exec(name, 'curl', '--noproxy', '*', '--ipv4', '--connect-timeout', '2', '--max-time', '5',
                         '-sS', '-w', report, '-X', method, *auth, *data, f'http://{ip}:{port}{path}')

    @staticmethod
    def http_ok(result, body=None):
        payload, _, status = result.stdout.rpartition('\n')
        return result.returncode == 0 and status == '200' and (body is None or payload == body)

    @staticmethod
    def http_unreachable(result):
        return result.returncode in (7, 28) and result.stdout == '\n000 0.000000'

    @staticmethod
    def wait(check, message):
        deadline = time.monotonic() + 45
        while time.monotonic() < deadline:
            if check():
                return
            time.sleep(.5)
        raise Refusal(message)

    def baseline(self):
        require(self.journal['phase'] == 'baseline' and set(self.journal['containers']) == set(ORIGINALS),
                'Baseline needs the exact original fixture')
        self.operation('start', (*OBSERVERS, 'pg', 's3'))
        self.wait(lambda: self.sql('outside-pg', PG_IP, 'SELECT 1;').stdout.strip() == '1', 'Original TCP SQL not ready')
        self.wait(lambda: self.http_ok(self.curl('outside-s3', S3_IP, 8333, 'GET', '/')), 'Original signed S3 not ready')
        require(self.http_ok(self.curl('outside-s3', S3_IP, 8333, 'PUT', BUCKET)), 'Bucket creation failed')
        marker = self.project + '-before-fence'
        self.wait(lambda: self.http_ok(self.curl('outside-s3', S3_IP, 8333, 'PUT', BUCKET + '/baseline', marker)),
                  'Writer network could not write baseline S3 bytes after volume growth')
        require(self.http_ok(self.curl('outside-s3', S3_IP, 8333, 'GET', BUCKET + '/baseline'), marker),
                'Writer network did not read baseline S3 bytes')
        self.operation('start', ('app',))
        self.wait(lambda: self.http_ok(self.curl('outside-s3', APP_IP, 8080, 'GET', '/healthz', signed=False)),
                  'Exact old app did not become healthy on the writer network')
        result = self.sql('outside-pg', PG_IP, 'SELECT max(version) FROM _sqlx_migrations WHERE success;')
        require(result.returncode == 0 and result.stdout.strip() == '20', 'Old app schema was not the expected version')
        result = self.sql('outside-pg', PG_IP, "CREATE TABLE fixture_fence(k text PRIMARY KEY, v text); "
                          f"INSERT INTO fixture_fence VALUES ('before', '{marker}'); "
                          'SELECT system_identifier FROM pg_control_system();')
        system_id = result.stdout.splitlines()[-1] if result.stdout.splitlines() else ''
        require(result.returncode == 0 and matches(r'[0-9]{16,21}', system_id), 'Writer network did not establish PG baseline')
        self.save('fencing', pg_system=system_id, marker=marker,
                  baseline={'app_health': 200, 'sqlx_max': 20, 'pg_tcp_write': True, 'signed_s3_put_get': True,
                            'pg_address': PG_IP, 's3_address': S3_IP})

    def prove(self, *, after_reboot):
        rows, _, _ = self.inventory()
        self.check_fence(rows)
        require(all(rows[n]['State']['Running'] for n in (*OBSERVERS, *MAINT)), 'A probe or maintenance store is not running')
        marker = self.project + '-before-fence'
        require(self.journal['marker'] == marker and matches(r'[0-9]{16,21}', self.journal['pg_system']),
                'Invalid baseline proof in journal')
        private_pg = lambda sql: self.sql('maint-pg', '127.0.0.1', sql)
        private_s3 = lambda method, path, body=None: self.curl('inside-s3', '127.0.0.1', 8333, method, BUCKET + path, body)
        self.wait(lambda: private_pg('SELECT 1;').stdout.strip() == '1', 'Private PG not ready')
        self.wait(lambda: self.http_ok(private_s3('GET', '/baseline'), marker), 'Private S3 baseline bytes missing')
        previous = 'maintenance' if after_reboot else 'before'
        result = private_pg("SELECT system_identifier FROM pg_control_system(); "
                            f"SELECT v FROM fixture_fence WHERE k='{previous}';")
        require(result.returncode == 0 and result.stdout.splitlines() == [self.journal['pg_system'], marker],
                'Private PG cluster or baseline bytes changed')
        if after_reboot:
            require(self.http_ok(private_s3('GET', '/maintenance'), marker), 'Private S3 canary did not survive reboot')
        for signed in (True, False):
            result = self.curl('outside-s3', S3_IP, 8333, 'PUT', BUCKET + '/outside', marker,
                               signed=signed, transport_only=True)
            require(self.http_unreachable(result), 'Outside S3 result was not a verified connection failure')
        for ip, port in ((APP_IP, 8080), (S3_IP, 9333), (S3_IP, 8888), (S3_IP, 8080)):
            result = self.curl('outside-s3', ip, port, 'GET', '/', signed=False, transport_only=True)
            require(self.http_unreachable(result), f'Outside app or SeaweedFS admin listener still reachable: {ip}:{port}')
        result = self.sql('outside-pg', PG_IP, "INSERT INTO fixture_fence VALUES ('outside', 'unexpected');")
        require(result.returncode == 2 and not result.stdout and any(word in result.stderr for word in
                ('Connection refused', 'timeout expired', 'No route to host', 'Network is unreachable')),
                'Outside PG result was not a verified connection failure')
        result = private_pg('SELECT count(*) FROM fixture_fence WHERE k=\'outside\';')
        require(result.returncode == 0 and result.stdout.strip() == '0', 'Outside SQL canary appeared in the private store')
        result = private_s3('GET', '/outside')
        require(result.returncode == 0 and result.stdout.endswith('\n404'), 'Outside S3 canary is not absent')
        result = private_pg(f"INSERT INTO fixture_fence VALUES ('maintenance', '{marker}') ON CONFLICT (k) "
                            "DO UPDATE SET v=excluded.v RETURNING v;")
        require(result.returncode == 0 and marker in result.stdout.splitlines(), 'Private PG write/read failed')
        self.wait(lambda: self.http_ok(private_s3('PUT', '/maintenance', marker)), 'Private S3 write failed')
        require(self.http_ok(private_s3('GET', '/maintenance'), marker), 'Private S3 read failed')
        self.check_fence(self.inventory()[0])
        proof = {'boot': current_boot(), 'pg_old_credential_transport_denied': True,
                 's3_signed_and_unsigned_transport_denied': True, 'no_outside_canaries': True,
                 'original_app_and_seaweed_admin_http_unreachable': True,
                 'same_cluster_and_baseline': True, 'private_pg_and_s3_write_read': True}
        if after_reboot:
            self.save('reboot-proven', reboot_proof=proof)
        else:
            self.save('proven', fence_proof=proof)

    def continue_run(self):
        self.no_pending()
        if self.journal['phase'] == 'fencing':
            self.operation('stop', WRITERS)
            self.check_fence(self.inventory()[0])
            self.save('fenced')
        if self.journal['phase'] == 'fenced':
            rows, _, _ = self.inventory(allow_partial=True)
            self.check_fence(rows)
            require(not any(rows[n]['State']['Running'] for n in MAINT if n in rows),
                    'Unrecorded maintenance process is running')
            self.mutate(['create', *MAINT], self.engine.create, self.project, *MAINT)
            rows, _, _ = self.inventory(allow_partial=True)
            self.check_fence(rows)
            require(set(rows) == set(ORIGINALS + MAINT) and not any(rows[n]['State']['Running'] for n in MAINT),
                    'Maintenance creation did not yield the exact stopped fixture')
            self.save('maintenance', containers={n: row['Id'] for n, row in rows.items()})
        after_reboot = self.journal['phase'] == 'reboot-check'
        if self.journal['phase'] == 'awaiting-reboot':
            boot = current_boot()
            require(boot != self.journal['reboot_from'], 'Externally reboot the dedicated guest before resuming')
            rows, _, _ = self.inventory()
            self.check_fence(rows)
            require(not any(row['State']['Running'] for row in rows.values()), 'A fixture container restarted without the owner')
            self.save('reboot-check', reboot_to=boot)
            after_reboot = True
        require(self.journal['phase'] in ('maintenance', 'reboot-check'), 'This phase cannot resume')
        if after_reboot:
            require(current_boot() == self.journal['reboot_to'], 'Guest boot changed during the reboot check')
        self.operation('start', (*OBSERVERS, *MAINT), require_fence=True)
        self.prove(after_reboot=after_reboot)

    def abort(self):
        self.no_pending()
        if self.journal['phase'] == 'aborted':
            require(not any(row['State']['Running'] for row in self.inventory()[0].values()),
                    'An aborted fixture container is running')
            return
        phase = self.journal['phase']
        rows, network, volumes = self.inventory(allow_partial=phase in ('provisioning', 'fenced'))
        if phase == 'provisioning':
            require(set(rows) <= set(ORIGINALS), 'Unexpected service in partial initial creation')
        if phase == 'fenced':
            self.check_fence(rows)
            require(not any(rows[n]['State']['Running'] for n in MAINT if n in rows),
                    'Unrecorded maintenance process is running')
        self.save('abort-pending', containers={n: row['Id'] for n, row in rows.items()}, network=network, volumes=volumes)
        self.operation('stop', ('inside-s3', 'maint-s3', 'maint-pg', *WRITERS, *OBSERVERS))
        require(not any(row['State']['Running'] for row in self.inventory()[0].values()), 'Fixture did not stop')
        self.save('aborted')


def fresh(engine):
    return (not engine.ids('container', 'ls', '--all', '--quiet') and
            not engine.ids('volume', 'ls', '--quiet') and
            set(engine.ids('network', 'ls', '--format', '{{.Name}}')) == {'bridge', 'host', 'none'})


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=('render', 'run', 'resume', 'arm-reboot', 'abort'))
    parser.add_argument('--images', type=Path, help='JSON image manifest for render or run')
    parser.add_argument('--workspace', type=Path, help='Private directory in a disposable one-CPU guest')
    parser.add_argument('--disposable-guest', action='store_true', help='Confirm exclusive ownership of an offline disposable guest')
    args = parser.parse_args()
    if args.action == 'render':
        require(args.images and not args.workspace and not args.disposable_guest, 'Render needs only --images')
        print(json.dumps(plan('chat-fence-' + '0' * 20, json.loads(args.images.read_text())), indent=2))
        return
    require(args.disposable_guest and args.workspace, 'Explicit disposable guest and private workspace required')
    require((args.action == 'run') == bool(args.images), 'Use --images only for run or render')
    engine = Engine(args.workspace)
    lock = os.open(engine.work / 'owner.lock', os.O_CREAT | os.O_NOFOLLOW | os.O_RDWR, 0o600)
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        engine.owner_lock = lock
        path = engine.work / 'journal.json'
        if args.action == 'run':
            require(not path.exists() and not path.is_symlink() and fresh(engine), 'A new, empty dedicated daemon is required')
            project = 'chat-fence-' + uuid.uuid4().hex[:20]
            refs = image_refs(json.loads(args.images.read_text()))
            spec = plan(project, refs)
            run = Rehearsal(engine, {'version': 1, 'project': project, 'refs': refs, 'images': engine.image_ids(refs),
                                     'daemon': engine.identity(), 'boot': current_boot(), 'containers': {}}, spec)
            durable_json(engine.work / 'fixture.json', spec)
            run.save('provisioning')
            run.mutate(['create', *ORIGINALS], engine.create, project, *ORIGINALS)
            rows, network, volumes = run.inventory(allow_partial=True)
            require(set(rows) == set(ORIGINALS) and network and set(volumes) == set(VOLUMES)
                    and not any(row['State']['Running'] for row in rows.values()), 'Expected stopped Compose fixture not created')
            run.save('baseline', containers={n: row['Id'] for n, row in rows.items()}, network=network, volumes=volumes)
            run.baseline()
            run.continue_run()
        else:
            private_file(path, stat.S_ISREG, 0o600)
            journal = json.loads(path.read_text())
            require(journal['version'] == 1 and journal['phase'] in PHASES and journal['daemon'] == engine.identity()
                    and journal['images'] == engine.image_ids(image_refs(journal['refs'])), 'Journal or daemon identity changed')
            spec = plan(journal['project'], journal['refs'])
            private_file(engine.work / 'fixture.json', stat.S_ISREG, 0o600)
            require(json.loads((engine.work / 'fixture.json').read_text()) == spec, 'Compose fixture changed')
            run = Rehearsal(engine, journal, spec)
            run.no_pending()
            if args.action == 'abort':
                run.abort()
            elif args.action == 'arm-reboot':
                require(journal['phase'] == 'proven' and current_boot() == journal['boot'], 'Prove the fence before arming a guest reboot')
                run.check_fence(run.inventory()[0])
                run.save('awaiting-reboot', reboot_from=current_boot())
            else:
                require(journal['phase'] in ('awaiting-reboot', 'reboot-check') or journal['boot'] == current_boot(),
                        'Unplanned boot change; abort or discard the guest')
                run.continue_run()
        print(f"{run.journal['phase']}: {path} (fixture evidence only; not an application migration)")
    finally:
        os.close(lock)


if __name__ == '__main__':
    try:
        main()
    except (Refusal, OSError, ValueError, KeyError, TypeError, subprocess.SubprocessError) as error:
        print(f'Rehearsal stopped: {error}. Do not start other writers. Inspect the journal or discard the guest.', file=sys.stderr)
        sys.exit(1)
