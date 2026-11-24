"""Experimental offline source snapshot. Not a release authorization.

The caller must independently approve the exact full commit and operation ID.
Trust the host, repository object database, Git executable, filesystem, current
UID, and all processes with access to the private destination. This code does
not authenticate approval or defend against a hostile host, same-UID process,
or concurrent filesystem changes. Verification does not freeze the snapshot.
Git object reads do not use the worktree, archive attributes, or replacement
objects. Offline safety relies on trusted Git 2.52 or later honoring
GIT_NO_LAZY_FETCH; this is not a network sandbox. No image binding or
reproducibility is established. Resource limits do not isolate the host or
network. Durability depends on honest filesystem, kernel, and hardware fsync
semantics. The parent directory must already be durable before this operation.
If marker recreation or its directory sync fails, failure evidence remains uncertain.
Deadline checks are cooperative, not hard deadlines: blocking filesystem calls,
Popen, and direct-child cleanup can exceed them. Git cleanup only kills the
direct child and cannot guarantee descendant cleanup. Same-UID actors can alter or race all checks.
This is not production ready. Live preflight remains disabled.
"""
import hashlib
import json
import os
from pathlib import Path
import re
import selectors
import stat
import subprocess
import time

# Conservative test-only limits. They are not a host resource sandbox.
MAX_TREE_BYTES = 4 * 1024 * 1024
MAX_ENTRIES = 10000
MAX_BLOB_BYTES = 8 * 1024 * 1024
MAX_TOTAL_BLOB_BYTES = 64 * 1024 * 1024
GIT_TIMEOUT_SECONDS = 10
TOTAL_GIT_DEADLINE_SECONDS = 60
# Each build or retry uses 4 fixed Git processes plus 2 per blob.
# 521 blobs need 1046 processes; 1200 leaves 154 processes of headroom.
MAX_GIT_PROCESSES = 1200
MAX_TOTAL_GIT_OUTPUT_BYTES = 72 * 1024 * 1024
MAX_MANIFEST_BYTES = 8 * 1024 * 1024


class SnapshotError(RuntimeError):
    pass


class GitBudget:
    def __init__(self):
        self.deadline = time.monotonic() + TOTAL_GIT_DEADLINE_SECONDS
        self.remaining = MAX_GIT_PROCESSES
        self.output_remaining = MAX_TOTAL_GIT_OUTPUT_BYTES

    def check(self):
        if time.monotonic() >= self.deadline:
            raise SnapshotError('total Git deadline exceeded')

    def start(self):
        if self.remaining <= 0:
            raise SnapshotError('Git process budget exceeded')
        self.check()
        self.remaining -= 1


