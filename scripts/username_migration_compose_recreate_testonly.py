"""Non-operational Compose recreation experiment. Never connect effects to Docker.

The caller supplies a fake command runner, a trusted manifest digest, and a
journal/fence assertion. This is not a fence and is not production recovery.
Only already-resolved configurations without mounts, custom networks, ports,
profiles, secrets, configs, dependencies, scaling, or custom names are supported.
"""
import json
import os
import re
import uuid

from username_migration_compose_runtime import ComposeRuntime, RuntimeErrorSafe, _read_private, _digest

operational = False


class RecreateError(RuntimeError):
    pass


class FakeDocker:
    """Marker for a test double. Implement run(args, **kwargs); never use a daemon."""
    def run(self, args, **kwargs):
        raise NotImplementedError


def recreate_testonly(*, evidence_dir, trusted_digest, fake_docker, check_boundary):
    """Create missing OLD containers without starting them.

    check_boundary receives the captured operation ID and manifest digest. It
    must return exactly True at every check after verifying that operation's
    external fence and closed ingress. The fake must implement CLI output for
    image inspect, container ls/inspect, and compose create. It must list all
    containers for the project, including stopped and orphaned containers.
    The injected fake is not a security boundary.
    """
    if not isinstance(fake_docker, FakeDocker) or not callable(check_boundary):
        raise RecreateError('A fake Docker and boundary assertion are required')
    evidence_dir = os.path.abspath(os.fspath(evidence_dir))
    operation = None
    def boundary():
        if check_boundary(operation, trusted_digest) is not True:
            raise RecreateError('Operation fence or closed ingress not verified')
    def run(args):
        boundary()
        try:
            result = fake_docker.run(['docker', '--host', 'unix:///var/run/docker.sock', *args],
                                     cwd=evidence_dir, env={'PATH': '/usr/bin:/bin', 'HOME': '/nonexistent', 'DOCKER_CONFIG': '/nonexistent'},
                                     capture_output=True, text=True, check=False, timeout=60)
            if result.returncode or not isinstance(result.stdout, str) or len(result.stdout) > 8 * 1024 * 1024:
                raise ValueError()
            return result.stdout
        except RecreateError:
            raise
        except Exception:
            raise RecreateError('Fake Docker command failed') from None
    try:
        if not isinstance(trusted_digest, str) or not re.fullmatch(r'[0-9a-f]{64}', trusted_digest):
            raise ValueError()
        data = _read_private(os.path.join(evidence_dir, 'manifest.json'))
        if _digest(data) != trusted_digest:
            raise ValueError()
        manifest = json.loads(data)
        operation = manifest['operation']
        if not isinstance(operation, str) or str(uuid.UUID(operation)) != operation:
            raise ValueError()
        boundary()
        raw = _read_private(os.path.join(evidence_dir, 'config.json'))
        env = _read_private(os.path.join(evidence_dir, 'env'))
        if manifest['version'] != 1 or _digest(raw) != manifest['config_sha256'] or _digest(env) != manifest['env_sha256']:
            raise ValueError()
        config = json.loads(raw)
        project = config['name']
        services = config['services']
        if not re.fullmatch(r'[a-z0-9][a-z0-9_-]*', project) or not isinstance(services, dict) or not services:
            raise ValueError()
        if set(config) - {'name', 'services', 'networks'} or manifest['profiles'] or manifest['binds']:
            raise RecreateError('Unsupported Compose top-level features, profiles, or binds')
        if 'networks' in config and config['networks'] != {'default': {'name': project + '_default', 'ipam': {}}}:
            raise RecreateError('Unsupported Compose network')
        # Deny unknown fields, rather than silently accepting untested semantics.
        allowed = {'image', 'command', 'entrypoint', 'environment', 'labels', 'working_dir', 'user', 'hostname', 'init', 'read_only', 'stop_grace_period', 'stop_signal', 'tty', 'stdin_open', 'networks'}
        if set(services) != set(manifest['containers']) or set(services) != set(manifest['pins']):
            raise ValueError()
        for name, spec in services.items():
            if not re.fullmatch(r'[a-z][a-z0-9_-]{0,40}', name) or not isinstance(spec, dict) or set(spec) - allowed:
                raise RecreateError('Unsupported Compose service feature')
            if 'networks' in spec and spec['networks'] != {'default': None}:
                raise RecreateError('Unsupported service network')
            image = manifest['containers'][name]['image']
            if not re.fullmatch(r'sha256:[0-9a-f]{64}', image) or spec.get('image') != image:
                raise ValueError()
            labels = spec.get('labels', {})
            if not isinstance(labels, dict) or any(k.startswith('com.docker.compose.') for k in labels):
                raise ValueError()
        compose = ['compose', '--project-directory', evidence_dir, '--env-file', os.path.join(evidence_dir, 'env'), '-f', os.path.join(evidence_dir, 'config.json')]
        if json.loads(run(compose + ['config', '--format', 'json'])) != config:
            raise RecreateError('Resolved Compose configuration drift')
        hashes = {}
        for line in run(compose + ['config', '--hash', '*']).splitlines():
            parts = line.split()
            if len(parts) != 2 or parts[0] in hashes or not re.fullmatch(r'[0-9a-f]{64}', parts[1]):
                raise ValueError()
            hashes[parts[0]] = parts[1]
        if set(hashes) != set(services):
            raise ValueError()
        for name in services:
            if run(['image', 'inspect', '--format', '{{.Id}}', manifest['pins'][name]]).strip() != services[name]['image']:
                raise RecreateError('Image pin mismatch')
            if run(['image', 'inspect', '--format', '{{.Id}}', services[name]['image']]).strip() != services[name]['image']:
                raise RecreateError('Image ID mismatch')
        def inventory():
            ids = run(['container', 'ls', '--all', '--quiet', '--no-trunc', '--filter', 'label=com.docker.compose.project=' + project]).split()
            if len(ids) != len(set(ids)) or any(not re.fullmatch(r'[0-9a-f]{64}', x) for x in ids):
                raise ValueError()
            records = json.loads(run(['inspect', *sorted(ids)])) if ids else []
            if not isinstance(records, list) or len(records) != len(ids):
                raise ValueError()
            found = {}
            for record in records:
                labels = record['Config']['Labels']
                service = labels['com.docker.compose.service']
                cid = record['Id']
                if (cid not in ids or service not in services or service in found or
                    labels.get('com.docker.compose.project') != project or
                    labels.get('com.docker.compose.config-hash') != hashes[service] or
                    labels.get('com.docker.compose.container-number') != '1' or
                    labels.get('com.docker.compose.oneoff', 'False').lower() != 'false' or
                    record['Image'] != services[service]['image'] or
                    record['State']['Status'] != 'created' or
                    record['HostConfig']['RestartPolicy']['Name'] != 'no'):
                    raise RecreateError('Unexpected container or labels')
                found[service] = cid
            if len(set(found.values())) != len(ids):
                raise ValueError()
            return found
        found = inventory()
        missing = sorted(set(services) - set(found))
        for service in missing:
            # No start, pull, build, dependency creation, or replacement.
            run(compose + ['create', '--no-build', '--no-recreate', '--no-deps', '--pull', 'never', service])
            updated = inventory()
            if any(updated.get(k) != v for k, v in found.items()) or set(updated) != set(found) | {service}:
                raise RecreateError('Container reconciliation failed')
            found = updated
        boundary()
        return found
    except RecreateError:
        raise
    except (Exception, RuntimeErrorSafe):
        raise RecreateError('Invalid or unsupported captured evidence') from None
