"""Experimental local Compose evidence capture; runtime restore is disabled.

Caller must hold the update lock and exclude all Docker daemon writers for the
entire capture and verification. The returned digest must be anchored outside
this directory in a trusted durable journal. This is not a physical fence.
No command starts, stops, removes, or recreates a container.
"""
import hashlib
import json
import os
import re
import stat
import subprocess
import uuid

import username_migration_compose_binds as binds


class RuntimeErrorSafe(RuntimeError):
    """Sanitized failure. Never expose Docker output or configuration values."""


def _digest(data):
    return hashlib.sha256(data).hexdigest()


def _read_private(path):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
    try:
        st = os.fstat(fd)
        if not stat.S_ISREG(st.st_mode) or st.st_uid != os.geteuid() or st.st_mode & 0o077 or st.st_nlink != 1:
            raise RuntimeErrorSafe('Input must be a private regular file')
        with os.fdopen(fd, 'rb') as f:
            fd = -1
            data = f.read(4 * 1024 * 1024 + 1)
        if len(data) > 4 * 1024 * 1024:
            raise RuntimeErrorSafe('Input too large')
        return data
    finally:
        if fd >= 0:
            os.close(fd)


class ComposeRuntime:
    def __init__(self, project_dir, env_file, compose_file, runner=subprocess.run):
        self.project_dir = os.path.abspath(project_dir)
        self.env_file = os.path.abspath(env_file)
        self.compose_file = os.path.abspath(compose_file)
        self.runner = runner

    def _run(self, args):
        try:
            result = self.runner(['docker', '--host', 'unix:///var/run/docker.sock', *args],
                                 cwd=self.project_dir, env={'PATH': '/usr/bin:/bin', 'HOME': '/nonexistent', 'DOCKER_CONFIG': '/nonexistent'},
                                 capture_output=True, text=True, check=False, timeout=60)
            if result.returncode or not isinstance(result.stdout, str) or len(result.stdout) > 8 * 1024 * 1024:
                raise ValueError()
            return result.stdout
        except Exception:
            raise RuntimeErrorSafe('Docker command failed') from None

    def _compose(self, profiles, args):
        cmd = ['compose', '--project-directory', self.project_dir, '--env-file', self.env_file, '-f', self.compose_file]
        for profile in profiles:
            cmd += ['--profile', profile]
        return self._run(cmd + args)

    def _image(self, ref):
        value = self._run(['image', 'inspect', '--format', '{{.Id}}', ref]).strip()
        if not re.fullmatch(r'sha256:[0-9a-f]{64}', value):
            raise RuntimeErrorSafe('Invalid image ID')
        return value

    def _state(self, profiles):
        try:
            config_raw = self._compose(profiles, ['config', '--format', 'json']).encode()
            config = json.loads(config_raw)
            services = config['services']
            if not isinstance(services, dict) or not services or not isinstance(config.get('name'), str):
                raise ValueError()
            if config.get('configs') or config.get('secrets'):
                raise RuntimeErrorSafe('Compose configs and secrets are unsupported')
            for spec in services.values():
                if spec.get('configs') or spec.get('secrets'):
                    raise RuntimeErrorSafe('Compose configs and secrets are unsupported')
            binds.validate_bind_mounts(config, os.path.dirname(self.compose_file))
            config_hashes = {}
            for line in self._compose(profiles, ['config', '--hash', '*']).splitlines():
                fields = line.split()
                if (len(fields) != 2 or fields[0] in config_hashes
                        or not re.fullmatch(r'[0-9a-f]{64}', fields[1])):
                    raise ValueError()
                config_hashes[fields[0]] = fields[1]
            if set(config_hashes) != set(services):
                raise ValueError()
            ids = self._compose(profiles, ['ps', '--all', '--quiet']).split()
            if not ids or len(ids) != len(set(ids)) or any(not re.fullmatch(r'[0-9a-f]{64}', x) for x in ids):
                raise ValueError()
            containers = json.loads(self._run(['inspect', *sorted(ids)]))
            if not isinstance(containers, list) or len(containers) != len(ids):
                raise ValueError()
            found = {}
            for c in containers:
                labels = c['Config']['Labels']
                service = labels['com.docker.compose.service']
                cid = c['Id']
                image = c['Image']
                if (labels['com.docker.compose.project'] != config['name'] or service not in services or service in found
                    or labels.get('com.docker.compose.config-hash') != config_hashes[service]
                    or cid not in ids or not re.fullmatch(r'sha256:[0-9a-f]{64}', image)):
                    raise ValueError()
                found[service] = {'container': cid, 'image': image}
            if set(found) != set(services):
                raise ValueError()
            return config_raw, found
        except RuntimeErrorSafe:
            raise
        except Exception:
            raise RuntimeErrorSafe('Unsupported or ambiguous Compose state') from None

    def capture(self, operation_id, profiles, output_dir):
        try:
            if str(uuid.UUID(operation_id)) != operation_id or not isinstance(profiles, list) or profiles != sorted(set(profiles)) or any(not re.fullmatch(r'[a-z][a-z0-9_-]*', p) for p in profiles):
                raise ValueError()
        except (ValueError, TypeError, AttributeError):
            raise RuntimeErrorSafe('Invalid operation or profiles') from None
        # output_dir must not exist; parent must be private and trusted.
        parent = os.path.dirname(os.path.abspath(output_dir))
        st = os.lstat(parent)
        if not stat.S_ISDIR(st.st_mode) or st.st_uid != os.geteuid() or st.st_mode & 0o077:
            raise RuntimeErrorSafe('Evidence parent must be private')
        env = _read_private(self.env_file)
        config, containers = self._state(profiles)
        pins = {}
        for service, info in sorted(containers.items()):
            if not re.fullmatch(r'[a-z][a-z0-9_-]{0,40}', service):
                raise RuntimeErrorSafe('Invalid service')
            image = info['image']
            if self._image(image) != image:
                raise RuntimeErrorSafe('Unknown image')
            pin = 'chat-migration-evidence:' + operation_id + '-' + service
            # Inspect failures cannot distinguish absent tags from daemon errors.
            # Query the complete exact tag list instead and refuse any match.
            tags = self._run(['image', 'ls', '--all', '--format', '{{.Repository}}:{{.Tag}}']).splitlines()
            if pin in tags:
                if self._image(pin) != image:
                    raise RuntimeErrorSafe('Pin already points to another image')
            else:
                self._run(['image', 'tag', image, pin])
            if self._image(pin) != image:
                raise RuntimeErrorSafe('Pin changed')
            pins[service] = pin
        if _read_private(self.env_file) != env or self._state(profiles) != (config, containers):
            raise RuntimeErrorSafe('Runtime inputs changed during capture')
        for service, pin in pins.items():
            if self._image(pin) != containers[service]['image']:
                raise RuntimeErrorSafe('Pin changed')
        os.mkdir(output_dir, 0o700)
        try:
            original_config = json.loads(config)
            rewritten, bind_records = binds.snapshot_bind_mounts(original_config, os.path.dirname(self.compose_file),
                                                                  os.path.join(output_dir, 'binds'))
        except Exception:
            raise RuntimeErrorSafe('Bind snapshot failed') from None
        # Restore must use the captured images, never current build inputs/tags.
        for service, info in containers.items():
            rewritten['services'][service]['image'] = info['image']
            rewritten['services'][service].pop('build', None)
        rewritten_config = json.dumps(rewritten, sort_keys=True, separators=(',', ':')).encode()
        manifest = {'version': 1, 'operation': operation_id, 'profiles': profiles, 'containers': containers,
                    'pins': pins, 'env_sha256': _digest(env), 'config_sha256': _digest(rewritten_config),
                    'source_config_sha256': _digest(config), 'binds': bind_records}
        data = json.dumps(manifest, sort_keys=True, separators=(',', ':')).encode()
        if len(rewritten_config) > 4 * 1024 * 1024 or len(data) > 4 * 1024 * 1024:
            raise RuntimeErrorSafe('Captured runtime evidence is too large')
        directory = os.open(output_dir, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            for name, contents in [('env', env), ('config.json', rewritten_config), ('manifest.json', data)]:
                fd = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=directory)
                with os.fdopen(fd, 'wb') as f:
                    f.write(contents)
                    f.flush()
                    os.fsync(f.fileno())
            os.fsync(directory)
        finally:
            os.close(directory)
        pfd = os.open(parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            os.fsync(pfd)
        finally:
            os.close(pfd)
        return _digest(data)

    def verify(self, output_dir, expected_digest):
        if not re.fullmatch(r'[0-9a-f]{64}', expected_digest):
            raise RuntimeErrorSafe('Invalid external anchor')
        try:
            st = os.lstat(output_dir)
            if not stat.S_ISDIR(st.st_mode) or st.st_uid != os.geteuid() or st.st_mode & 0o077:
                raise ValueError()
            data = _read_private(os.path.join(output_dir, 'manifest.json'))
            if _digest(data) != expected_digest:
                raise ValueError()
            manifest = json.loads(data)
            config_data = _read_private(os.path.join(output_dir, 'config.json'))
            if _digest(_read_private(os.path.join(output_dir, 'env'))) != manifest['env_sha256'] or _digest(config_data) != manifest['config_sha256']:
                raise ValueError()
            config = json.loads(config_data)
            # A frozen resolved config must survive Compose parsing again,
            # including literal dollar signs and normalized defaults.
            command = ['compose', '--project-directory', self.project_dir,
                       '--env-file', os.path.join(output_dir, 'env'),
                       '-f', os.path.join(output_dir, 'config.json')]
            for profile in manifest['profiles']:
                command += ['--profile', profile]
            reparsed = json.loads(self._run(command + ['config', '--format', 'json']))
            if reparsed != config:
                raise ValueError()
            binds.verify_bind_snapshots(manifest['binds'], os.path.join(output_dir, 'binds'))
            for bind in manifest['binds']:
                volume = config['services'][bind['service']]['volumes'][bind['index']]
                if volume.get('source') != bind['snapshot'] or volume.get('read_only') is not True:
                    raise ValueError()
            for service, pin in manifest['pins'].items():
                if self._image(pin) != manifest['containers'][service]['image']:
                    raise ValueError()
        except Exception:
            raise RuntimeErrorSafe('Evidence verification failed') from None
        return True

    def restore(self, *args, **kwargs):
        raise RuntimeErrorSafe('Restore disabled: exact Compose reconstruction, startup ordering, and verified fence integration are unavailable')
