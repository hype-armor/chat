#!/usr/bin/env python3
"""Mock-only topology diagnostics. This is not a migration or writer fence.

The input is a synthetic, normalized snapshot, not live Docker output. Even a
matching snapshot cannot prove exclusive control or prevent changes after the
snapshot. This tool never authorizes migration, backup, restore, or ingress.
Do not supply secrets or production inspection data.
"""
import argparse
import json
import sys
from urllib.parse import urlsplit

SERVICES = {'server', 'web', 'echo-invite', 'echo', 'https', 'coturn',
            'postgres', 'valkey', 'seaweedfs', 'seaweedfs-init', 'livekit'}


def diagnose(snapshot):
    """Return diagnostics for a synthetic snapshot. Always return unsupported."""
    findings = []
    def problem(message):
        if message not in findings:
            findings.append(message)

    try:
        if not isinstance(snapshot, dict) or set(snapshot) != {
                'project', 'containers', 'networks', 'database_volume',
                'systemd', 'tcp_connections', 'privileges'}:
            raise ValueError('invalid snapshot fields')
        project = snapshot['project']
        if project != 'chat':
            problem('Compose project is not chat')
        volume = snapshot['database_volume']
        if volume != 'chat_postgres':
            problem('Database volume is not chat_postgres')
        containers = snapshot['containers']
        networks = snapshot['networks']
        if not isinstance(containers, list) or not isinstance(networks, dict):
            raise ValueError('invalid container or network inventory')
        if set(networks) != {'chat_default', 'chat_https-proxy'}:
            problem('Unexpected or missing Compose network')
        ids = set()
        services = {}
        for c in containers:
            if not isinstance(c, dict) or set(c) != {'id', 'project', 'service', 'running', 'networks', 'mounts', 'ports', 'database_url', 'restart'}:
                raise ValueError('invalid container fields')
            if not isinstance(c['id'], str) or not c['id'] or c['id'] in ids:
                raise ValueError('invalid or duplicate container ID')
            ids.add(c['id'])
            if type(c['running']) is not bool or not all(isinstance(c[x], list) and all(isinstance(v, str) for v in c[x]) for x in ('networks', 'mounts', 'ports')):
                raise ValueError('invalid container inventory')
            if c['project'] == 'chat':
                if c['service'] not in SERVICES or c['service'] in services:
                    problem('Unexpected or duplicate Compose service')
                services[c['service']] = c
            elif c['running'] and set(c['networks']) & {'chat_default', 'chat_https-proxy'}:
                problem('Other running container shares a Compose network')
            if volume in c['mounts'] and (c['project'], c['service']) != ('chat', 'postgres'):
                problem('Other container mounts the database volume')
            if c['database_url'] is not None:
                if not isinstance(c['database_url'], str):
                    raise ValueError('invalid database endpoint')
                try:
                    u = urlsplit(c['database_url'])
                    if (u.scheme not in ('postgres', 'postgresql') or u.hostname != 'postgres'
                            or u.port not in (None, 5432) or u.path != '/chat' or u.query or u.fragment):
                        problem('External or unsupported configured database endpoint')
                except ValueError:
                    problem('External or unsupported configured database endpoint')
                if (c['project'], c['service']) not in {('chat', 'server'), ('chat', 'echo-invite')}:
                    problem('Additional configured database client')
            if c['restart'] not in ('no', 'always', 'unless-stopped', 'on-failure'):
                raise ValueError('invalid restart policy')
            if c['running'] and c['restart'] != 'no':
                problem('Running container has automatic restart policy')
        for name, members in networks.items():
            if not isinstance(name, str) or not isinstance(members, list) or any(not isinstance(m, str) for m in members) or len(set(members)) != len(members):
                raise ValueError('invalid network membership')
            expected = {c['id'] for c in containers if c['running'] and name in c['networks']}
            if set(members) != expected:
                problem('Network membership does not match container inventory')
        for service in ('server', 'postgres'):
            if service not in services or not services[service]['running']:
                problem('Required server or PostgreSQL container is not running')
        if 'server' in services:
            c = services['server']
            if c['database_url'] is None:
                problem('Server database endpoint is missing')
            if '8080/tcp' in c['ports']:
                problem('Server has direct published TCP ingress')
            if any(p != '8080/tcp' for p in c['ports']):
                problem('Server has additional published ingress')
        if 'postgres' in services:
            c = services['postgres']
            if volume not in c['mounts']:
                problem('PostgreSQL database volume is missing')
            if c['ports']:
                problem('PostgreSQL has published ingress')
            if 'chat_default' not in c['networks']:
                problem('PostgreSQL is not on the Compose default network')
        systemd = snapshot['systemd']
        if not isinstance(systemd, dict) or set(systemd) != {'active', 'enabled', 'restart'} or any(type(systemd[k]) is not bool for k in systemd):
            raise ValueError('invalid systemd evidence')
        if any(systemd.values()):
            problem('pi-chat.service can compete or restart the stack')
        tcp = snapshot['tcp_connections']
        if not isinstance(tcp, list) or any(not isinstance(x, str) for x in tcp):
            raise ValueError('invalid TCP inventory')
        if tcp:
            problem('Existing database TCP connections require identification and fencing')
        privileges = snapshot['privileges']
        if not isinstance(privileges, dict) or set(privileges) != {'docker_admins_fenced', 'host_admins_fenced', 'database_admins_fenced'} or any(type(v) is not bool for v in privileges.values()):
            raise ValueError('invalid privilege evidence')
        if not all(privileges.values()):
            problem('Administrative access is not fenced')
    except (ValueError, TypeError, KeyError):
        problem('Invalid or incomplete snapshot')
    findings.append('Unsupported: snapshots cannot fence external writers, administrators, or future restarts')
    return {'status': 'unsupported', 'findings': findings}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--mock-snapshot', required=True, help='synthetic JSON snapshot only')
    args = parser.parse_args(argv)
    try:
        with open(args.mock_snapshot, encoding='utf-8') as source:
            snapshot = json.load(source)
        result = diagnose(snapshot)
    except (OSError, ValueError, UnicodeError, RecursionError):
        result = {'status': 'unsupported', 'findings': ['Invalid or unavailable mock snapshot']}
    print(json.dumps(result, sort_keys=True))
    return 2


if __name__ == '__main__':
    sys.exit(main())
