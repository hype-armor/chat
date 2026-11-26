"""Experimental Docker stop fence; no CLI, start, or restore operation.

Requires a trusted host and Docker administrator, a held deployment lock, and
persistent startup gates covering all supervisors. The caller supplies gate
adapters with engage_initial() and verify() methods. These adapters must
verify persistent state, including after reboot. The existing gate primitives do
not by themselves supply that adapter. This module is not an operational
host-reboot or supervisor guarantee. The caller must independently verify that
all effective database endpoints resolve only to the supplied local service;
the database_host argument alone cannot prove application configuration.
The caller must independently verify stop_order against the captured dependency
graph. Every writer must precede its storage dependencies, and PostgreSQL must
be last. This module cannot establish those dependencies or continuous fencing.
The caller must identify application services that require clean drain. A clean
process exit does not prove that external writes have settled. Repeated Docker
inventory checks detect some drift; they are not atomic and do not replace the
startup gates or independently established host isolation. The storage binding
covers only the supplied local named volumes, not bind-backed or remote stores.
"""
import json
import os
import re
import stat
import subprocess
import uuid

from username_migration_systemd_gate import _rename_noreplace


DOCKER_FENCE_INTENT_VERSION = 6


class FenceError(Exception):
    pass


class DockerFence:
    def __init__(self, journal_fd, project, services, database_service, volumes,
                 networks, database_host, gates, runner=subprocess.run, *, operation_id, stop_order,
                 clean_drain_services):
        try:
            if not isinstance(operation_id, str) or str(uuid.UUID(operation_id)) != operation_id:
                raise ValueError()
        except ValueError:
            raise FenceError('Invalid operation ID') from None
        st = os.fstat(journal_fd)
        if not stat.S_ISDIR(st.st_mode) or st.st_uid != os.geteuid() or stat.S_IMODE(st.st_mode) != 0o700:
            raise FenceError('Unsafe journal directory')
        if (not re.fullmatch(r'[a-z0-9][a-z0-9_-]*', project or '') or
            not isinstance(services, dict) or not services or database_service not in services or
            len(set(services.values())) != len(services) or
            any(not re.fullmatch(r'[a-z0-9][a-z0-9_-]*', s) or not re.fullmatch(r'[0-9a-f]{64}', i)
                for s, i in services.items()) or database_host != database_service or
            not volumes or not networks or not gates):
            raise FenceError('Invalid fence inputs or external database')
        if (not isinstance(stop_order, list) or len(stop_order) != len(services) or
                any(not isinstance(s, str) for s in stop_order) or
                len(set(stop_order)) != len(stop_order) or set(stop_order) != set(services) or
                stop_order[-1] != database_service):
            raise FenceError('Invalid stop order')
        if (not isinstance(clean_drain_services, (set, frozenset)) or not clean_drain_services or
                any(not isinstance(s, str) for s in clean_drain_services) or
                not clean_drain_services <= set(services) or database_service in clean_drain_services):
            raise FenceError('Invalid clean-drain services')
        self.clean_drain_services = frozenset(clean_drain_services)
        self.stop_order = tuple(stop_order)
        self.fd, self.project, self.services = journal_fd, project, dict(services)
        self.database_service, self.volumes, self.networks = database_service, set(volumes), set(networks)
        self.gates, self.runner = tuple(gates), runner
        self.operation_id = operation_id
        for gate in self.gates:
            if getattr(gate, 'operation_id', None) != operation_id:
                raise FenceError('Gate operation mismatch')
            if hasattr(gate, 'fence_directory_identity') and gate.fence_directory_identity() != (st.st_dev, st.st_ino):
                raise FenceError('Gate fence directory mismatch')
        if any(not isinstance(x, str) or not x or '\n' in x for x in self.volumes | self.networks):
            raise FenceError('Invalid volume or network')

    def _run(self, args):
        try:
            r = self.runner(['docker', '--host', 'unix:///var/run/docker.sock', *args],
                            env={'PATH': '/usr/bin:/bin', 'HOME': '/nonexistent', 'DOCKER_CONFIG': '/nonexistent'},
                            capture_output=True, text=True, check=False, timeout=60)
            if r.returncode or not isinstance(r.stdout, str) or len(r.stdout) > 8 * 1024 * 1024:
                raise ValueError()
            return r.stdout
        except Exception:
            raise FenceError('Docker command failed') from None

    def _container_ids(self):
        ids = self._run(['container', 'ls', '--all', '--no-trunc', '--quiet']).split()
        if len(ids) != len(set(ids)) or any(not re.fullmatch(r'[0-9a-f]{64}', i) for i in ids):
            raise FenceError('Invalid Docker inventory')
        return sorted(ids)

    @staticmethod
    def _absolute_path(path):
        if (not isinstance(path, str) or not path.startswith('/') or path.startswith('//') or
                '\0' in path or os.path.normpath(path) != path):
            raise ValueError()
        return path

    @staticmethod
    def _require_isolated_unknown(c, nets):
        # A bridge or custom network can reach host-published storage. Do not
        # infer isolation from empty endpoints on a stopped container or try to
        # resolve container namespace references through a changing inventory.
        host = c['HostConfig']
        if (host['NetworkMode'] != 'none' or set(nets) - {'none'} or
                host['PidMode'] != '' or host['IpcMode'] not in ('private', 'none') or
                host['UTSMode'] != '' or host['CgroupnsMode'] != 'private' or
                host['UsernsMode'] != '' or host['Runtime'] != 'runc' or
                host['Privileged'] is not False or host['PublishAllPorts'] is not False or
                host['PortBindings'] not in (None, {}) or host['Tmpfs'] not in (None, {}) or
                c['NetworkSettings']['Ports'] not in (None, {})):
            raise FenceError('Unknown container isolation not verified')
        if any(host[k] not in (None, []) for k in (
                'Binds', 'Mounts', 'VolumesFrom', 'Links', 'CapAdd', 'SecurityOpt',
                'Devices', 'DeviceCgroupRules', 'DeviceRequests')):
            raise FenceError('Unknown container isolation not verified')
        # Even a read-only socket mount can grant daemon access. An unrelated
        # volume can use driver options to alias a protected path. Docker
        # inspect cannot prove arbitrary external mount sources harmless.
        if c['Mounts']:
            raise FenceError('Unknown container has an external mount')

    def _inventory(self, expected_binding=None):
        ids = self._container_ids()
        if not set(self.services.values()) <= set(ids):
            raise FenceError('Original container missing')
        try:
            mountpoints = set()
            identities = {}
            for volume in sorted(self.volumes):
                details = json.loads(self._run(['volume', 'inspect', volume]))
                if (not isinstance(details, list) or len(details) != 1
                        or details[0].get('Name') != volume or details[0].get('Driver') != 'local'
                        or details[0]['Options'] not in (None, {})
                        or not isinstance(details[0].get('Mountpoint'), str)
                        or not isinstance(details[0].get('CreatedAt'), str)
                        or not details[0]['CreatedAt']):
                    raise ValueError()
                path = self._absolute_path(details[0]['Mountpoint'])
                resolved = os.path.realpath(path)
                if any(os.path.commonpath((resolved, other)) in (resolved, other) for other in mountpoints):
                    raise ValueError()
                labels = details[0]['Labels']
                if labels is not None and (not isinstance(labels, dict) or
                        any(not isinstance(k, str) or not isinstance(v, str) for k, v in labels.items())):
                    raise ValueError()
                identities[volume] = {key: details[0][key] for key in ('Name', 'Driver', 'Mountpoint', 'CreatedAt')}
                identities[volume]['Labels'] = labels
                identities[volume]['ResolvedMountpoint'] = resolved
                mountpoints.add(resolved)
            rows = json.loads(self._run(['container', 'inspect', *ids])) if ids else []
            if not isinstance(rows, list) or len(rows) != len(ids):
                raise ValueError()
            found = {}
            expected = {v: k for k, v in self.services.items()}
            attachments = {cid: {} for cid in expected}
            for c in rows:
                cid = c['Id']
                if cid not in ids or cid in found:
                    raise ValueError()
                found[cid] = c
                state = c['State']
                self._validate_state(state)
                policy = self._policy(c)
                could_start = state['Running'] or policy['Name'] != 'no'
                nets = c['NetworkSettings']['Networks']
                labels = c['Config']['Labels']
                if (not isinstance(nets, dict) or not isinstance(c['Mounts'], list) or
                        (labels is not None and not isinstance(labels, dict))):
                    raise ValueError()
                labels = labels or {}
                if cid not in expected:
                    if could_start:
                        if labels.get('com.docker.compose.project') == self.project:
                            raise FenceError('Unknown deployment container')
                        self._require_isolated_unknown(c, nets)
                    continue
                if (labels.get('com.docker.compose.project') != self.project or
                        labels.get('com.docker.compose.service') != expected[cid] or
                        not set(nets) <= self.networks):
                    raise ValueError()
                for mount in c['Mounts']:
                    mount_type = mount['Type']
                    if mount_type == 'bind':
                        source = self._absolute_path(mount['Source'])
                        for candidate in (source, os.path.realpath(source)):
                            if any(os.path.commonpath((candidate, path)) in (candidate, path) for path in mountpoints):
                                raise ValueError()
                    elif mount_type == 'volume':
                        name = mount['Name']
                        if name not in self.volumes:
                            continue
                        destination = self._absolute_path(mount['Destination'])
                        if (destination in attachments[cid] or mount['Driver'] != 'local' or
                                mount['Source'] != identities[name]['Mountpoint'] or type(mount['RW']) is not bool):
                            raise ValueError()
                        attachments[cid][destination] = {'name': name, 'rw': mount['RW']}
                    elif mount_type != 'tmpfs':
                        raise ValueError()
            used = {mount['name'] for entries in attachments.values() for mount in entries.values()}
            if used != self.volumes or not attachments[self.services[self.database_service]]:
                raise ValueError()
            if self._container_ids() != ids:
                raise FenceError('Docker inventory changed during inspection')
            binding = {'container_ids': ids, 'volumes': identities, 'protected_mounts': attachments}
            if expected_binding is not None and binding != expected_binding:
                raise FenceError('Docker fence inventory binding changed')
            return found, binding
        except FenceError:
            raise
        except Exception:
            raise FenceError('Unsafe or ambiguous Docker inventory') from None

    @staticmethod
    def _validate_state(state):
        if not isinstance(state, dict) or any(type(state.get(k)) is not bool for k in ('Running', 'Paused', 'Restarting', 'Dead')):
            raise FenceError('Ambiguous container state')
        status = state.get('Status')
        if not isinstance(status, str):
            raise FenceError('Ambiguous container state')
        # Docker reports Running=true for paused and restarting containers.
        combinations = {
            'created': (False, False, False, False),
            'running': (True, False, False, False),
            'paused': (True, True, False, False),
            'restarting': (True, False, True, False),
            'exited': (False, False, False, False),
            'dead': (False, False, False, True),
        }
        if status not in combinations:
            raise FenceError('Unsupported Docker container status: ' + status)
        if tuple(state[k] for k in ('Running', 'Paused', 'Restarting', 'Dead')) != combinations[status]:
            raise FenceError('Ambiguous container state')
        if status == 'dead':
            raise FenceError('Dead container state')

    @staticmethod
    def _policy(c):
        p = c['HostConfig']['RestartPolicy']
        if (not isinstance(p, dict) or set(p) != {'Name', 'MaximumRetryCount'} or
            p['Name'] not in ('no', 'always', 'unless-stopped', 'on-failure') or
            type(p['MaximumRetryCount']) is not int or p['MaximumRetryCount'] < 0 or
            (p['Name'] != 'on-failure' and p['MaximumRetryCount'] != 0)):
            raise FenceError('Unsupported restart policy')
        return dict(p)

    @staticmethod
    def _active(state):
        DockerFence._validate_state(state)
        if state['Paused'] or state['Restarting']:
            raise FenceError('Paused or restarting container')
        return state['Running']

    @staticmethod
    def _clean_exit(state):
        if (type(state.get('ExitCode')) is not int or state['ExitCode'] != 0 or
                state.get('OOMKilled') is not False or state.get('Error') != ''):
            raise FenceError('Application did not drain cleanly')

    def _journal(self, inventory, binding):
        try:
            fd = os.open('docker-fence.json', os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=self.fd)
        except FileNotFoundError:
            running = sorted(s for s in self.clean_drain_services if self._active(inventory[self.services[s]]['State']))
            data = {'version': DOCKER_FENCE_INTENT_VERSION, 'operation_id': self.operation_id,
                    'project': self.project, 'services': self.services,
                    'clean_drain_services': sorted(self.clean_drain_services), 'drain_initially_running': running,
                    'stop_order': list(self.stop_order),
                    'database': self.database_service, 'inventory': binding,
                    'networks': sorted(self.networks),
                    'policies': {i: self._policy(inventory[i]) for i in self.services.values()}}
            raw = json.dumps(data, sort_keys=True, separators=(',', ':')).encode()
            if len(raw) > 65536:
                raise FenceError('Docker fence intent exceeds size limit')
            temp = '.docker-fence-' + os.urandom(16).hex()
            fd = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=self.fd)
            try:
                with os.fdopen(fd, 'wb', closefd=False) as f:
                    f.write(raw); f.flush(); os.fsync(fd)
                _rename_noreplace(self.fd, temp, 'docker-fence.json')
                os.fsync(self.fd)
            finally:
                os.close(fd)
            return data
        try:
            st = os.fstat(fd)
            if not stat.S_ISREG(st.st_mode) or st.st_uid != os.geteuid() or stat.S_IMODE(st.st_mode) != 0o600 or st.st_nlink != 1 or st.st_size > 65536:
                raise ValueError()
            with os.fdopen(fd, 'r', closefd=False) as f:
                data = json.load(f)
            if (set(data) != {'version', 'operation_id', 'project', 'services', 'database', 'inventory', 'networks', 'policies', 'stop_order', 'clean_drain_services', 'drain_initially_running'} or
                data['version'] != DOCKER_FENCE_INTENT_VERSION or data['clean_drain_services'] != sorted(self.clean_drain_services) or
                not isinstance(data['drain_initially_running'], list) or
                data['drain_initially_running'] != sorted(set(data['drain_initially_running'])) or
                not set(data['drain_initially_running']) <= self.clean_drain_services or data['stop_order'] != list(self.stop_order) or data['operation_id'] != self.operation_id or data['project'] != self.project or data['services'] != self.services or
                data['database'] != self.database_service or data['inventory'] != binding or
                data['networks'] != sorted(self.networks) or set(data['policies']) != set(self.services.values())):
                raise ValueError()
            for policy in data['policies'].values():
                self._policy({'HostConfig': {'RestartPolicy': policy}})
            os.fsync(self.fd)
            return data
        except Exception:
            raise FenceError('Invalid fence journal') from None
        finally:
            os.close(fd)

    def engage(self):
        """Fence and stop writers first, then the database. Never release gates."""
        try:
            try:
                os.stat('docker-fence.json', dir_fd=self.fd, follow_symlinks=False)
                intent_exists = True
            except FileNotFoundError:
                intent_exists = False
            if intent_exists:
                # Never silently recreate a missing gate after Docker effects
                # may have started. This would hide a possible fence breach.
                self._verify_gates()
            else:
                for gate in self.gates:
                    gate.engage_initial()
                self._verify_gates()
            inventory, binding = self._inventory()
            journal = self._journal(inventory, binding)
            self._inventory(binding)
            for cid in sorted(self.services.values()):
                self._verify_gates()
                self._run(['container', 'update', '--restart', 'no', cid])
                current, _ = self._inventory(binding)
                if self._policy(current[cid]) != {'Name': 'no', 'MaximumRetryCount': 0}:
                    raise FenceError('Restart policy mismatch')
            self._verify_gates()
            stopped = []
            for service in self.stop_order:
                cid = self.services[service]
                current, _ = self._inventory(binding)
                if any(any(current[i]['State'][k] for k in ('Running', 'Paused', 'Restarting')) for i in stopped):
                    raise FenceError('Previously stopped container active')
                for prior in self.stop_order[:len(stopped)]:
                    if prior in self.clean_drain_services:
                        self._active(current[self.services[prior]]['State'])
                        self._clean_exit(current[self.services[prior]]['State'])
                if any(self._policy(current[i]) != {'Name': 'no', 'MaximumRetryCount': 0} for i in self.services.values()):
                    raise FenceError('Restart policy mismatch')
                self._verify_gates()
                if service in self.clean_drain_services:
                    active = self._active(current[cid]['State'])
                    if service not in journal['drain_initially_running'] and active:
                        raise FenceError('Initially stopped application became active')
                    if not active:
                        # An earlier crash can leave an already-stopped writer in
                        # an unclean state before this operation begins.
                        self._clean_exit(current[cid]['State'])
                # Do not let Docker kill a declared clean-drain writer. The
                # client timeout still bounds this call; a lost reply is uncertain
                # and must be resolved by a later inventory and clean-exit check.
                stop_time = '-1' if service in self.clean_drain_services else '30'
                self._run(['container', 'stop', '--time', stop_time, cid])
                current, _ = self._inventory(binding)
                if any(current[cid]['State'][k] for k in ('Running', 'Paused', 'Restarting')):
                    raise FenceError('Container remains active')
                if service in self.clean_drain_services:
                    self._active(current[cid]['State'])
                    self._clean_exit(current[cid]['State'])
                stopped.append(cid)
            current, _ = self._inventory(binding)
            if any(any(current[i]['State'][k] for k in ('Running', 'Paused', 'Restarting')) or
                   self._policy(current[i]) != {'Name': 'no', 'MaximumRetryCount': 0} for i in self.services.values()):
                raise FenceError('Fence verification failed')
            for service in self.clean_drain_services:
                self._active(current[self.services[service]]['State'])
                self._clean_exit(current[self.services[service]]['State'])
            self._verify_gates()
        except FenceError:
            raise
        except Exception:
            raise FenceError('Fence engagement failed') from None

    def _verify_gates(self):
        for gate in self.gates:
            if gate.verify() is not True:
                raise FenceError('Startup gate verification failed')