def git(repo, *args, max_bytes=4096, budget=None):
    budget = budget or GitBudget()
    budget.start()
    env = {'PATH': '/usr/bin:/bin', 'HOME': '/nonexistent', 'LC_ALL': 'C',
           'GIT_CONFIG_NOSYSTEM': '1', 'GIT_CONFIG_GLOBAL': '/dev/null',
           'GIT_NO_REPLACE_OBJECTS': '1', 'GIT_NO_LAZY_FETCH': '1',
           'GIT_TERMINAL_PROMPT': '0', 'GIT_OPTIONAL_LOCKS': '0'}
    p = subprocess.Popen(['git', '--no-replace-objects', '-C', str(repo), *args],
                         env=env, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    deadline = min(time.monotonic() + GIT_TIMEOUT_SECONDS, budget.deadline)
    output = bytearray()
    try:
        with selectors.DefaultSelector() as selector:
            selector.register(p.stdout, selectors.EVENT_READ)
            while True:
                remaining = deadline - time.monotonic()
                if remaining <= 0 or not selector.select(remaining):
                    raise SnapshotError('Git command timed out')
                chunk = os.read(p.stdout.fileno(), min(65536, max_bytes + 1 - len(output), budget.output_remaining + 1))
                if not chunk:
                    break
                output.extend(chunk)
                budget.output_remaining -= len(chunk)
                if budget.output_remaining < 0:
                    raise SnapshotError('aggregate Git output limit exceeded')
                if len(output) > max_bytes:
                    raise SnapshotError('Git output limit exceeded')
        try:
            code = p.wait(timeout=max(0, deadline - time.monotonic()))
        except subprocess.TimeoutExpired as exc:
            raise SnapshotError('Git command timed out') from exc
        if time.monotonic() >= budget.deadline:
            raise SnapshotError('total Git deadline exceeded')
        if code:
            raise SnapshotError('Git object read failed')
        return bytes(output)
    finally:
        if p.poll() is None:
            p.kill()
            p.wait()
        p.stdout.close()


def check_dir(path):
    s = os.lstat(path)
    if not stat.S_ISDIR(s.st_mode) or s.st_uid != os.geteuid() or stat.S_IMODE(s.st_mode) != 0o700:
        raise SnapshotError('directory must be private and owned by the current user')


def entries(repo, commit, budget=None):
    budget = budget or GitBudget()
    def read_git(*args, **kwargs):
        return git(repo, *args, budget=budget, **kwargs)

    version = read_git('--version').strip()
    match = re.match(rb'git version (\d+)\.(\d+)(?:\.|$)', version)
    if not match or tuple(map(int, match.groups())) < (2, 52):
        raise SnapshotError('offline safety requires Git 2.52 or later')
    fmt = read_git('rev-parse', '--show-object-format').strip()
    length = {b'sha1': 40, b'sha256': 64}.get(fmt)
    if not length or not re.fullmatch('[0-9a-f]{%d}' % length, commit):
        raise SnapshotError('full lowercase object ID required')
    if read_git('cat-file', '-t', commit).strip() != b'commit':
        raise SnapshotError('object is not a commit')
    result = {}
    data = read_git('ls-tree', '-rz', '--full-tree', '-r', '-t', commit, max_bytes=MAX_TREE_BYTES)
    records = data.split(b'\0')
    if len(records) - 1 > MAX_ENTRIES or (data and records[-1]):
        raise SnapshotError('tree entry limit exceeded or malformed listing')
    total = 0
    for record in records:
        budget.check()
        if not record:
            continue
        meta, rawpath = record.split(b'\t', 1)
        mode, kind, oid = meta.split(b' ')
        try:
            path = rawpath.decode('utf-8')
        except UnicodeDecodeError as exc:
            raise SnapshotError('non UTF-8 path') from exc
        parts = path.split('/')
        if any(p in ('', '.', '..') or p.lower().startswith('.env') or p.lower() == '.git' or '\\' in p or any(ord(c) < 32 or ord(c) == 127 for c in p) for p in parts):
            raise SnapshotError('unsafe path: ' + repr(path))
        if mode == b'040000' and kind == b'tree':
            result[path] = ('dir', None, None)
        elif mode in (b'100644', b'100755') and kind == b'blob':
            size_text = read_git('cat-file', '-s', oid.decode('ascii')).strip()
            if not size_text.isdigit():
                raise SnapshotError('invalid blob size')
            size = int(size_text)
            total += size
            if size > MAX_BLOB_BYTES or total > MAX_TOTAL_BLOB_BYTES:
                raise SnapshotError('blob size limit exceeded')
            content = read_git('cat-file', 'blob', oid.decode('ascii'), max_bytes=size)
            if len(content) != size:
                raise SnapshotError('blob size changed')
            if content.startswith(b'version https://git-lfs.github.com/spec/v1'):
                raise SnapshotError('LFS pointer rejected')
            result[path] = ('file', int(mode, 8) & 0o777, content)
        else:
            raise SnapshotError('unsupported tree entry: ' + repr(path))
    return result


def verify(snapshot, expected, budget=None):
    budget = budget or GitBudget()
    budget.check()
    check_dir(snapshot)
    seen = set()
    def fail_walk(error):
        raise SnapshotError('snapshot traversal failed') from error

    for root, dirs, files in os.walk(snapshot, followlinks=False, onerror=fail_walk):
        budget.check()
        if len(seen) + len(dirs) + len(files) > MAX_ENTRIES:
            raise SnapshotError('snapshot entry limit exceeded')
        for name in dirs + files:
            budget.check()
            p = Path(root) / name
            rel = p.relative_to(snapshot).as_posix()
            seen.add(rel)
            if rel not in expected:
                raise SnapshotError('unexpected path: ' + rel)
            kind, mode, content = expected[rel]
            s = p.lstat()
            if s.st_uid != os.geteuid():
                raise SnapshotError('unexpected owner: ' + rel)
            if kind == 'dir':
                if not stat.S_ISDIR(s.st_mode) or stat.S_IMODE(s.st_mode) != 0o700:
                    raise SnapshotError('invalid directory: ' + rel)
            elif not stat.S_ISREG(s.st_mode) or s.st_nlink != 1 or stat.S_IMODE(s.st_mode) != mode or s.st_size != len(content) or p.read_bytes() != content:
                raise SnapshotError('invalid file: ' + rel)
    budget.check()
    if seen != set(expected):
        raise SnapshotError('missing paths')


def make_manifest(expected, commit, operation_id):
    return {'schema': 1, 'operation_id': operation_id, 'commit': commit,
            'entries': [{'path': p, 'type': k, **({'mode': oct(m), 'sha256': hashlib.sha256(c).hexdigest()} if k == 'file' else {})}
                        for p, (k, m, c) in sorted(expected.items())]}


def manifest_bytes(manifest):
    encoded = (json.dumps(manifest, sort_keys=True, separators=(',', ':')) + '\n').encode('utf-8')
    if len(encoded) > MAX_MANIFEST_BYTES:
        raise SnapshotError('manifest size limit exceeded')
    return encoded


def verify_manifest(repo, parent, commit, operation_id):
    """Fail closed: a missing marker cannot prove publication durability."""
    raise SnapshotError('publication outcome unknown; explicit durability retry required')


def stable_stat(s):
    """Compare identity and mutation metadata, but not read-sensitive atime."""
    return (s.st_dev, s.st_ino, s.st_mode, s.st_uid, s.st_gid, s.st_nlink,
            s.st_size, s.st_mtime_ns, s.st_ctime_ns)


def retry_verify_manifest(repo, parent, commit, operation_id):
    """Explicitly revalidate and sync all data; this is not approval or isolation."""
    budget = GitBudget()
    parent = Path(parent)
    check_dir(parent)
    if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._-]{0,127}', operation_id):
        raise SnapshotError('invalid operation ID')
    budget.check()
    names = set()
    for p in parent.iterdir():
        budget.check()
        names.add(p.name)
        if len(names) > 2:
            raise SnapshotError('unexpected or partial publication')
    if names != {'snapshot', 'manifest.json'}:
        raise SnapshotError('unexpected or partial publication')
    path = parent / 'manifest.json'
    s = path.lstat()
    if s.st_size > MAX_MANIFEST_BYTES or not stat.S_ISREG(s.st_mode) or s.st_uid != os.geteuid() or s.st_nlink != 1 or stat.S_IMODE(s.st_mode) != 0o600:
        raise SnapshotError('invalid manifest file')
    expected = entries(repo, commit, budget)
    manifest = make_manifest(expected, commit, operation_id)
    encoded = manifest_bytes(manifest)
    if s.st_size != len(encoded) or path.read_bytes() != encoded:
        raise SnapshotError('manifest does not match caller and Git tree')
    budget.check()
    verify(parent / 'snapshot', expected, budget)
    sync_snapshot(parent / 'snapshot', expected, budget)
    budget.check()
    sync_file(path)
    budget.check()
    sync_dir(parent)
    budget.check()
    if stable_stat(path.lstat()) != stable_stat(s) or path.read_bytes() != encoded:
        raise SnapshotError('manifest changed during durability retry')
    verify(parent / 'snapshot', expected, budget)
    budget.check()
    return manifest


