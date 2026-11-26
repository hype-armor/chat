"""Synthetic stop-order/fence integration only. Never authorizes operational use.

The independent verifier must bind the exact operation, config digest, profiles,
classifications, PostgreSQL service, and explicit order to captured evidence.
The graph cannot prove undeclared dependencies or exclude external writers.
Only the fake gate and fake Docker runner defined here are accepted.
"""
import hashlib
import json
from types import SimpleNamespace

from username_migration_docker_fence import DockerFence
from username_migration_stop_order_testonly import derive_stop_order, StopOrderError

operational = False


class FakeGate:
    def __init__(self, operation_id):
        self.operation_id = operation_id
        self.engaged = False

    def engage_initial(self):
        self.engaged = True

    def verify(self):
        return self.engaged


class FakeDocker:
    """In-memory Docker simulation. This class cannot call a Docker daemon."""
    def __init__(self, services, database):
        self.calls = []
        self.rows = {}
        for service, cid in services.items():
            self.rows[cid] = {
                'Id': cid,
                'Config': {'Labels': {'com.docker.compose.project': 'chat', 'com.docker.compose.service': service}},
                'State': {'Status': 'running', 'Running': True, 'Paused': False, 'Restarting': False,
                          'Dead': False, 'ExitCode': 0, 'OOMKilled': False, 'Error': ''},
                'Mounts': [{'Type': 'volume', 'Name': 'pg', 'Driver': 'local', 'Source': '/fake/pg',
                            'Destination': '/var/lib/postgresql', 'RW': True}] if service == database else [],
                'NetworkSettings': {'Networks': {'chat_net': {}}, 'Ports': {}},
                'HostConfig': {'NetworkMode': 'chat_net', 'RestartPolicy': {'Name': 'always', 'MaximumRetryCount': 0}},
            }

    def __call__(self, args, **kwargs):
        self.calls.append(list(args))
        cmd = args[3:]
        if cmd[:3] == ['container', 'ls', '--all']:
            out = '\n'.join(self.rows)
        elif cmd[:2] == ['volume', 'inspect'] and cmd[2:] == ['pg']:
            out = json.dumps([{'Name': 'pg', 'Driver': 'local', 'Options': None,
                               'Mountpoint': '/fake/pg', 'CreatedAt': 'synthetic', 'Labels': {}}])
        elif cmd[:2] == ['container', 'inspect']:
            out = json.dumps([self.rows[cid] for cid in cmd[2:]])
        elif cmd[:2] == ['container', 'update']:
            self.rows[cmd[-1]]['HostConfig']['RestartPolicy'] = {'Name': 'no', 'MaximumRetryCount': 0}
            out = cmd[-1]
        elif cmd[:2] == ['container', 'stop']:
            self.rows[cmd[-1]]['State'].update(Status='exited', Running=False)
            out = cmd[-1]
        else:
            raise ValueError('Unsupported fake command')
        return SimpleNamespace(returncode=0, stdout=out)


class OrderedFakeFence:
    """Revalidate anchored input immediately before constructing and engaging a fence.

    Inputs remain caller-owned so changes are detected on each engagement. The
    verifier is an independent test fixture, not an operational trust mechanism.
    """
    def __init__(self, *, journal_fd, config_bytes, operation, profiles, classifications,
                 postgres, explicit_order, verify_anchor, services, gates, runner,
                 clean_drain_services):
        self.journal_fd = journal_fd
        self.config_bytes = config_bytes
        self.operation = operation
        self.profiles = profiles
        self.classifications = classifications
        self.postgres = postgres
        self.explicit_order = explicit_order
        self.verify_anchor = verify_anchor
        self.services = services
        self.gates = gates
        self.runner = runner
        self.clean_drain_services = clean_drain_services
        self._binding = self._validate()

    def _validate(self):
        if type(self.runner) is not FakeDocker or not isinstance(self.gates, (list, tuple)) or not self.gates or any(type(g) is not FakeGate for g in self.gates):
            raise StopOrderError('Only fake gates and fake Docker are permitted')
        if not isinstance(self.explicit_order, (list, tuple)):
            raise StopOrderError('An explicit order is required')
        try:
            profiles = tuple(self.profiles)
            roles = tuple(tuple(entry) for entry in self.classifications)
            order = tuple(self.explicit_order)
            digest = hashlib.sha256(self.config_bytes).hexdigest()
            binding = (self.operation, digest, profiles, roles, self.postgres, order)
            if self.verify_anchor(*binding) is not True:
                raise StopOrderError('Evidence binding not verified')
            derived = derive_stop_order(config_bytes=self.config_bytes, operation=self.operation,
                profiles=profiles, classifications=roles, postgres=self.postgres,
                explicit_order=order, verify_evidence=lambda op, sha, active:
                    (op, sha, active) == binding[:3])
            if derived != order or set(self.services) != set(order):
                raise StopOrderError('Fence service or order mismatch')
            if any(g.operation_id != self.operation for g in self.gates):
                raise StopOrderError('Gate operation mismatch')
            return binding
        except StopOrderError:
            raise
        except Exception:
            raise StopOrderError('Invalid evidence binding') from None

    def engage(self):
        if self._validate() != self._binding:
            raise StopOrderError('Evidence or order changed')
        fence = DockerFence(self.journal_fd, 'chat', self.services, self.postgres,
                            {'pg'}, {'chat_net'}, self.postgres, self.gates, self.runner,
                            operation_id=self.operation, stop_order=list(self._binding[-1]),
                            clean_drain_services=self.clean_drain_services)
        fence.engage()
