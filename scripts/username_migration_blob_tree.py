#!/usr/bin/env python3
"""Verify fenced blob trees. This is not an operational backup.

Run only on trusted, private trees with writers stopped. Stat checks detect many
changes, but cannot fence same-UID/root processes or eliminate filesystem races.
Paths and xattr values in the JSON inventory are base64-encoded bytes.
Unbounded defaults are experimental. Python's xattr APIs allocate each name list
and value before their sizes can be checked; limits do not bound those allocations.
"""

import argparse
import base64
import hashlib
import json
import os
import stat
import sys


class TreeError(Exception):
    """The tree could not be inventoried safely."""


def encoded(value):
    return base64.b64encode(value).decode('ascii')


def signature(st):
    return (st.st_dev, st.st_ino, st.st_mode, st.st_uid, st.st_gid,
            st.st_size, st.st_mtime_ns, st.st_ctime_ns, st.st_nlink)


def inventory(root, *, max_entries=None, max_file_bytes=None, max_path_depth=None,
              max_path_bytes=None, max_xattr_bytes=None):
    """Return a canonical inventory. Limits are inclusive; None means unbounded.

    Entry and file-byte totals include the root and each hardlink respectively.
    Path limits apply to relative byte paths, with root at depth zero. Xattr bytes
    count names and values across entries. The default unbounded mode is experimental.
    """
    for name, limit in (('max_entries', max_entries), ('max_file_bytes', max_file_bytes),
                        ('max_path_depth', max_path_depth), ('max_path_bytes', max_path_bytes),
                        ('max_xattr_bytes', max_xattr_bytes)):
        if limit is not None and (type(limit) is not int or limit < 0):
            raise ValueError(name + ' must be a nonnegative integer or None')
    root = os.path.abspath(os.fsencode(root))
    entries = []
    checks = []
    links = {}
    discovered = 1
    file_bytes = 0
    xattr_bytes = 0
    if max_entries is not None and discovered > max_entries:
        raise TreeError('entry count limit exceeded')

    def visit(path, relative):
        nonlocal discovered, file_bytes, xattr_bytes
        before = os.lstat(path)
        mode = before.st_mode
        if stat.S_ISDIR(mode):
            kind = 'directory'
        elif stat.S_ISREG(mode):
            kind = 'file'
        elif stat.S_ISLNK(mode):
            kind = 'symlink'
        else:
            raise TreeError('unsupported entry: ' + repr(relative))
        if kind == 'file':
            file_bytes += before.st_size
            if max_file_bytes is not None and file_bytes > max_file_bytes:
                raise TreeError('file byte limit exceeded: ' + repr(relative))
        entry = {'path': encoded(relative), 'type': kind,
                 'mode': stat.S_IMODE(mode), 'uid': before.st_uid,
                 'gid': before.st_gid, 'mtime_ns': before.st_mtime_ns,
                 'size': before.st_size}
        names = os.listxattr(path, follow_symlinks=False)
        attrs = []
        for name in sorted(os.fsencode(n) for n in names):
            xattr_bytes += len(name)
            if max_xattr_bytes is not None and xattr_bytes > max_xattr_bytes:
                raise TreeError('xattr byte limit exceeded: ' + repr(relative))
            value = os.getxattr(path, name, follow_symlinks=False)
            xattr_bytes += len(value)
            if max_xattr_bytes is not None and xattr_bytes > max_xattr_bytes:
                raise TreeError('xattr byte limit exceeded: ' + repr(relative))
            attrs.append([encoded(name), encoded(value)])
        entry['xattrs'] = attrs
        if kind == 'file':
            fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
            try:
                if signature(os.fstat(fd)) != signature(before):
                    raise TreeError('file changed before read: ' + repr(relative))
                digest = hashlib.sha256()
                while True:
                    chunk = os.read(fd, 1024 * 1024)
                    if not chunk:
                        break
                    digest.update(chunk)
                if signature(os.fstat(fd)) != signature(before):
                    raise TreeError('file changed during read: ' + repr(relative))
                entry['sha256'] = digest.hexdigest()
            finally:
                os.close(fd)
            links.setdefault((before.st_dev, before.st_ino), []).append(encoded(relative))
        elif kind == 'symlink':
            entry['target'] = encoded(os.readlink(path))
        entries.append(entry)
        if kind == 'directory':
            children = []
            with os.scandir(path) as iterator:
                for child in iterator:
                    name = child.name
                    child_relative = name if not relative else relative + b'/' + name
                    discovered += 1
                    if max_entries is not None and discovered > max_entries:
                        raise TreeError('entry count limit exceeded')
                    if max_path_bytes is not None and len(child_relative) > max_path_bytes:
                        raise TreeError('path byte limit exceeded: ' + repr(child_relative))
                    if (max_path_depth is not None and
                            child_relative.count(b'/') + 1 > max_path_depth):
                        raise TreeError('path depth limit exceeded: ' + repr(child_relative))
                    children.append(name)
            for child in sorted(children):
                visit(os.path.join(path, child), child if not relative else relative + b'/' + child)
        if signature(os.lstat(path)) != signature(before):
            raise TreeError('entry changed during scan: ' + repr(relative))
        checks.append((path, signature(before)))

    try:
        if not stat.S_ISDIR(os.lstat(root).st_mode):
            raise TreeError('root must be a directory, not a symlink')
        visit(root, b'')
        for path, expected in checks:
            if signature(os.lstat(path)) != expected:
                raise TreeError('entry changed during scan: ' + repr(path))
    except OSError as exc:
        raise TreeError('cannot safely inventory tree: ' + str(exc)) from exc
    groups = [sorted(paths) for paths in links.values() if len(paths) > 1]
    return {'version': 1, 'entries': sorted(entries, key=lambda e: e['path']),
            'hardlinks': sorted(groups)}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('source', help='trusted, fenced source directory')
    parser.add_argument('restored', nargs='?', help='trusted, fenced restored directory')
    args = parser.parse_args()
    try:
        source = inventory(args.source)
        if args.restored:
            restored = inventory(args.restored)
            if source != restored:
                print('Trees differ', file=sys.stderr)
                return 1
            print('Trees match')
        else:
            print(json.dumps(source, sort_keys=True, separators=(',', ':')))
    except TreeError as exc:
        print('Inventory failed: ' + str(exc), file=sys.stderr)
        return 2
    return 0


if __name__ == '__main__':
    sys.exit(main())