def sync_dir(parent):
    fd = os.open(parent, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def sync_file(path):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def sync_snapshot(snapshot, expected, budget=None):
    """Sync files first and directories from leaves to root, then revalidate."""
    budget = budget or GitBudget()
    paths = [snapshot / p for p in expected]
    before = {}
    for p in [snapshot] + paths:
        budget.check()
        before[p] = stable_stat(p.lstat())
    for p, (kind, _, _) in expected.items():
        budget.check()
        if kind == 'file':
            sync_file(snapshot / p)
    dirs = [snapshot / p for p, (kind, _, _) in expected.items() if kind == 'dir']
    for directory in sorted(dirs, key=lambda p: len(p.parts), reverse=True) + [snapshot]:
        budget.check()
        sync_dir(directory)
    for p, identity in before.items():
        budget.check()
        if stable_stat(p.lstat()) != identity:
            raise SnapshotError('snapshot identity changed during sync')
    verify(snapshot, expected, budget)


def build(repo, parent, commit, operation_id):
    """Create parent/snapshot and parent/manifest.json in an empty private parent.

    On failure, partial output remains and must not be used. The operation ID
    is a caller-provided binding, not proof of approval. Verify again before use.
    """
    budget = GitBudget()
    parent = Path(parent)
    check_dir(parent)
    budget.check()
    if next(parent.iterdir(), None) is not None:
        raise SnapshotError('parent must be empty')
    if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._-]{0,127}', operation_id):
        raise SnapshotError('invalid operation ID')
    expected = entries(repo, commit, budget)
    budget.check()
    snapshot = parent / 'snapshot'
    snapshot.mkdir(mode=0o700)
    for path, (kind, mode, content) in expected.items():
        budget.check()
        dest = snapshot / path
        if kind == 'dir':
            dest.mkdir(mode=0o700)
        else:
            with dest.open('xb') as f:
                f.write(content)
            dest.chmod(mode)
    budget.check()
    verify(snapshot, expected, budget)
    sync_snapshot(snapshot, expected, budget)
    budget.check()
    manifest = make_manifest(expected, commit, operation_id)
    encoded = manifest_bytes(manifest)
    budget.check()
    temporary = parent / 'manifest.json.partial'
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, 'wb') as f:
        f.write(encoded)
        budget.check()
        f.flush()
        budget.check()
        os.fsync(f.fileno())
    budget.check()
    # Hard-link publication is atomic and refuses to replace an existing name.
    os.link(temporary, parent / 'manifest.json', follow_symlinks=False)
    budget.check()
    sync_dir(parent)
    budget.check()
    temporary.unlink()
    try:
        budget.check()
        sync_dir(parent)
        budget.check()
    except (OSError, SnapshotError):
        # Preserve the original error if marker creation or durability fails.
        try:
            temporary.touch(exist_ok=False, mode=0o600)
            sync_dir(parent)
        except (OSError, SnapshotError):
            pass
        raise
    return manifest
