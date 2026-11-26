"""Experimental Docker stop fence; no CLI, start, or restore operation.

Requires a trusted host and Docker administrator, a held deployment lock, and
persistent startup gates covering all supervisors. The caller supplies gate
adapters with engage(resume=True) and verify() methods. These adapters must
verify persistent state, including after reboot. The existing gate primitives do
not by themselves supply that adapter. This module is not an operational
host-reboot or supervisor guarantee. The caller must independently verify that
all effective database endpoints resolve only to the supplied local service;
the database_host argument alone cannot prove application configuration.
The caller must independently verify stop_order against the captured dependency
graph. Every writer must precede its storage dependencies, and PostgreSQL must
be last. This module cannot establish those dependencies or continuous fencing.
The caller must identify application services that require clean drain. A clean
process exit does not prove that external writes have settled.
"""
import json
import os
import re
import stat
import subprocess
import uuid

from username_migration_systemd_gate import _rename_noreplace


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

    def _inventory(self, expected_volumes=None):
        ids = self._run(['container', 'ls', '--all', '--no-trunc', '--quiet']).split()
        if len(ids) != len(set(ids)) or any(not re.fullmatch(r'[0-9a-f]{64}', i) for i in ids):
            raise FenceError('Invalid Docker inventory')
        if not set(self.services.values()) <= set(ids):
            raise FenceError('Original container missing')
        try:
            mountpoints = set()
            identities = {}
            for volume in sorted(self.volumes):
                details = json.loads(self._run(['volume', 'inspect', volume]))
                if (not isinstance(details, list) or len(details) != 1
                        or details[0].get('Name') != volume or details[0].get('Driver') != 'local'
                        or details[0].get('Options') not in (None, {})
                        or not isinstance(details[0].get('Mountpoint'), str)
                        or not isinstance(details[0].get('CreatedAt'), str)
                        or not details[0]['CreatedAt']):
                    raise ValueError()
                path = details[0]['Mountpoint']
                if not path.startswith('/') or os.path.normpath(path) != path:
                    raise ValueError()
                labels = details[0].get('Labels')
                if labels is not None and (not isinstance(labels, dict) or
                        any(not isinstance(k, str) or not isinstance(v, str) for k, v in labels.items())):
                    raise ValueError()
                identities[volume] = {key: details[0][key] for key in ('Name', 'Driver', 'Mountpoint', 'CreatedAt')}
                identities[volume]['Labels'] = labels
                mountpoints.add(os.path.realpath(path))
            if expected_volumes is not None and identities != expected_volumes:
                raise ValueError()
            rows = json.loads(self._run(['container', 'inspect', *ids])) if ids else []
            if not isinstance(rows, list) or len(rows) != len(ids):
                raise ValueError()
            found = {}
            expected = {v: k for k, v in self.services.items()}
            protected_ports = {'8080'}
            for c in rows:
                if c.get('Id') in expected:
                    for port_map in ((c.get('NetworkSettings', {}).get('Ports') or {}),
                                     (c.get('HostConfig', {}).get('PortBindings') or {})):
                        for bindings in port_map.values():
                            for binding in bindings or []:
                                if not isinstance(binding, dict) or not isinstance(binding.get('HostPort'), str):
                                    raise ValueError()
                                protected_ports.add(binding['HostPort'])
            for c in rows:
                cid = c['Id']
                if cid not in ids or cid in found:
                    raise ValueError()
                found[cid] = c
                state = c['State']
                self._validate_state(state)
                active = state['Running'] or state['Paused'] or state['Restarting']
                # A stopped unknown container can restart after a reboot.
                could_start = active or self._policy(c)['Name'] != 'no'
                mounts = {m['Name'] for m in c['Mounts'] if m['Type'] == 'volume'}
                if could_start:
                    for mount in c['Mounts']:
                        if mount['Type'] == 'bind':
                            source = mount.get('Source')
                            if not isinstance(source, str) or not source.startswith('/'):
                                raise ValueError()
                            for candidate in (os.path.normpath(source), os.path.realpath(source)):
                                if any(os.path.commonpath((candidate, path)) in (candidate, path) for path in mountpoints):
                                    raise ValueError()
                nets = set(c['NetworkSettings']['Networks'])
                labels = c['Config']['Labels'] or {}
                if cid in expected:
                    if labels.get('com.docker.compose.project') != self.project or labels.get('com.docker.compose.service') != expected[cid] or not nets <= self.networks:
                        raise ValueError()
                elif could_start:
                    # Include every published port of the captured deployment.
                    port_maps = (c['NetworkSettings'].get('Ports') or {}, c['HostConfig'].get('PortBindings') or {})
                    direct = any(p.get('HostPort') in protected_ports for ports in port_maps
                                 for bindings in ports.values() if bindings for p in bindings)
                    if mounts & self.volumes or nets & self.networks or direct or c['HostConfig']['NetworkMode'] == 'host' or labels.get('com.docker.compose.project') == self.project:
                        raise ValueError()
            used = {m['Name'] for cid in expected for m in found[cid]['Mounts'] if m['Type'] == 'volume'}
            db_mounts = {m['Name'] for m in found[self.services[self.database_service]]['Mounts'] if m['Type'] == 'volume'}
            if not self.volumes <= used or not db_mounts & self.volumes:
                raise ValueError()
            return found, identities
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

    def _journal(self, inventory, identities):
        try:
            fd = os.open('docker-fence.json', os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=self.fd)
        except FileNotFoundError:
            running = sorted(s for s in self.clean_drain_services if self._active(inventory[self.services[s]]['State']))
            data = {'version': 5, 'operation_id': self.operation_id, 'project': self.project, 'services': self.services,
                    'clean_drain_services': sorted(self.clean_drain_services), 'drain_initially_running': running,
                    'stop_order': list(self.stop_order),
                    'database': self.database_service, 'volumes': identities,
                    'networks': sorted(self.networks),
                    'policies': {i: self._policy(inventory[i]) for i in self.services.values()}}
            raw = json.dumps(data, sort_keys=True, separators=(',', ':')).encode()
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
            if (set(data) != {'version', 'operation_id', 'project', 'services', 'database', 'volumes', 'networks', 'policies', 'stop_order', 'clean_drain_services', 'drain_initially_running'} or
                data['version'] != 5 or data['clean_drain_services'] != sorted(self.clean_drain_services) or
                not isinstance(data['drain_initially_running'], list) or
                data['drain_initially_running'] != sorted(set(data['drain_initially_running'])) or
                not set(data['drain_initially_running']) <= self.clean_drain_services or data['stop_order'] != list(self.stop_order) or data['operation_id'] != self.operation_id or data['project'] != self.project or data['services'] != self.services or
                data['database'] != self.database_service or data['volumes'] != identities or
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
            inventory, identities = self._inventory()
            journal = self._journal(inventory, identities)
            for cid in sorted(self.services.values()):
                self._run(['container', 'update', '--restart', 'no', cid])
                current, _ = self._inventory(identities)
                if self._policy(current[cid]) != {'Name': 'no', 'MaximumRetryCount': 0}:
                    raise FenceError('Restart policy mismatch')
            self._verify_gates()
            stopped = []
            for service in self.stop_order:
                cid = self.services[service]
                current, _ = self._inventory(identities)
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
                current, _ = self._inventory(identities)
                if any(current[cid]['State'][k] for k in ('Running', 'Paused', 'Restarting')):
                    raise FenceError('Container remains active')
                if service in self.clean_drain_services:
                    self._active(current[cid]['State'])
                    self._clean_exit(current[cid]['State'])
                stopped.append(cid)
            current, _ = self._inventory(identities)
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
