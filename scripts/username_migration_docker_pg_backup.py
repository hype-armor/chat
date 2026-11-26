"""Experimental, unverified PostgreSQL capture; never authorizes restore.

Caller must supply a full writer fence, trusted Docker administrator, private
output directory, and an already running, operation-labeled maintenance
container. This module does not create containers or validate restores. Its
result MUST NOT be used to authorize migration or recovery.

The identity and gate checks surround each PostgreSQL command. Docker inventory
commands themselves cannot be recursively bracketed by Docker inventory checks.
Docker administrator trust and a continuously held fence remain prerequisites.
"""
import json
import os
import re
import stat
import subprocess

import username_migration_scoped_restore as scoped


class CaptureError(RuntimeError):
    pass


_ID = re.compile(r'[0-9a-f]{64}\Z')
_NAME = re.compile(r'[A-Za-z_][A-Za-z_0-9]{0,62}\Z')
_OPERATION = re.compile(r'[a-zA-Z0-9_-]{16,128}\Z')
_ENV = {'PATH': '/usr/bin:/bin', 'HOME': '/nonexistent',
        'DOCKER_CONFIG': '/nonexistent', 'LC_ALL': 'C'}
_DOCKER = ['docker', '--host', 'unix:///var/run/docker.sock']


def _validate_database_properties(properties, database, role):
    """Reject incomplete selected metadata before it becomes evidence."""
    keys = {'name', 'owner', 'encoding', 'collate', 'ctype', 'connection_limit',
            'comment', 'acl', 'settings'}
    if (not isinstance(properties, dict) or set(properties) != keys or
            properties['name'] != database or properties['owner'] != role or
            any(not isinstance(properties[k], str) or not properties[k]
                for k in ('encoding', 'collate', 'ctype')) or
            type(properties['connection_limit']) is not int or
            (properties['comment'] is not None and not isinstance(properties['comment'], str)) or
            not isinstance(properties['acl'], list) or not isinstance(properties['settings'], list)):
        raise ValueError('invalid database properties')
    for entry in properties['acl']:
        if (not isinstance(entry, dict) or
                set(entry) != {'grantor', 'grantee', 'privilege', 'grantable'} or
                any(not isinstance(entry[k], str) or not entry[k]
                    for k in ('grantor', 'grantee', 'privilege')) or
                type(entry['grantable']) is not bool):
            raise ValueError('invalid database ACL')
    for entry in properties['settings']:
        if (not isinstance(entry, dict) or set(entry) != {'role', 'config'} or
                not isinstance(entry['role'], str) or
                not isinstance(entry['config'], list) or
                any(not isinstance(value, str) for value in entry['config'])):
            raise ValueError('invalid database settings')


