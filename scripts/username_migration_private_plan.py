"""Build a conservative private Compose plan; this module does not deploy it.

The caller must authenticate the captured config and bind evidence and verify the
snapshots before use. Host and Docker administrators and same-host processes are
trusted. External writer fencing is separate. Internal networks do not isolate
containers from the Docker host. Images and their commands are trusted; this is
not a sandbox for malicious application code. Never use a plan as commit proof.
"""
import copy
import ipaddress
import re
import uuid


class PlanError(ValueError):
    """The configuration is not supported by the private plan."""


def private_plan(config, operation_id, verified_bind_records=()):
    """Return a new Compose configuration, or reject unsupported input.

    verified_bind_records must be authenticated records from the capture and
    snapshot verification step, not records supplied by an untrusted operator.
    The plan does not inspect files, Docker, or image contents. The exact UUID
    must be unique and reserved by the caller before any plan is deployed.
    """
    try:
        if not isinstance(operation_id, str) or str(uuid.UUID(operation_id)) != operation_id:
            raise ValueError()
    except (ValueError, AttributeError):
        raise PlanError('Invalid operation ID') from None
    if not isinstance(config, dict) or set(config) - {'name', 'services', 'networks', 'volumes'}:
        raise PlanError('Unsupported top-level configuration')
    services = config.get('services')
    networks = config.get('networks', {})
    volumes = config.get('volumes', {})
    if (not isinstance(services, dict) or not {'server', 'postgres'} <= set(services)
            or not isinstance(networks, dict) or not isinstance(volumes, dict)):
        raise PlanError('Missing services or invalid resources')
    # The captured volume name must remain exact after changing the project name.
    for name, spec in volumes.items():
        if (not isinstance(name, str) or not isinstance(spec, dict)
                or set(spec) - {'name', 'external'} or not isinstance(spec.get('name'), str)
                or not re.fullmatch(r'[a-zA-Z0-9][a-zA-Z0-9_.-]*', spec['name'])
                or type(spec.get('external', False)) is not bool):
            raise PlanError('Unsupported volume definition')
    for name, spec in networks.items():
        if (not isinstance(name, str) or not re.fullmatch(r'[a-zA-Z0-9][a-zA-Z0-9_.-]*', name)
                or not isinstance(spec, dict) or set(spec) - {'name', 'driver', 'internal', 'ipam'}
                or spec.get('driver', 'bridge') != 'bridge' or type(spec.get('internal', False)) is not bool):
            raise PlanError('Unsupported or external network')
        ipam = spec.get('ipam', {})
        if (not isinstance(ipam, dict) or set(ipam) - {'driver', 'config'}
                or ipam.get('driver', 'default') != 'default' or not isinstance(ipam.get('config', []), list)):
            raise PlanError('Unsupported IPAM configuration')
        for item in ipam.get('config', []):
            if not isinstance(item, dict) or set(item) != {'subnet'}:
                raise PlanError('Unsupported IPAM subnet')
            try:
                ipaddress.IPv4Network(item['subnet'])
            except (ValueError, TypeError):
                raise PlanError('Invalid IPAM subnet') from None
    try:
        records = list(verified_bind_records)
        approved = {(r['service'], r['index'], r['snapshot']) for r in records}
        if len(approved) != len(records) or any(not isinstance(r, dict) or not isinstance(r.get('snapshot'), str)
                                                or not r['snapshot'].startswith('/') for r in records):
            raise ValueError()
    except (TypeError, KeyError, ValueError):
        raise PlanError('Invalid bind evidence') from None
    used = set()
    plan = copy.deepcopy(config)
    plan['name'] = 'chat-private-' + operation_id
    allowed = {'image', 'environment', 'command', 'entrypoint', 'user', 'working_dir',
               'volumes', 'ports', 'networks', 'depends_on', 'healthcheck', 'restart',
               'profiles', 'expose', 'labels', 'init', 'stop_grace_period'}
    for service, spec in plan['services'].items():
        if (not isinstance(service, str) or not re.fullmatch(r'[a-z][a-z0-9_-]{0,40}', service)
                or not isinstance(spec, dict) or set(spec) - allowed
                or not isinstance(spec.get('image'), str)
                or not re.fullmatch(r'sha256:[0-9a-f]{64}', spec['image'])):
            raise PlanError('Unsupported service or image')
        # Labels can affect external controllers; never transfer them.
        if spec.get('labels'):
            raise PlanError('Service labels are unsupported')
        mounts = spec.get('volumes', [])
        if not isinstance(mounts, list):
            raise PlanError('Invalid mounts')
        for index, mount in enumerate(mounts):
            if not isinstance(mount, dict) or not isinstance(mount.get('target'), str) or not mount['target'].startswith('/'):
                raise PlanError('Unsupported mount')
            kind = mount.get('type')
            if kind == 'bind':
                key = (service, index, mount.get('source'))
                if (set(mount) - {'type', 'source', 'target', 'read_only', 'bind'}
                        or not isinstance(mount.get('source'), str)
                        or mount.get('read_only') is not True or key not in approved
                        or mount.get('bind', {}) not in ({}, {'create_host_path': False}, {'create_host_path': True})):
                    raise PlanError('Unverified bind')
                # Snapshots already exist; never permit Docker to create paths.
                mount['bind'] = {'create_host_path': False}
                used.add(key)
            elif kind == 'volume':
                if (set(mount) - {'type', 'source', 'target', 'read_only', 'volume'}
                        or not isinstance(mount.get('source'), str) or mount.get('source') not in volumes
                        or mount.get('volume', {}) not in ({}, {'nocopy': True})):
                    raise PlanError('Unsupported volume mount')
            else:
                raise PlanError('Unsupported mount type')
        attachments = spec.get('networks', {'default': {}})
        if not isinstance(attachments, dict) or not attachments:
            raise PlanError('Unsupported network attachment')
        for network, options in attachments.items():
            if network not in networks and network != 'default':
                raise PlanError('Unknown network')
            if options not in (None, {}):
                if not isinstance(options, dict) or set(options) != {'ipv4_address'}:
                    raise PlanError('Network aliases and overrides are unsupported')
                try:
                    ipaddress.IPv4Address(options['ipv4_address'])
                except (ValueError, TypeError):
                    raise PlanError('Invalid network address') from None
        # The private network has a fresh subnet. DNS service names still work;
        # original fixed addresses and subnet are not reused.
        spec['networks'] = {n: {} for n in attachments}
        spec.pop('ports', None)
        spec['restart'] = 'no'
    if used != approved:
        raise PlanError('Unused bind evidence')
    names = set(networks)
    for spec in plan['services'].values():
        names.update(spec['networks'])
    plan['networks'] = {n: {'name': 'chat-private-' + operation_id + '-' + n,
                             'driver': 'bridge', 'internal': True} for n in sorted(names)}
    return plan
