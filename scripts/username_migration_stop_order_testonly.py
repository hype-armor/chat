"""Test-only stop-order graph. This module performs no operational actions.

The caller independently verifies that the exact captured bytes are the complete
resolved Compose configuration for the operation and active profiles. The
callback must bind that verification to the operation, SHA-256 digest, and
profiles. This graph cannot prove external dependencies or continuous exclusion.
"""
import hashlib
import json
import re
import uuid

operational = False


class StopOrderError(ValueError):
    pass


def _object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise StopOrderError('Duplicate JSON key')
        result[key] = value
    return result


def derive_stop_order(*, config_bytes, operation, profiles, classifications,
                      postgres, verify_evidence, explicit_order=None):
    """Validate an explicit order, or derive the unique order and reject ambiguity.

    Classifications are (name, role) pairs. An explicit order must contain each
    service exactly once and satisfy every graph edge. It does not prove hidden
    dependencies or authorize a fence.

    verify_evidence(operation, config_sha256, profiles_tuple) must return True
    only after independent verification of the complete captured resolved config
    and its operation and profile binding. It is not a fence or security boundary.
    Profile-bearing services must match at least one active profile; services
    omitted from a resolved config cannot be detected by this module.
    """
    try:
        if not isinstance(config_bytes, bytes) or not config_bytes or len(config_bytes) > 4 * 1024 * 1024:
            raise StopOrderError('Invalid captured config')
        if not isinstance(operation, str) or str(uuid.UUID(operation)) != operation:
            raise StopOrderError('Invalid operation')
        if not isinstance(profiles, (tuple, list)) or any(not isinstance(p, str) or not re.fullmatch(r'[a-zA-Z0-9][a-zA-Z0-9_.-]*', p) for p in profiles) or list(profiles) != sorted(set(profiles)):
            raise StopOrderError('Invalid profiles')
        profiles = tuple(profiles)
        digest = hashlib.sha256(config_bytes).hexdigest()
        if not callable(verify_evidence) or verify_evidence(operation, digest, profiles) is not True:
            raise StopOrderError('Evidence not verified')
        config = json.loads(config_bytes, object_pairs_hook=_object)
        services = config['services']
        if not isinstance(services, dict) or not services:
            raise StopOrderError('Invalid services')
        if any(not isinstance(n, str) or not re.fullmatch(r'[a-zA-Z0-9][a-zA-Z0-9_.-]*', n) or not isinstance(s, dict) for n, s in services.items()):
            raise StopOrderError('Invalid service')
        roles = {}
        if not isinstance(classifications, (list, tuple)):
            raise StopOrderError('Invalid classifications')
        for entry in classifications:
            if not isinstance(entry, (list, tuple)) or len(entry) != 2:
                raise StopOrderError('Invalid classification')
            name, role = entry
            if not isinstance(name, str) or name in roles or role not in ('writer', 'storage', 'other'):
                raise StopOrderError('Invalid or duplicate classification')
            roles[name] = role
        if set(roles) != set(services):
            raise StopOrderError('Classifications do not match services')
        if not isinstance(postgres, str) or roles.get(postgres) != 'storage':
            raise StopOrderError('PostgreSQL must be a storage service')
        edges = {name: set() for name in services}
        for name, spec in services.items():
            if 'profiles' in spec:
                service_profiles = spec['profiles']
                if not isinstance(service_profiles, list) or not service_profiles or any(not isinstance(p, str) or not re.fullmatch(r'[a-zA-Z0-9][a-zA-Z0-9_.-]*', p) for p in service_profiles) or len(set(service_profiles)) != len(service_profiles) or not set(service_profiles).intersection(profiles):
                    raise StopOrderError('Invalid or inactive service profile')
            deps = spec.get('depends_on', {})
            if isinstance(deps, list):
                if any(not isinstance(d, str) for d in deps) or len(set(deps)) != len(deps):
                    raise StopOrderError('Invalid dependencies')
                dependencies = deps
            elif isinstance(deps, dict):
                dependencies = list(deps)
                for options in deps.values():
                    if not isinstance(options, dict) or set(options) - {'condition', 'restart', 'required'} or options.get('condition', 'service_started') not in ('service_started', 'service_healthy', 'service_completed_successfully') or any(type(options[k]) is not bool for k in ('restart', 'required') if k in options):
                        raise StopOrderError('Unsupported dependency options')
            else:
                raise StopOrderError('Unsupported dependencies')
            for dep in dependencies:
                if dep not in services:
                    raise StopOrderError('Dependency is absent')
                edges[name].add(dep)
        for name, role in roles.items():
            if role == 'writer':
                edges[name].update(n for n, r in roles.items() if r == 'storage')
            if name != postgres:
                edges[name].add(postgres)
        if explicit_order is not None:
            if (not isinstance(explicit_order, (list, tuple))
                    or any(not isinstance(n, str) for n in explicit_order)
                    or len(explicit_order) != len(services)
                    or set(explicit_order) != set(services)):
                raise StopOrderError('Explicit order must contain every service exactly once')
            positions = {name: index for index, name in enumerate(explicit_order)}
            if any(positions[source] >= positions[target]
                   for source, targets in edges.items() for target in targets):
                raise StopOrderError('Explicit order violates a stop-order edge')
            return tuple(explicit_order)
        incoming = {n: 0 for n in services}
        for targets in edges.values():
            for target in targets:
                incoming[target] += 1
        order = []
        while len(order) < len(services):
            ready = [n for n in services if incoming[n] == 0 and n not in order]
            if len(ready) != 1:
                raise StopOrderError('Cycle or ambiguous stop order')
            node = ready[0]
            order.append(node)
            for target in edges[node]:
                incoming[target] -= 1
        return tuple(order)
    except StopOrderError:
        raise
    except Exception:
        raise StopOrderError('Invalid evidence or graph') from None
