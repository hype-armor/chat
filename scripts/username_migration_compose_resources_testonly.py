"""Synthetic Compose resource inventory; not a restore tool or a writer fence.

Only explicit named volumes, verified read-only bind snapshots, bridge networks,
and static published ports are supported. External resources, anonymous volumes,
unsupported IPAM options, and attachments to containers outside the project are rejected. The
caller must independently exclude writers throughout capture and verification.
A digest must be anchored outside the evidence directory by the caller.
"""
import ipaddress
import json
import os
import re
import stat
import uuid

from username_migration_compose_runtime import ComposeRuntime, _digest, _read_private
from username_migration_compose_binds import _open_without_symlinks

operational = False


class InventoryError(RuntimeError):
    pass


class FakeDocker:
    """Test-double marker only; this marker is not a security boundary."""
    def run(self, args, **kwargs):
        raise NotImplementedError


def _canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=True).encode()


def _inspect(fake, evidence_dir, trusted_digest):
    if not isinstance(fake, FakeDocker) or not re.fullmatch(r'[0-9a-f]{64}', trusted_digest or ''):
        raise ValueError()
    # ComposeRuntime verifies the manifest, config, env, pins, and bind snapshots.
    runtime = ComposeRuntime(evidence_dir, os.path.join(evidence_dir, 'env'),
                             os.path.join(evidence_dir, 'config.json'), fake.run)
    runtime.verify(evidence_dir, trusted_digest)
    manifest = json.loads(_read_private(os.path.join(evidence_dir, 'manifest.json')))
    config = json.loads(_read_private(os.path.join(evidence_dir, 'config.json')))
    operation = manifest['operation']
    if str(uuid.UUID(operation)) != operation or manifest['version'] != 1:
        raise ValueError()
    project, services = config['name'], config['services']
    if not re.fullmatch(r'[a-z0-9][a-z0-9_-]*', project) or not services or set(services) != set(manifest['containers']):
        raise ValueError()

    def run(args):
        result = fake.run(['docker', '--host', 'unix:///var/run/docker.sock', *args],
                          cwd=evidence_dir, env={'PATH': '/usr/bin:/bin', 'HOME': '/nonexistent', 'DOCKER_CONFIG': '/nonexistent'},
                          capture_output=True, text=True, check=False, timeout=60)
        if result.returncode or not isinstance(result.stdout, str) or len(result.stdout) > 8 * 1024 * 1024:
            raise ValueError()
        return result.stdout

    ids = run(['container', 'ls', '--all', '--quiet', '--no-trunc', '--filter', 'label=com.docker.compose.project=' + project]).split()
    expected = {v['container'] for v in manifest['containers'].values()}
    if len(ids) != len(set(ids)) or set(ids) != expected or len(expected) != len(services) or any(not re.fullmatch(r'[0-9a-f]{64}', x) for x in ids):
        raise ValueError()
    records = json.loads(run(['inspect', *sorted(ids)]))
    if not isinstance(records, list) or len(records) != len(ids) or {r['Id'] for r in records} != expected:
        raise ValueError()
    volumes, networks, containers = {}, {}, {}
    binds = {}
    for bind in manifest['binds']:
        key = (bind['service'], bind['index'])
        if key in binds or type(bind['index']) is not int or bind['index'] < 0:
            raise ValueError()
        binds[key] = bind
    used_binds = set()
    volume_defs, network_defs = config.get('volumes', {}), config.get('networks', {})
    for record in records:
        labels = record['Config']['Labels']
        service = labels['com.docker.compose.service']
        if (service not in services or service in containers or labels.get('com.docker.compose.project') != project
                or labels.get('com.docker.compose.container-number') != '1'
                or labels.get('com.docker.compose.oneoff', 'False').lower() != 'false'
                or record['Id'] != manifest['containers'][service]['container']
                or record['Image'] != manifest['containers'][service]['image']):
            raise ValueError()
        spec = services[service]
        if spec.get('network_mode') or spec.get('configs') or spec.get('secrets'):
            raise ValueError()
        mounts = {}
        for index, mount in enumerate(spec.get('volumes', [])):
            if mount.get('type') == 'bind':
                key = (service, index)
                bind = binds[key]
                if (set(mount) - {'type', 'source', 'target', 'read_only', 'bind'}
                        or mount.get('source') != bind['snapshot'] or mount.get('read_only') is not True
                        or mount['target'] in mounts):
                    raise ValueError()
                fd = _open_without_symlinks(bind['source'])
                try:
                    info = os.fstat(fd)
                    if {'device': info.st_dev, 'inode': info.st_ino} != bind['source_identity']:
                        raise ValueError()
                finally:
                    os.close(fd)
                mounts[mount['target']] = {'type': 'bind', 'source': bind['source'], 'rw': False}
                used_binds.add(key)
                continue
            if set(mount) - {'type', 'source', 'target', 'read_only', 'volume'} or mount.get('type') != 'volume':
                raise ValueError()
            key, target = mount['source'], mount['target']
            definition = volume_defs[key]
            if definition.get('external') or set(definition) - {'name', 'driver', 'driver_opts', 'labels'} or mount.get('volume', {}) not in ({}, None):
                raise ValueError()
            name = definition['name']
            if not isinstance(name, str) or not name or target in mounts:
                raise ValueError()
            mounts[target] = {'type': 'volume', 'name': name, 'rw': not mount.get('read_only', False)}
            if name in volumes and volumes[name] != (key, definition):
                raise ValueError()
            volumes[name] = (key, definition)
        actual_mounts = {}
        for mount in record['Mounts']:
            if mount['Destination'] in actual_mounts or type(mount['RW']) is not bool:
                raise ValueError()
            if mount['Type'] == 'bind':
                actual_mounts[mount['Destination']] = {'type': 'bind', 'source': mount['Source'], 'rw': mount['RW']}
            elif mount['Type'] == 'volume' and mount.get('Driver') == 'local' and os.path.isabs(mount.get('Source', '')):
                actual_mounts[mount['Destination']] = {'type': 'volume', 'name': mount['Name'], 'rw': mount['RW']}
            else:
                raise ValueError()
        if actual_mounts != mounts:
            raise ValueError()
        declared_networks = spec.get('networks', {'default': None})
        if not isinstance(declared_networks, dict):
            raise ValueError()
        expected_networks = {}
        for key, attachment in declared_networks.items():
            if attachment is not None and (not isinstance(attachment, dict) or set(attachment) - {'ipv4_address'}):
                raise ValueError()
            definition = network_defs[key]
            if definition.get('external') or set(definition) - {'name', 'driver', 'driver_opts', 'labels', 'ipam'}:
                raise ValueError()
            ipam = definition.get('ipam') or {}
            if not isinstance(ipam, dict) or set(ipam) - {'driver', 'config'} or ipam.get('driver', 'default') != 'default':
                raise ValueError()
            configs = ipam.get('config', [])
            if not isinstance(configs, list) or len(configs) > 1:
                raise ValueError()
            if configs:
                cfg = configs[0]
                if not isinstance(cfg, dict) or set(cfg) - {'subnet', 'gateway'} or 'subnet' not in cfg:
                    raise ValueError()
                subnet = ipaddress.ip_network(cfg['subnet'], strict=True)
                if subnet.version != 4:
                    raise ValueError()
                if 'gateway' in cfg and (ipaddress.ip_address(cfg['gateway']) not in subnet or ipaddress.ip_address(cfg['gateway']) in (subnet.network_address, subnet.broadcast_address)):
                    raise ValueError()
            requested = (attachment or {}).get('ipv4_address')
            if requested is not None:
                if not configs or ipaddress.ip_address(requested) not in subnet or ipaddress.ip_address(requested) in (subnet.network_address, subnet.broadcast_address):
                    raise ValueError()
            name = definition['name']
            if name in expected_networks:
                raise ValueError()
            expected_networks[name] = key
            if name in networks and networks[name] != (key, definition):
                raise ValueError()
            networks[name] = (key, definition)
        actual_networks = record['NetworkSettings']['Networks']
        if set(actual_networks) != set(expected_networks):
            raise ValueError()
        net_ids = {}
        for name, attachment in actual_networks.items():
            nid = attachment['NetworkID']
            if not re.fullmatch(r'[0-9a-f]{64}', nid):
                raise ValueError()
            key = expected_networks[name]
            requested = (declared_networks[key] or {}).get('ipv4_address')
            if requested is not None and attachment.get('IPAddress') != requested:
                raise ValueError()
            net_ids[name] = {'id': nid, 'address': attachment['IPAddress']}
        ports = {}
        for port in spec.get('ports', []):
            if set(port) - {'target', 'published', 'protocol', 'host_ip', 'mode'} or port.get('mode', 'ingress') != 'ingress':
                raise ValueError()
            proto = port.get('protocol', 'tcp')
            target, published, host = str(port['target']), str(port['published']), port.get('host_ip', '0.0.0.0')
            if proto not in ('tcp', 'udp') or not target.isdigit() or not published.isdigit() or not 1 <= int(target) <= 65535 or not 1 <= int(published) <= 65535 or host not in ('0.0.0.0', '127.0.0.1'):
                raise ValueError()
            ports.setdefault(target + '/' + proto, []).append({'HostIp': host, 'HostPort': published})
        observed = record['NetworkSettings']['Ports'] or {}
        # Unpublished exposed ports have null bindings and do not reserve a host port.
        observed = {k: sorted(v, key=lambda x: (x['HostIp'], x['HostPort'])) for k, v in observed.items() if v is not None}
        ports = {k: sorted(v, key=lambda x: (x['HostIp'], x['HostPort'])) for k, v in ports.items()}
        host_ports = record['HostConfig'].get('PortBindings') or {}
        host_ports = {k: sorted(v, key=lambda x: (x['HostIp'], x['HostPort'])) for k, v in host_ports.items() if v is not None}
        if observed != ports or host_ports != ports or len({(p['HostIp'], p['HostPort'], key.split('/')[1]) for key, values in ports.items() for p in values}) != sum(map(len, ports.values())):
            raise ValueError()
        containers[service] = {'id': record['Id'], 'image': record['Image'], 'labels': labels, 'mounts': record['Mounts'], 'networks': net_ids, 'ports': ports}

    if used_binds != set(binds):
        raise ValueError()
    if set(volume_defs) != {key for key, _ in volumes.values()} or set(network_defs) != {key for key, _ in networks.values()}:
        raise ValueError()
    volume_records = {}
    for name, (key, definition) in sorted(volumes.items()):
        found = json.loads(run(['volume', 'inspect', name]))
        if not isinstance(found, list) or len(found) != 1:
            raise ValueError()
        v = found[0]
        labels = v.get('Labels') or {}
        if (v['Name'] != name or v['Driver'] != definition.get('driver', 'local') or v['Driver'] != 'local'
                or (v.get('Options') or {}) != (definition.get('driver_opts') or {})
                or labels.get('com.docker.compose.project') != project or labels.get('com.docker.compose.volume') != key
                or any(labels.get(k) != value for k, value in (definition.get('labels') or {}).items())
                or not isinstance(v['Mountpoint'], str) or not os.path.isabs(v['Mountpoint']) or not v['CreatedAt']):
            raise ValueError()
        if any(m['Source'] != v['Mountpoint'] for c in containers.values() for m in c['mounts'] if m['Type'] == 'volume' and m['Name'] == name):
            raise ValueError()
        volume_records[name] = {k: v.get(k) for k in ('Name', 'Driver', 'Options', 'Mountpoint', 'CreatedAt', 'Labels')}
    network_records = {}
    for name, (key, definition) in sorted(networks.items()):
        found = json.loads(run(['network', 'inspect', name]))
        if not isinstance(found, list) or len(found) != 1:
            raise ValueError()
        n = found[0]
        labels = n.get('Labels') or {}
        attached = {c['id'] for c in containers.values() if name in c['networks']}
        if (n['Name'] != name or not re.fullmatch(r'[0-9a-f]{64}', n['Id']) or n['Driver'] != definition.get('driver', 'bridge') or n['Driver'] != 'bridge'
                or (n.get('Options') or {}) != (definition.get('driver_opts') or {})
                or labels.get('com.docker.compose.project') != project or labels.get('com.docker.compose.network') != key
                or any(labels.get(k) != value for k, value in (definition.get('labels') or {}).items())
                or set((n.get('Containers') or {})) != attached
                or any(c['networks'][name]['id'] != n['Id'] for c in containers.values() if name in c['networks'])):
            raise ValueError()
        configs = (definition.get('ipam') or {}).get('config', [])
        actual_ipam = n['IPAM']
        if (not isinstance(actual_ipam, dict) or actual_ipam.get('Driver') != 'default'
                or actual_ipam.get('Options') not in (None, {})
                or not isinstance(actual_ipam.get('Config'), list) or len(actual_ipam['Config']) != 1):
            raise ValueError()
        actual_cfg = actual_ipam['Config'][0]
        if not isinstance(actual_cfg, dict) or set(actual_cfg) != {'Subnet', 'Gateway'}:
            raise ValueError()
        subnet = ipaddress.ip_network(actual_cfg['Subnet'], strict=True)
        gateway = ipaddress.ip_address(actual_cfg['Gateway'])
        if (subnet.version != 4 or gateway.version != 4 or gateway not in subnet
                or gateway in (subnet.network_address, subnet.broadcast_address)):
            raise ValueError()
        if configs and (actual_cfg['Subnet'] != configs[0]['subnet']
                        or ('gateway' in configs[0] and actual_cfg['Gateway'] != configs[0]['gateway'])):
            raise ValueError()
        addresses = set()
        for record in records:
            attachment = record['NetworkSettings']['Networks'].get(name)
            if attachment is None:
                continue
            address = ipaddress.ip_address(attachment['IPAddress'])
            network_address = ipaddress.ip_interface(n['Containers'][record['Id']]['IPv4Address'])
            if (address.version != 4 or address not in subnet
                    or address in (subnet.network_address, subnet.broadcast_address, gateway)
                    or address in addresses or network_address.ip != address or network_address.network != subnet):
                raise ValueError()
            addresses.add(address)
        network_records[name] = {k: n.get(k) for k in ('Name', 'Id', 'Driver', 'Options', 'Labels', 'Containers', 'IPAM')}
    return {'version': 1, 'operation': operation, 'runtime_digest': trusted_digest,
            'containers': containers, 'volumes': volume_records, 'networks': network_records}


