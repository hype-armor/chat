"""Verify retained resources against independently anchored inventory evidence.

This fake-Docker-only experiment is not operational authorization or a fence.
A trusted administrator must anchor the digest independently and exclude all
Docker writers during capture and verification. Volume identity uses Docker's
inspect fields, not an immutable volume ID; a privileged administrator can
forge them. No command creates, removes, or starts resources.
"""
import ipaddress
import json
import os
import re
import uuid

from username_migration_compose_resources_testonly import FakeDocker, _canonical
from username_migration_compose_runtime import _digest, _read_private

operational = False


class RetainedResourcesError(RuntimeError):
    pass


def verify(*, inventory_path, inventory_digest, operation, project, fake_docker,
           expected_runtime_digest=None, replacements=None, replacement_verifier=None):
    """Check retained resources, optionally binding them to anchored runtime evidence.

    A recreation caller must supply its independently verified runtime digest.
    The default preserves verification for callers that only inspect resources.
    For each replacement, the injected verifier must return exactly True after
    confirming the ID is stopped and bound to this operation and service. It is
    responsible for independent verification, not merely checking labels.
    Networked replacements must have fully observed endpoints. A created but
    not started replacement without endpoints is unsupported and fails closed;
    this experiment does not assume Docker's pre-start network behavior.
    """
    try:
        if not isinstance(fake_docker, FakeDocker):
            raise ValueError()
        if not isinstance(inventory_digest, str) or not re.fullmatch(r'[0-9a-f]{64}', inventory_digest):
            raise ValueError()
        if not isinstance(operation, str) or str(uuid.UUID(operation)) != operation:
            raise ValueError()
        if not isinstance(project, str) or not re.fullmatch(r'[a-z0-9][a-z0-9_-]*', project):
            raise ValueError()
        data = _read_private(inventory_path)
        evidence = json.loads(data)
        if _digest(data) != inventory_digest or _canonical(evidence) != data:
            raise ValueError()
        if (not isinstance(evidence, dict) or set(evidence) != {'version', 'operation', 'runtime_digest', 'containers', 'volumes', 'networks'}
                or type(evidence['version']) is not int or evidence['version'] != 1
                or evidence['operation'] != operation or not isinstance(evidence['runtime_digest'], str)
                or not re.fullmatch(r'[0-9a-f]{64}', evidence['runtime_digest'])):
            raise ValueError()
        if expected_runtime_digest is not None and (
                not isinstance(expected_runtime_digest, str)
                or not re.fullmatch(r'[0-9a-f]{64}', expected_runtime_digest)
                or evidence['runtime_digest'] != expected_runtime_digest):
            raise ValueError()
        containers, volumes, networks = (evidence[k] for k in ('containers', 'volumes', 'networks'))
        if not all(isinstance(x, dict) for x in (containers, volumes, networks)) or not containers:
            raise ValueError()
        ids = set()
        for service, c in containers.items():
            if not isinstance(service, str) or not service or not isinstance(c, dict):
                raise ValueError()
            cid = c['id']
            if not isinstance(cid, str) or not re.fullmatch(r'[0-9a-f]{64}', cid) or cid in ids:
                raise ValueError()
            ids.add(cid)
            if c['labels'].get('com.docker.compose.project') != project or c['labels'].get('com.docker.compose.service') != service:
                raise ValueError()
            if not isinstance(c['mounts'], list) or not isinstance(c['networks'], dict):
                raise ValueError()
        if replacements is None:
            replacements = {}
        if not isinstance(replacements, dict):
            raise ValueError()
        if replacements and (expected_runtime_digest is None or not callable(replacement_verifier)):
            raise ValueError()
        replacement_ids = set()
        for service, cid in replacements.items():
            if (service not in containers or not isinstance(cid, str)
                    or not re.fullmatch(r'[0-9a-f]{64}', cid)
                    or cid in ids or cid in replacement_ids):
                raise ValueError()
            if replacement_verifier(operation=operation, project=project,
                                    service=service, container_id=cid) is not True:
                raise ValueError()
            replacement_ids.add(cid)

        def run(args):
            result = fake_docker.run(['docker', '--host', 'unix:///var/run/docker.sock', *args],
                                     cwd=os.path.dirname(os.path.abspath(inventory_path)),
                                     env={'PATH': '/usr/bin:/bin', 'HOME': '/nonexistent', 'DOCKER_CONFIG': '/nonexistent'},
                                     capture_output=True, text=True, check=False, timeout=60)
            if result.returncode or not isinstance(result.stdout, str) or len(result.stdout) > 8 * 1024 * 1024:
                raise ValueError()
            return result.stdout
        replacement_records = {}
        for service, cid in replacements.items():
            found = json.loads(run(['inspect', cid]))
            if not isinstance(found, list) or len(found) != 1 or not isinstance(found[0], dict):
                raise ValueError()
            record = found[0]
            if (record.get('Id') != cid or record.get('State', {}).get('Running') is not False
                    or record.get('Mounts') != containers[service]['mounts']):
                raise ValueError()
            observed = record['NetworkSettings']['Networks']
            if not isinstance(observed, dict) or set(observed) != set(containers[service]['networks']):
                raise ValueError()
            replacement_records[service] = observed
        for name, expected in volumes.items():
            fields = {'Name', 'Driver', 'Options', 'Mountpoint', 'CreatedAt', 'Labels'}
            if not isinstance(name, str) or not name or not isinstance(expected, dict) or set(expected) != fields:
                raise ValueError()
            if (expected['Name'] != name or expected['Driver'] != 'local' or not expected['CreatedAt']
                    or not isinstance(expected['Mountpoint'], str) or not os.path.isabs(expected['Mountpoint'])
                    or not isinstance(expected['Labels'], dict) or expected['Labels'].get('com.docker.compose.project') != project
                    or not expected['Labels'].get('com.docker.compose.volume')):
                raise ValueError()
            allowed = {c['id'] for c in containers.values() if any(m.get('Type') == 'volume' and m.get('Name') == name and m.get('Source') == expected['Mountpoint'] for m in c['mounts'])}
            if not allowed:
                raise ValueError()
            allowed |= {replacements[service] for service, c in containers.items()
                        if service in replacements and c['id'] in allowed}
            found = json.loads(run(['volume', 'inspect', name]))
            if not isinstance(found, list) or len(found) != 1 or not isinstance(found[0], dict) or {k: found[0].get(k) for k in fields} != expected:
                raise ValueError()
            attached = run(['container', 'ls', '--all', '--quiet', '--no-trunc', '--filter', 'volume=' + name]).split()
            if (len(attached) != len(set(attached)) or not set(attached) <= allowed
                    or any(cid not in attached for service, cid in replacements.items()
                           if any(m.get('Type') == 'volume' and m.get('Name') == name
                                  for m in containers[service]['mounts']))
                    or any(c['id'] in attached and replacements.get(service) in attached
                           for service, c in containers.items() if service in replacements)):
                raise ValueError()
        for name, expected in networks.items():
            fields = {'Name', 'Id', 'Driver', 'Options', 'Labels', 'Containers', 'IPAM'}
            if not isinstance(name, str) or not name or not isinstance(expected, dict) or set(expected) != fields:
                raise ValueError()
            if (expected['Name'] != name or not isinstance(expected['Id'], str) or not re.fullmatch(r'[0-9a-f]{64}', expected['Id'])
                    or expected['Driver'] != 'bridge' or not isinstance(expected['Labels'], dict)
                    or expected['Labels'].get('com.docker.compose.project') != project
                    or not expected['Labels'].get('com.docker.compose.network') or not isinstance(expected['Containers'], dict)):
                raise ValueError()
            allowed = {c['id'] for c in containers.values() if name in c['networks'] and c['networks'][name]['id'] == expected['Id']}
            if not allowed or set(expected['Containers']) != allowed:
                raise ValueError()
            replacement_allowed = {replacements[service] for service, c in containers.items()
                                   if service in replacements and c['id'] in allowed}
            found = json.loads(run(['network', 'inspect', name]))
            if not isinstance(found, list) or len(found) != 1 or not isinstance(found[0], dict):
                raise ValueError()
            actual = found[0]
            if any(actual.get(k) != expected[k] for k in fields - {'Containers'}):
                raise ValueError()
            attachments = actual.get('Containers')
            if (not isinstance(attachments, dict) or not set(attachments) <= allowed | replacement_allowed
                    or any(not isinstance(v, dict) for v in attachments.values())
                    or any(attachments[k] != expected['Containers'][k] for k in attachments.keys() & allowed)
                    or not replacement_allowed <= set(attachments)
                    or any(c['id'] in attachments and replacements.get(service) in attachments
                           for service, c in containers.items() if service in replacements)):
                raise ValueError()
            if replacement_allowed:
                ipam = expected['IPAM']
                if (not isinstance(ipam, dict) or ipam.get('Driver') != 'default'
                        or ipam.get('Options') not in (None, {})
                        or not isinstance(ipam.get('Config'), list) or len(ipam['Config']) != 1):
                    raise ValueError()
                cfg = ipam['Config'][0]
                if not isinstance(cfg, dict) or set(cfg) != {'Subnet', 'Gateway'}:
                    raise ValueError()
                subnet = ipaddress.ip_network(cfg['Subnet'], strict=True)
                gateway = ipaddress.ip_address(cfg['Gateway'])
                if subnet.version != 4 or gateway not in subnet or gateway in (subnet.network_address, subnet.broadcast_address):
                    raise ValueError()
                addresses = set()
                for cid, endpoint in attachments.items():
                    interface = ipaddress.ip_interface(endpoint['IPv4Address'])
                    address = interface.ip
                    if (interface.version != 4 or interface.network != subnet or address in addresses
                            or address in (subnet.network_address, subnet.broadcast_address, gateway)):
                        raise ValueError()
                    addresses.add(address)
                    if cid in replacement_allowed:
                        service = next(s for s, rid in replacements.items() if rid == cid)
                        observation = replacement_records[service][name]
                        if (not isinstance(observation, dict) or observation.get('NetworkID') != expected['Id']
                                or observation.get('IPAddress') != str(address)):
                            raise ValueError()
                        # Endpoint IDs link the two independent inspect results.
                        endpoint_id = endpoint.get('EndpointID')
                        if (not isinstance(endpoint_id, str) or not re.fullmatch(r'[0-9a-f]{64}', endpoint_id)
                                or observation.get('EndpointID') != endpoint_id):
                            raise ValueError()
        if ({m['Name'] for c in containers.values() for m in c['mounts'] if m.get('Type') == 'volume'} != set(volumes)
                or {name for c in containers.values() for name in c['networks']} != set(networks)):
            raise ValueError()
        return True
    except Exception:
        raise RetainedResourcesError('Retained resource verification failed') from None
