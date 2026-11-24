"""Experimental maintenance container lifecycle; not a migration authorization.

The caller must hold the exclusive deployment lock throughout every call and
trust host and Docker administrators. The gate must continuously fence writers.
Rollback verification must independently prove a durable pre-cutover state.
This module does not validate backups or establish production safety.
"""
import hashlib
import json
import os
import re
import stat
import subprocess

from username_migration_docker_pg_backup import _DOCKER, _ENV, _ID, _OPERATION


class MaintenanceError(RuntimeError):
    pass


class DockerPostgresMaintenance:
    """Create or resume one operation container and remove it only on rollback.

    directory_fd is a private, durable operation directory. stopped_container_ids
    are the exact old containers accepted by UnverifiedDockerCapture. gate and
    rollback callbacks must independently verify their respective durable state.
    Docker command failures can leave effects; retry with the same inputs.
    """

    def __init__(self, *, directory_fd, operation, image_id, volume,
                 stopped_container_ids, gate, runner=subprocess.run):
        st = os.fstat(directory_fd)
        if (not stat.S_ISDIR(st.st_mode) or st.st_uid != os.geteuid() or
                stat.S_IMODE(st.st_mode) != 0o700 or
                not isinstance(operation, str) or not _OPERATION.fullmatch(operation) or
                not isinstance(image_id, str) or not _ID.fullmatch(image_id) or
                not isinstance(volume, str) or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.-]{0,127}', volume) or
                not isinstance(stopped_container_ids, (list, tuple, set)) or
                any(not isinstance(i, str) or not _ID.fullmatch(i) for i in stopped_container_ids) or
                len(set(stopped_container_ids)) != len(stopped_container_ids) or not callable(gate)):
            raise MaintenanceError('invalid maintenance configuration')
        self.fd, self.operation, self.image, self.volume = directory_fd, operation, image_id, volume
        self.stopped, self.gate, self.runner = set(stopped_container_ids), gate, runner
        self.name = 'username-migration-' + hashlib.sha256(operation.encode()).hexdigest()

    def _run(self, args):
        try:
            result = self.runner(_DOCKER + args, env=_ENV, stdout=subprocess.PIPE,
                                 stderr=subprocess.DEVNULL, check=False, timeout=300)
            if result.returncode or not isinstance(result.stdout, bytes) or len(result.stdout) > 8 * 1024 * 1024:
                raise ValueError()
            return result.stdout
        except Exception:
            raise MaintenanceError('Docker command failed') from None

    def _recover_link(self, fd, name, prefix):
        """Remove only the matching temporary link left by interrupted publication."""
        st = os.fstat(fd)
        if st.st_nlink == 2:
            matches = []
            for entry in os.listdir(self.fd):
                if not re.fullmatch(re.escape(prefix) + r'[0-9a-f]{32}', entry):
                    continue
                candidate = os.stat(entry, dir_fd=self.fd, follow_symlinks=False)
                if (candidate.st_dev, candidate.st_ino) == (st.st_dev, st.st_ino):
                    matches.append(entry)
            if len(matches) != 1:
                raise ValueError()
            # Make the published name durable before removing its temporary link.
            os.fsync(self.fd)
            os.unlink(matches[0], dir_fd=self.fd)
            os.fsync(self.fd)
        current = os.stat(name, dir_fd=self.fd, follow_symlinks=False)
        st = os.fstat(fd)
        if (st.st_nlink != 1 or
                (current.st_dev, current.st_ino) != (st.st_dev, st.st_ino)):
            raise ValueError()

    def _intent(self):
        expected = {'version': 1, 'operation': self.operation, 'image': self.image,
                    'volume': self.volume, 'destination': '/var/lib/postgresql',
                    'stopped': sorted(self.stopped), 'name': self.name}
        raw = json.dumps(expected, sort_keys=True, separators=(',', ':')).encode()
        try:
            fd = os.open('postgres-maintenance.json', os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=self.fd)
        except FileNotFoundError:
            temp = '.maintenance-' + os.urandom(16).hex()
            fd = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=self.fd)
            try:
                with os.fdopen(fd, 'wb', closefd=False) as f:
                    f.write(raw); f.flush(); os.fsync(fd)
                os.link(temp, 'postgres-maintenance.json', src_dir_fd=self.fd, dst_dir_fd=self.fd, follow_symlinks=False)
                os.fsync(self.fd)
            finally:
                os.close(fd)
                os.unlink(temp, dir_fd=self.fd)
                os.fsync(self.fd)
            return
        try:
            st = os.fstat(fd)
            if (not stat.S_ISREG(st.st_mode) or st.st_uid != os.geteuid() or
                    stat.S_IMODE(st.st_mode) != 0o600 or st.st_nlink not in (1, 2) or st.st_size > 65536):
                raise ValueError()
            with os.fdopen(fd, 'rb', closefd=False) as f:
                if f.read() != raw:
                    raise ValueError()
            self._recover_link(fd, 'postgres-maintenance.json', '.maintenance-')
        except Exception:
            raise MaintenanceError('invalid maintenance intent') from None
        finally:
            os.close(fd)

    def _bind_id(self, cid):
        """Persist the first verified ID; never accept a replacement container."""
        name = 'postgres-maintenance-id'
        try:
            fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=self.fd)
        except FileNotFoundError:
            temp = '.maintenance-id-' + os.urandom(16).hex()
            fd = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=self.fd)
            try:
                os.write(fd, cid.encode())
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
            if (not stat.S_ISREG(st.st_mode) or st.st_uid != os.geteuid() or
                    stat.S_IMODE(st.st_mode) != 0o600 or st.st_nlink not in (1, 2) or
                    st.st_size != 64 or os.read(fd, 65) != cid.encode()):
                raise ValueError()
            self._recover_link(fd, name, '.maintenance-id-')
        except Exception:
            raise MaintenanceError('container ID does not match intent') from None
        finally:
            os.close(fd)

    def _verify(self):
        """Inspect all containers, including stopped and restartable users."""
        try:
            if self.gate() is not True:
                raise ValueError()
            volumes = json.loads(self._run(['volume', 'inspect', self.volume]))
            if not isinstance(volumes, list) or len(volumes) != 1:
                raise ValueError()
            v = volumes[0]
            path = v['Mountpoint']
            if (v['Name'] != self.volume or v['Driver'] != 'local' or v.get('Options') not in (None, {}) or
                    not isinstance(path, str) or not os.path.isabs(path) or os.path.normpath(path) != path):
                raise ValueError()
            path = os.path.realpath(path)
            ids = self._run(['container', 'ls', '--all', '--no-trunc', '--quiet']).decode().split()
            if len(ids) != len(set(ids)) or any(not _ID.fullmatch(i) for i in ids) or not self.stopped <= set(ids):
                raise ValueError()
            rows = json.loads(self._run(['container', 'inspect', *ids])) if ids else []
            if not isinstance(rows, list) or len(rows) != len(ids):
                raise ValueError()
            found, seen = None, set()
            for c in rows:
                cid = c['Id']
                if cid not in ids or cid in seen:
                    raise ValueError()
                seen.add(cid)
                state, host, mounts = c['State'], c['HostConfig'], c['Mounts']
                if any(type(state[k]) is not bool for k in ('Running', 'Paused', 'Restarting')):
                    raise ValueError()
                active = any(state[k] for k in ('Running', 'Paused', 'Restarting'))
                policy = host['RestartPolicy']
                if (not isinstance(policy, dict) or set(policy) != {'Name', 'MaximumRetryCount'} or
                        policy['Name'] not in ('no', 'always', 'unless-stopped', 'on-failure') or
                        type(policy['MaximumRetryCount']) is not int or policy['MaximumRetryCount'] < 0 or
                        (policy['Name'] != 'on-failure' and policy['MaximumRetryCount'] != 0)):
                    raise ValueError()
                labels = c['Config']['Labels'] or {}
                mine = labels.get('username-migration.operation') == self.operation
                if mine:
                    if (found is not None or cid in self.stopped or c.get('Name') != '/' + self.name or
                            c['Image'] != 'sha256:' + self.image or host['NetworkMode'] != 'none' or
                            policy['Name'] != 'no' or state['Paused'] or state['Restarting'] or
                            not isinstance(c['NetworkSettings']['Networks'], dict) or
                            set(c['NetworkSettings']['Networks']) - {'none'} or
                            any(c['NetworkSettings']['Networks'].get('none', {}).get(k) not in ('', None)
                                for k in ('IPAddress', 'GlobalIPv6Address', 'Gateway', 'IPv6Gateway')) or
                            len(mounts) != 1 or
                            mounts[0]['Type'] != 'volume' or mounts[0]['Name'] != self.volume or
                            mounts[0]['Destination'] != '/var/lib/postgresql' or mounts[0].get('RW') is not True):
                        raise ValueError()
                    found = c
                else:
                    if cid in self.stopped and (active or policy['Name'] != 'no'):
                        raise ValueError()
                    for mount in mounts:
                        if mount['Type'] == 'volume' and mount['Name'] == self.volume:
                            if active or policy['Name'] != 'no' or cid not in self.stopped:
                                raise ValueError()
                        if mount['Type'] == 'bind' and (active or policy['Name'] != 'no'):
                            source = mount['Source']
                            if not isinstance(source, str) or not os.path.isabs(source):
                                raise ValueError()
                            for candidate in (os.path.normpath(source), os.path.realpath(source)):
                                if os.path.commonpath((candidate, path)) in (candidate, path):
                                    raise ValueError()
            if self.gate() is not True:
                raise ValueError()
            return found
        except Exception:
            raise MaintenanceError('fence or Docker topology cannot be verified') from None

    def ensure_ready(self):
        """Persist intent, reconcile create/start, then test local socket readiness."""
        self._intent()
        c = self._verify()
        if c is None:
            try:
                os.stat('postgres-maintenance-id', dir_fd=self.fd, follow_symlinks=False)
            except FileNotFoundError:
                pass
            else:
                raise MaintenanceError('previous maintenance container is missing')
            try:
                self._run(['container', 'create', '--name', self.name, '--label',
                           'username-migration.operation=' + self.operation, '--network', 'none',
                           '--restart', 'no', '--mount',
                           'type=volume,src=' + self.volume + ',dst=/var/lib/postgresql',
                           'sha256:' + self.image])
            except MaintenanceError:
                pass  # A lost response is reconciled by the complete inventory.
            c = self._verify()
            if c is None:
                raise MaintenanceError('container creation not verified')
        cid = c['Id']
        self._bind_id(cid)
        if not c['State']['Running']:
            try:
                self._run(['container', 'start', cid])
            except MaintenanceError:
                pass
            c = self._verify()
            if c is None or c['Id'] != cid or not c['State']['Running']:
                raise MaintenanceError('container start not verified')
        try:
            self._run(['exec', cid, 'pg_isready', '-h', '/var/run/postgresql'])
        finally:
            c = self._verify()
            if c is None or c['Id'] != cid or not c['State']['Running']:
                raise MaintenanceError('container identity changed')
        return cid

    def rollback_remove(self, verify_pre_cutover):
        """Stop and remove only this container under independently verified rollback."""
        if not callable(verify_pre_cutover):
            raise MaintenanceError('rollback verification required')
        self._intent()
        def check():
            if verify_pre_cutover() is not True:
                raise MaintenanceError('rollback state not verified')
            c = self._verify()
            if verify_pre_cutover() is not True:
                raise MaintenanceError('rollback state not verified')
            return c
        c = check()
        if c is None:
            return
        cid = c['Id']
        self._bind_id(cid)
        if c['State']['Running']:
            try:
                self._run(['container', 'stop', cid])
            except MaintenanceError:
                pass
            c = check()
            if c is None or c['Id'] != cid or c['State']['Running']:
                raise MaintenanceError('container stop not verified')
        try:
            self._run(['container', 'rm', cid])
        except MaintenanceError:
            pass
        if check() is not None:
            raise MaintenanceError('container removal not verified')