def capture(*, evidence_dir, trusted_digest, fake_docker, output_path):
    """Write a new private canonical inventory and return its external anchor."""
    try:
        first = _inspect(fake_docker, os.fspath(evidence_dir), trusted_digest)
        if first != _inspect(fake_docker, os.fspath(evidence_dir), trusted_digest):
            raise ValueError()
        data = _canonical(first)
        parent = os.path.dirname(os.path.abspath(output_path))
        st = os.lstat(parent)
        if not stat.S_ISDIR(st.st_mode) or st.st_uid != os.geteuid() or st.st_mode & 0o077:
            raise ValueError()
        dfd = os.open(parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            fd = os.open(os.path.basename(output_path), os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=dfd)
            with os.fdopen(fd, 'wb') as f:
                f.write(data)
                f.flush()
                os.fsync(f.fileno())
            os.fsync(dfd)
        finally:
            os.close(dfd)
        return _digest(data)
    except Exception:
        raise InventoryError('Resource inventory capture failed') from None


def verify(*, evidence_dir, trusted_digest, fake_docker, inventory_path, inventory_digest):
    """Compare private anchored evidence with a fresh inspection; this is not a fence."""
    try:
        if not re.fullmatch(r'[0-9a-f]{64}', inventory_digest or ''):
            raise ValueError()
        data = _read_private(inventory_path)
        if _digest(data) != inventory_digest or _canonical(json.loads(data)) != data:
            raise ValueError()
        if _canonical(_inspect(fake_docker, os.fspath(evidence_dir), trusted_digest)) != data:
            raise ValueError()
        return True
    except Exception:
        raise InventoryError('Resource inventory verification failed') from None
