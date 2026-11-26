"""Experimental disposable PostgreSQL lifecycle, not restore authorization.

The caller must use the deployment's actual lock file and continuously fence
external writers. Host and Docker administrators must be trusted to prevent
shared writable files, nested mount aliases, or mount changes between the source
and disposable volume. Path and inode checks alone cannot prove that separation.
Docker has no atomic inventory-and-create operation. Evidence and objects remain.
"""
import hashlib
import json
import os
import re
import stat
import subprocess
import time

from username_migration_docker_pg_backup import _DOCKER, _ENV, _ID, _OPERATION


class LifecycleError(RuntimeError):
    pass


class DockerValidationLifecycle:
    operational = False
    restore_authorized = False
    destination = '/var/lib/postgresql'
    pgdata = '/var/lib/postgresql/18/docker'

    def __init__(self, *, directory_fd, lock_fd, operation, source_volume,
                 validation_volume, image_id, role, gate, approved_image_config, runner=subprocess.run):
        directory = os.fstat(directory_fd)
        lock = os.fstat(lock_fd)
        volume = re.compile(r'[A-Za-z0-9][A-Za-z0-9_.-]{0,127}\Z')
        if (not stat.S_ISDIR(directory.st_mode) or directory.st_uid != os.geteuid()
                or stat.S_IMODE(directory.st_mode) != 0o700
                or not stat.S_ISREG(lock.st_mode) or lock.st_uid != os.geteuid()
                or not isinstance(operation, str) or not _OPERATION.fullmatch(operation)
                or not all(isinstance(v, str) and volume.fullmatch(v) for v in (source_volume, validation_volume))
                or source_volume == validation_volume or not isinstance(image_id, str)
                or not _ID.fullmatch(image_id) or not isinstance(role, str)
                or not re.fullmatch(r'[A-Za-z_][A-Za-z_0-9]{0,62}', role)
                or not isinstance(approved_image_config, dict)
                or set(approved_image_config) != {'Entrypoint', 'Cmd', 'User', 'Env'}
                or not isinstance(approved_image_config['Entrypoint'], list)
                or not isinstance(approved_image_config['Cmd'], list)
                or not isinstance(approved_image_config['User'], str)
                or not isinstance(approved_image_config['Env'], list)
                or any(not isinstance(x, str) for k in ('Entrypoint', 'Cmd', 'Env') for x in approved_image_config[k])
                or len({x.partition('=')[0] for x in approved_image_config['Env']}) != len(approved_image_config['Env'])
                or not callable(gate) or not callable(runner)):
            raise LifecycleError('invalid lifecycle configuration')
        self.fd, self.lock_fd = directory_fd, lock_fd
        self.operation, self.source, self.volume = operation, source_volume, validation_volume
        self.image, self.role, self.gate, self.runner = image_id, role, gate, runner
        self.approved = json.loads(json.dumps(approved_image_config))
        self.name = 'username-validation-' + hashlib.sha256(operation.encode()).hexdigest()

    def _run(self, args):
        try:
            r = self.runner(_DOCKER + args, env=_ENV, stdout=subprocess.PIPE,
                            stderr=subprocess.DEVNULL, check=False, timeout=5 if args[0] == 'exec' else 300)
            if r.returncode or not isinstance(r.stdout, bytes) or len(r.stdout) > 8 * 1024 * 1024:
                raise ValueError()
            return r.stdout
        except Exception:
            raise LifecycleError('Docker command failed') from None

    def _record(self, name, value):
        raw = json.dumps(value, sort_keys=True, separators=(',', ':')).encode()
        try:
            fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=self.fd)
        except FileNotFoundError:
            temp = '.validation-' + os.urandom(16).hex()
            fd = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=self.fd)
            try:
                with os.fdopen(fd, 'wb', closefd=False) as f:
                    f.write(raw)
                    f.flush()
                    os.fsync(fd)
                os.link(temp, name, src_dir_fd=self.fd, dst_dir_fd=self.fd, follow_symlinks=False)
                os.fsync(self.fd)
            finally:
                os.close(fd)
                os.unlink(temp, dir_fd=self.fd)
                os.fsync(self.fd)
            return
        try:
            st = os.fstat(fd)
            if (not stat.S_ISREG(st.st_mode) or st.st_uid != os.geteuid()
                    or stat.S_IMODE(st.st_mode) != 0o600 or st.st_nlink not in (1, 2)
                    or st.st_size > 65536 or os.read(fd, 65537) != raw):
                raise LifecycleError('evidence identity mismatch')
            if st.st_nlink == 2:
                matches = []
                for entry in os.listdir(self.fd):
                    if re.fullmatch(r'\.validation-[0-9a-f]{32}', entry):
                        candidate = os.stat(entry, dir_fd=self.fd, follow_symlinks=False)
                        if (candidate.st_dev, candidate.st_ino) == (st.st_dev, st.st_ino):
                            matches.append(entry)
                if len(matches) != 1:
                    raise LifecycleError('invalid evidence link')
                os.fsync(self.fd)
                os.unlink(matches[0], dir_fd=self.fd)
                os.fsync(self.fd)
            current = os.stat(name, dir_fd=self.fd, follow_symlinks=False)
            st = os.fstat(fd)
            if st.st_nlink != 1 or (current.st_dev, current.st_ino) != (st.st_dev, st.st_ino):
                raise LifecycleError('evidence identity mismatch')
        finally:
            os.close(fd)

    def _exists(self, name):
        try:
            os.stat(name, dir_fd=self.fd, follow_symlinks=False)
            return True
        except FileNotFoundError:
            return False

    def _verify(self):
        try:
            if self.gate() is not True:
                raise ValueError()
            images = json.loads(self._run(['image', 'inspect', 'sha256:' + self.image]))
            if not isinstance(images, list) or len(images) != 1 or images[0]['Id'] != 'sha256:' + self.image:
                raise ValueError()
            config = images[0]['Config']
            if any(config.get(k) != value for k, value in self.approved.items()):
                raise ValueError()
            image_env = config['Env'] or []
            pg_image_env = [x for x in image_env if x.startswith(('POSTGRES_', 'PGDATA='))]
            if pg_image_env != ['PGDATA=' + self.pgdata] or set((config['Volumes'] or {}).keys()) != {self.destination}:
                raise ValueError()
            names = self._run(['volume', 'ls', '--quiet']).decode().splitlines()
            if len(names) != len(set(names)) or any(not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.-]{0,127}', n) for n in names):
                raise ValueError()
            if self.source not in names:
                raise ValueError()
            source_rows = json.loads(self._run(['volume', 'inspect', self.source]))
            if not isinstance(source_rows, list) or len(source_rows) != 1:
                raise ValueError()
            source = source_rows[0]
            source_path = source['Mountpoint']
            if (source['Name'] != self.source or source['Driver'] != 'local'
                    or source.get('Options') not in (None, {}) or not isinstance(source_path, str)
                    or not os.path.isabs(source_path) or os.path.normpath(source_path) != source_path):
                raise ValueError()
            source_path = os.path.realpath(source_path)
            source_stat = os.stat(source_path)
            if not stat.S_ISDIR(source_stat.st_mode):
                raise ValueError()
            self._record('validation-source.json', {'name': self.source, 'mountpoint': source_path,
                         'created': source['CreatedAt'], 'dev': source_stat.st_dev, 'ino': source_stat.st_ino})
            v = None
            if self.volume in names:
                if not self._exists('validation-volume-create-intent.json'):
                    raise ValueError()
                self._record('validation-volume-create-intent.json', {'operation': self.operation, 'name': self.volume})
                rows = json.loads(self._run(['volume', 'inspect', self.volume]))
                if not isinstance(rows, list) or len(rows) != 1:
                    raise ValueError()
                v = rows[0]
                path = v['Mountpoint']
                if (v['Name'] != self.volume or v['Driver'] != 'local' or v.get('Options') not in (None, {})
                        or (v.get('Labels') or {}).get('username-migration.operation') != self.operation
                        or not isinstance(path, str) or not os.path.isabs(path) or os.path.normpath(path) != path):
                    raise ValueError()
                path = os.path.realpath(path)
                volume_stat = os.stat(path)
                if (not stat.S_ISDIR(volume_stat.st_mode)
                        or (source_stat.st_dev, source_stat.st_ino) == (volume_stat.st_dev, volume_stat.st_ino)
                        or os.path.commonpath((source_path, path)) in (source_path, path)):
                    raise ValueError()
                self._record('validation-volume.json', {'name': self.volume, 'mountpoint': path, 'created': v['CreatedAt'],
                             'dev': volume_stat.st_dev, 'ino': volume_stat.st_ino})
            elif self._exists('validation-volume.json'):
                raise ValueError()
            ids = self._run(['container', 'ls', '--all', '--no-trunc', '--quiet']).decode().split()
            if len(ids) != len(set(ids)) or any(not _ID.fullmatch(i) for i in ids):
                raise ValueError()
            rows = json.loads(self._run(['container', 'inspect', *ids])) if ids else []
            if not isinstance(rows, list) or len(rows) != len(ids):
                raise ValueError()
            seen, found = set(), None
            for c in rows:
                cid, state, host, mounts = c['Id'], c['State'], c['HostConfig'], c['Mounts']
                if cid not in ids or cid in seen or not isinstance(mounts, list):
                    raise ValueError()
                seen.add(cid)
                if any(type(state[k]) is not bool for k in ('Running', 'Paused', 'Restarting')):
                    raise ValueError()
                policy = host['RestartPolicy']
                if (not isinstance(policy, dict) or policy.get('Name') not in ('no', 'always', 'unless-stopped', 'on-failure')
                        or type(policy.get('MaximumRetryCount')) is not int or policy['MaximumRetryCount'] < 0):
                    raise ValueError()
                labels = c['Config']['Labels'] or {}
                mine = c.get('Name') == '/' + self.name or labels.get('username-migration.validation') == self.operation
                if mine:
                    env = c['Config']['Env'] or []
                    required = {'POSTGRES_USER=' + self.role, 'POSTGRES_DB=postgres', 'POSTGRES_HOST_AUTH_METHOD=trust', 'PGDATA=' + self.pgdata}
                    pg_env = [x for x in env if x.startswith(('POSTGRES_', 'PGDATA='))]
                    networks = c['NetworkSettings']['Networks']
                    expected_env = [x for x in self.approved['Env'] if x.partition('=')[0] not in
                                    {'POSTGRES_USER', 'POSTGRES_DB', 'POSTGRES_HOST_AUTH_METHOD'}]
                    expected_env += ['POSTGRES_USER=' + self.role, 'POSTGRES_DB=postgres', 'POSTGRES_HOST_AUTH_METHOD=trust']
                    if (found is not None or v is None or c.get('Name') != '/' + self.name
                            or labels.get('username-migration.operation') != self.operation
                            or labels.get('username-migration.validation') != self.operation
                            or c['Image'] != 'sha256:' + self.image or host['NetworkMode'] != 'none'
                            or any(c['Config'].get(k) != self.approved[k] for k in ('Entrypoint', 'Cmd', 'User'))
                            or len(env) != len(expected_env) or set(env) != set(expected_env)
                            or not isinstance(state.get('StartedAt'), str) or not state['StartedAt']
                            or policy['Name'] != 'no' or policy['MaximumRetryCount'] != 0
                            or state['Paused'] or state['Restarting'] or set(pg_env) != required or len(pg_env) != len(required)
                            or not isinstance(networks, dict) or set(networks) - {'none'}
                            or any(networks.get('none', {}).get(k) not in ('', None) for k in ('IPAddress', 'GlobalIPv6Address', 'Gateway', 'IPv6Gateway'))
                            or len(mounts) != 1 or mounts[0]['Type'] != 'volume' or mounts[0]['Name'] != self.volume
                            or mounts[0]['Destination'] != self.destination or mounts[0].get('RW') is not True):
                        raise ValueError()
                    found = c
                else:
                    for mount in mounts:
                        if mount['Type'] == 'volume' and mount['Name'] == self.volume:
                            raise ValueError()
                        if mount['Type'] == 'bind' and v is not None:
                            source = mount['Source']
                            if not isinstance(source, str) or not os.path.isabs(source):
                                raise ValueError()
                            for candidate in (os.path.normpath(source), os.path.realpath(source)):
                                if os.path.commonpath((candidate, path)) in (candidate, path):
                                    raise ValueError()
            if found is None and self._exists('validation-container.json'):
                raise ValueError()
            if found is not None:
                self._record('validation-container.json', {'id': found['Id']})
            if self.gate() is not True:
                raise ValueError()
            return v, found
        except Exception:
            raise LifecycleError('fence or Docker topology cannot be verified') from None

    def ensure_ready(self):
        """Caller must hold the exclusive deployment lock for this entire call.

        This function does not acquire or release that lock. The gate must
        independently verify the deployment fence. Never execute a restore.
        """
        self._record('validation-intent.json', {'version': 1, 'operation': self.operation,
                     'source': self.source, 'volume': self.volume, 'image': self.image,
                     'role': self.role, 'name': self.name, 'destination': self.destination,
                     'pgdata': self.pgdata, 'approved_image_config': self.approved})
        v, c = self._verify()
        if v is None:
            self._record('validation-volume-create-intent.json', {'operation': self.operation, 'name': self.volume})
            try:
                self._run(['volume', 'create', '--driver', 'local', '--label',
                           'username-migration.operation=' + self.operation, self.volume])
            except LifecycleError:
                pass
            v, c = self._verify()
            if v is None:
                raise LifecycleError('volume creation not verified')
        if c is None:
            try:
                self._run(['container', 'create', '--name', self.name, '--label',
                           'username-migration.operation=' + self.operation, '--label',
                           'username-migration.validation=' + self.operation, '--network', 'none',
                           '--restart', 'no', '--mount', 'type=volume,src=' + self.volume + ',dst=' + self.destination,
                           '--env', 'POSTGRES_USER=' + self.role, '--env', 'POSTGRES_DB=postgres',
                           '--env', 'POSTGRES_HOST_AUTH_METHOD=trust', 'sha256:' + self.image])
            except LifecycleError:
                pass
            v, c = self._verify()
            if c is None:
                raise LifecycleError('container creation not verified')
        cid = c['Id']
        if not c['State']['Running']:
            try:
                self._run(['container', 'start', cid])
            except LifecycleError:
                pass
            _, c = self._verify()
            if c is None or c['Id'] != cid or not c['State']['Running']:
                raise LifecycleError('container start not verified')
        # The official entrypoint runs the temporary init server under a shell.
        # Only accept a server after postgres replaces PID 1, and query its identity.
        query = ("SELECT current_database(), current_user, current_setting('data_directory'), "
                 "(current_setting('server_version_num')::int / 10000)::text, "
                 "(SELECT rolsuper FROM pg_roles WHERE rolname = current_user)::text, "
                 "(pg_control_system()).system_identifier::text, pg_postmaster_start_time()::text")
        expected = ('postgres|' + self.role + '|' + self.pgdata + '|18|true|').encode()
        previous = None
        for attempt in range(20):
            _, before = self._verify()
            if before is None or before['Id'] != cid or not before['State']['Running']:
                raise LifecycleError('container identity changed')
            started = before['State']['StartedAt']
            restart_count = before.get('RestartCount')
            if type(restart_count) is not int or restart_count < 0:
                raise LifecycleError('container identity changed')
            try:
                result = self._run(['exec', cid, 'sh', '-c',
                                    'test "$(cat /proc/1/comm)" = postgres && exec "$@"',
                                    'sh', 'psql', '-X', '-A', '-t', '-v', 'ON_ERROR_STOP=1',
                                    '-h', '/var/run/postgresql', '-U', self.role, '-d', 'postgres', '-c', query])
            except LifecycleError:
                result = None
            _, c = self._verify()
            if (c is None or c['Id'] != cid or not c['State']['Running']
                    or c['State']['StartedAt'] != started or c.get('RestartCount') != restart_count):
                raise LifecycleError('container identity changed')
            if (isinstance(result, bytes) and result.startswith(expected)
                    and re.fullmatch(rb'[0-9]{1,20}\|[^|\n]+\n', result[len(expected):])):
                identity = result[len(expected):].strip().decode('ascii')
                if previous == (identity, started, restart_count):
                    self._record('validation-cluster.json', {'system_identifier': identity.split('|')[0]})
                    return cid
                previous = (identity, started, restart_count)
            else:
                previous = None
            if attempt < 19:
                time.sleep(1)
        raise LifecycleError('final PostgreSQL startup or database identity not verified')