class UnverifiedDockerCapture:
    """Capture evidence only. No method in this class authorizes restore."""

    operational = False
    restore_authorized = False

    def __init__(self, *, directory_fd, operation, container_id, image_id,
                 volume, volume_destination, stopped_container_ids, gate,
                 runner=subprocess.run):
        st = os.fstat(directory_fd)
        if (not stat.S_ISDIR(st.st_mode) or st.st_uid != os.geteuid() or
                stat.S_IMODE(st.st_mode) != 0o700):
            raise CaptureError('unsafe evidence directory')
        if (not _OPERATION.fullmatch(operation or '') or
                not _ID.fullmatch(container_id or '') or
                not _ID.fullmatch(image_id or '') or
                not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.-]{0,127}', volume or '') or
                not isinstance(volume_destination, str) or
                not volume_destination.startswith('/') or
                os.path.normpath(volume_destination) != volume_destination or
                not isinstance(stopped_container_ids, (list, tuple, set)) or
                any(not isinstance(i, str) or not _ID.fullmatch(i) for i in stopped_container_ids) or
                container_id in stopped_container_ids or not callable(gate)):
            raise CaptureError('invalid capture configuration')
        self.fd = directory_fd
        self.operation, self.container, self.image = operation, container_id, image_id
        self.volume, self.destination = volume, volume_destination
        self.stopped, self.gate, self.runner = set(stopped_container_ids), gate, runner

    def _docker(self, args, **kwargs):
        try:
            result = self.runner(_DOCKER + args, env=_ENV, stderr=subprocess.DEVNULL,
                                 check=False, timeout=300, **kwargs)
            if result.returncode != 0:
                raise ValueError()
            return result
        except Exception:
            # Never expose Docker or PostgreSQL diagnostics, which can hold secrets.
            raise CaptureError('Docker command failed') from None

    def _verify(self):
        try:
            if self.gate() is not True:
                raise ValueError()
            raw = self._docker(['volume', 'inspect', self.volume], stdout=subprocess.PIPE).stdout
            volume = json.loads(raw)
            if (len(volume) != 1 or volume[0]['Name'] != self.volume or
                    volume[0]['Driver'] != 'local' or volume[0].get('Options') not in (None, {}) or
                    not os.path.isabs(volume[0]['Mountpoint'])):
                raise ValueError()
            volume_path = os.path.realpath(volume[0]['Mountpoint'])
            ids = self._docker(['container', 'ls', '--all', '--no-trunc', '--quiet'],
                               stdout=subprocess.PIPE).stdout.decode().split()
            if (len(ids) != len(set(ids)) or any(not _ID.fullmatch(i) for i in ids) or
                    not ({self.container} | self.stopped) <= set(ids)):
                raise ValueError()
            rows = json.loads(self._docker(['container', 'inspect', *ids], stdout=subprocess.PIPE).stdout)
            if not isinstance(rows, list) or len(rows) != len(ids):
                raise ValueError()
            seen = set()
            for c in rows:
                cid = c['Id']
                if cid not in ids or cid in seen:
                    raise ValueError()
                seen.add(cid)
                state = c['State']
                active = any(state[k] for k in ('Running', 'Paused', 'Restarting'))
                policy = c['HostConfig']['RestartPolicy']
                if (not isinstance(policy, dict) or policy.get('Name') not in ('no', 'always', 'unless-stopped', 'on-failure')):
                    raise ValueError()
                could_start = active or policy['Name'] != 'no'
                mounts = c['Mounts']
                if cid in self.stopped and (active or policy['Name'] != 'no'):
                    raise ValueError()
                if cid == self.container:
                    if (not state['Running'] or state['Paused'] or state['Restarting'] or
                            c['Image'] != 'sha256:' + self.image or
                            (c['Config']['Labels'] or {}).get('username-migration.operation') != self.operation or
                            c['HostConfig']['NetworkMode'] != 'none' or policy['Name'] != 'no' or
                            not isinstance(c['NetworkSettings']['Networks'], dict) or
                            set(c['NetworkSettings']['Networks']) - {'none'} or
                            any(c['NetworkSettings']['Networks'].get('none', {}).get(k) not in ('', None)
                                for k in ('IPAddress', 'GlobalIPv6Address', 'Gateway', 'IPv6Gateway')) or
                            len(mounts) != 1 or mounts[0]['Type'] != 'volume' or
                            mounts[0]['Name'] != self.volume or mounts[0]['Destination'] != self.destination or
                            mounts[0].get('RW') is not True):
                        raise ValueError()
                else:
                    for mount in mounts:
                        if mount['Type'] == 'volume' and mount['Name'] == self.volume and cid not in self.stopped:
                            raise ValueError()
                        # Bind sources can alias the Docker volume path.
                        if could_start and mount['Type'] == 'bind':
                            source = mount.get('Source')
                            if not isinstance(source, str) or not os.path.isabs(source):
                                raise ValueError()
                            for candidate in (os.path.normpath(source), os.path.realpath(source)):
                                if os.path.commonpath((candidate, volume_path)) in (candidate, volume_path):
                                    raise ValueError()
            if self.gate() is not True:
                raise ValueError()
        except Exception:
            raise CaptureError('fence or Docker topology cannot be verified') from None

    def _exec(self, args, **kwargs):
        self._verify()
        try:
            return self._docker(['exec', '-i', '-e',
                                 'PGOPTIONS=-c search_path=pg_catalog -c standard_conforming_strings=on',
                                 self.container, *args], **kwargs)
        finally:
            self._verify()

    def capture(self, *, database, role):
        """Create archive and private metadata. All evidence remains unverified.

        Local socket authentication must already work without a password. The
        caller must not use this output as a recovery or migration gate.
        Existing filenames cause failure; partial evidence is never removed.
        """
        if (not all(isinstance(x, str) and _NAME.fullmatch(x) for x in (database, role))
                or database in ('postgres', 'template0', 'template1')):
            raise CaptureError('invalid database or role')
        flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC
        fd = os.open('postgres.dump', flags, 0o600, dir_fd=self.fd)
        try:
            # SQL is stdin, not an argument. Metadata includes the password hash.
            sql = b"""SET timezone='UTC'; SELECT json_build_object(
              'system_id', (SELECT system_identifier::text FROM pg_control_system()),
              'role', (SELECT json_build_object('rolname',r.rolname,'rolsuper',r.rolsuper,
                'rolpassword',r.rolpassword,'rolinherit',r.rolinherit,'rolcreatedb',r.rolcreatedb,
                'rolcreaterole',r.rolcreaterole,'rolcanlogin',r.rolcanlogin,
                'rolreplication',r.rolreplication,'rolbypassrls',r.rolbypassrls,
                'rolconnlimit',r.rolconnlimit,'rolvaliduntil',r.rolvaliduntil::text,
                'settings',COALESCE((SELECT json_object_agg(split_part(s,'=',1),substr(s,strpos(s,'=')+1))
                  FROM pg_db_role_setting d, unnest(d.setconfig) s
                  WHERE d.setrole=r.oid AND d.setdatabase=0),'{}'::json))
                FROM pg_authid r WHERE r.rolname=current_user),
              'database', (SELECT row_to_json(d) FROM (SELECT datname, pg_get_userbyid(datdba) AS owner, pg_encoding_to_char(encoding) AS encoding, datcollate, datctype, datconnlimit, datallowconn FROM pg_database WHERE datname = current_database()) d),
              'selected_database_properties', (SELECT json_build_object(
                'name', d.datname, 'owner', pg_get_userbyid(d.datdba),
                'encoding', pg_encoding_to_char(d.encoding), 'collate', d.datcollate,
                'ctype', d.datctype, 'connection_limit', d.datconnlimit,
                'comment', shobj_description(d.oid,'pg_database'),
                'acl', (SELECT coalesce(json_agg(json_build_object(
                  'grantor',pg_get_userbyid(a.grantor),
                  'grantee',CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END,
                  'privilege',a.privilege_type,'grantable',a.is_grantable)
                  ORDER BY pg_get_userbyid(a.grantor),CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END,a.privilege_type),'[]'::json)
                  FROM aclexplode(coalesce(d.datacl,acldefault('d',d.datdba))) a),
                'settings', (SELECT coalesce(json_agg(json_build_object(
                  'role',CASE WHEN s.setrole=0 THEN '' ELSE pg_get_userbyid(s.setrole) END,'config',s.setconfig)
                  ORDER BY CASE WHEN s.setrole=0 THEN '' ELSE pg_get_userbyid(s.setrole) END),'[]'::json)
                  FROM pg_db_role_setting s WHERE s.setdatabase=d.oid))
                FROM pg_database d WHERE d.datname=current_database()),
              'roles', (SELECT coalesce(json_agg(rolname ORDER BY rolname),'[]'::json) FROM pg_roles WHERE rolname !~ '^pg_'),
              'databases', (SELECT coalesce(json_agg(datname ORDER BY datname),'[]'::json) FROM pg_database WHERE datname NOT IN ('postgres','template0','template1')),
              'prepared', (SELECT count(*) FROM pg_prepared_xacts),
              'memberships', (SELECT count(*) FROM pg_auth_members m JOIN pg_roles member ON member.oid=m.member JOIN pg_roles granted ON granted.oid=m.roleid WHERE member.rolname !~ '^pg_' OR granted.rolname !~ '^pg_'));\n"""
            result = self._exec(['psql', '-X', '-qAt', '--no-password', '-v', 'ON_ERROR_STOP=1',
                                 '-U', role, '-d', database], input=sql, stdout=subprocess.PIPE)
            if not isinstance(result.stdout, bytes) or len(result.stdout) > 1048576:
                raise CaptureError('invalid metadata')
            try:
                facts = json.loads(result.stdout)
                if (not isinstance(facts, dict) or not re.fullmatch(r'[0-9]{1,20}', facts['system_id']) or
                        facts['role']['rolname'] != role or facts['role']['rolsuper'] is not True or
                        facts['database']['datname'] != database or facts['database']['owner'] != role or
                        not isinstance(facts['selected_database_properties'], dict) or
                        facts['selected_database_properties'].get('name') != database or
                        facts['roles'] != [role] or facts['databases'] != [database] or
                        facts['prepared'] != 0 or facts['memberships'] != 0):
                    raise ValueError()
                _validate_database_properties(facts['selected_database_properties'], database, role)
                role_record = dict(facts['role'])
                role_record.pop('rolname')
                role_record.pop('rolsuper')
                scoped._validate_role_record(role_record)
            except Exception:
                raise CaptureError('invalid metadata') from None
            meta_fd = os.open('postgres-metadata.json', flags, 0o600, dir_fd=self.fd)
            try:
                with os.fdopen(meta_fd, 'wb', closefd=False) as meta:
                    meta.write(json.dumps(facts, sort_keys=True).encode() + b'\n')
                    meta.flush()
                    os.fsync(meta_fd)
            finally:
                os.close(meta_fd)
            os.fsync(self.fd)
            self._exec(['pg_dump', '--format=custom', '--create', '--no-password',
                        '-U', role, '-d', database], stdout=fd)
            if os.fstat(fd).st_size == 0:
                raise CaptureError('empty archive')
            os.fsync(fd)
            os.fsync(self.fd)
        finally:
            os.close(fd)
            # Preserve even empty or partial files as failure evidence.
            os.fsync(self.fd)
        return {'status': 'UNVERIFIED', 'restore_authorized': False,
                'reason': 'disposable restore validation and property comparison are not implemented'}
