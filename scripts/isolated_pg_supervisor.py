"""Experimental supervisor for fresh disposable local PostgreSQL test clusters.

This is not a deployment boundary. The caller must trust the binary tree,
its libraries, the runtime parent and all processes with the same UID. In
particular, pre/post checks cannot prevent a transient endpoint substitution
between checks. Never use this with existing data or a live deployment.
"""
import os
import pwd
import re
import secrets
import selectors
import shutil
import signal
import stat
import subprocess
import tempfile
import time


class EndpointError(RuntimeError):
    pass


class _StartupNotReady(EndpointError):
    pass


def identity(path):
    s = os.lstat(path)
    return (s.st_dev, s.st_ino, s.st_mode, s.st_uid)


class IsolatedPostgres:
    """Own one initdb cluster and its direct postgres child.

    Commands and their arguments must be trusted and must not override libpq
    connection options. Directory ancestry and binary contents must be trusted
    throughout the instance lifetime. The class does not fence same-UID peers.
    """
    def __init__(self, *, bindir, share, parent, library_path=None, port=55432, superuser=None):
        self.bindir = os.path.abspath(bindir)
        self.share = os.path.abspath(share)
        self.parent = os.path.abspath(parent)
        self.port = int(port)
        if not 1 <= self.port <= 65535:
            raise ValueError('invalid port')
        self.token = 'test_' + secrets.token_hex(16)
        self.superuser = superuser if superuser is not None else pwd.getpwuid(os.geteuid()).pw_name
        if not re.fullmatch(r'[A-Za-z_][A-Za-z_0-9-]{0,62}', self.superuser):
            raise ValueError('invalid superuser')
        self.env = {'PATH': self.bindir, 'HOME': self.parent, 'LC_ALL': 'C',
                    'PGUSER': self.superuser,
                    'PGCONNECT_TIMEOUT': '3'}
        if library_path:
            self.env['LD_LIBRARY_PATH'] = os.path.abspath(library_path)
        self.root = None
        self.process = None
        self.dirfd = None
        self.socket_id = None
        self.closed = False

    def _bin(self, name):
        return os.path.join(self.bindir, name)

    def __enter__(self):
        try:
            self.root = tempfile.mkdtemp(prefix='pg-supervisor-', dir=self.parent)
            os.chmod(self.root, 0o700)
            self.dirfd = os.open(self.root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC)
            self.root_id = identity(self.root)
            self.data = os.path.join(self.root, 'data')
            self.socket = os.path.join(self.root, '.s.PGSQL.' + str(self.port))
            self._initdb()
            self.data_id = identity(self.data)
            self.process = subprocess.Popen([self._bin('postgres'), '-D', self.data,
                '-c', 'listen_addresses=', '-c', 'unix_socket_directories=' + self.root,
                '-c', 'port=' + str(self.port), '-c', 'cluster_name=' + self.token],
                env=self.env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                start_new_session=True)
            deadline = time.monotonic() + 30
            while time.monotonic() < deadline:
                if self.process.poll() is not None:
                    raise EndpointError('postgres exited during startup')
                try:
                    info = os.lstat(self.socket)
                    if not stat.S_ISSOCK(info.st_mode):
                        raise EndpointError('endpoint is not a socket')
                    if self.socket_id is None:
                        self.socket_id = identity(self.socket)
                    self.check(_startup=True)
                    self._probe()
                    return self
                except FileNotFoundError:
                    time.sleep(0.05)
                except (subprocess.CalledProcessError, _StartupNotReady):
                    time.sleep(0.05)
            raise EndpointError('postgres startup timed out')
        except BaseException:
            self.close()
            raise

    def _initdb(self):
        args = [self._bin('initdb'), '-D', self.data, '-L', self.share,
                '-U', self.superuser, '--auth=trust']
        child = subprocess.Popen(args, env=self.env, stdout=subprocess.DEVNULL,
                                 stderr=subprocess.PIPE)
        deadline = time.monotonic() + 60
        diagnostic = bytearray()
        try:
            with selectors.DefaultSelector() as selector:
                selector.register(child.stderr, selectors.EVENT_READ)
                while selector.get_map():
                    remaining = deadline - time.monotonic()
                    if remaining <= 0:
                        raise subprocess.TimeoutExpired(args, 60)
                    for key, _ in selector.select(remaining):
                        data = os.read(key.fd, 65537 - len(diagnostic))
                        if not data:
                            selector.unregister(key.fileobj)
                        else:
                            diagnostic.extend(data)
                            if len(diagnostic) > 65536:
                                raise EndpointError('initdb diagnostics exceed 65536 bytes')
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise subprocess.TimeoutExpired(args, 60)
            if child.wait(timeout=remaining):
                raise subprocess.CalledProcessError(child.returncode, args, stderr=bytes(diagnostic))
        finally:
            try:
                if child.poll() is None:
                    child.kill()
                child.wait(timeout=5)
            finally:
                child.stderr.close()

    def check(self, *, _startup=False):
        try:
            if self.closed or self.process is None or self.process.poll() is not None:
                raise EndpointError('postgres child is not running')
            if identity(self.root) != self.root_id or identity(self.data) != self.data_id:
                raise EndpointError('cluster directory replaced')
            fd = os.fstat(self.dirfd)
            if (fd.st_dev, fd.st_ino, fd.st_mode, fd.st_uid) != self.root_id:
                raise EndpointError('runtime directory changed')
            if identity(self.socket) != self.socket_id or not stat.S_ISSOCK(self.socket_id[2]):
                raise EndpointError('socket replaced')
            with open(os.path.join(self.data, 'postmaster.pid'), encoding='ascii') as f:
                lines = f.read(4096).splitlines()
            if len(lines) < 4 or lines[0] != str(self.process.pid) or lines[1] != self.data or lines[3] != str(self.port):
                raise EndpointError('postmaster identity mismatch')
            # PostgreSQL creates the socket before it records its directory.
            # splitlines() can omit a missing final field or preserve an empty
            # field when another newline or later fields are present.
            if len(lines) == 4 or lines[4] == '':
                if _startup:
                    raise _StartupNotReady('postmaster socket directory not recorded yet')
                raise EndpointError('postmaster identity mismatch')
            if lines[4] != self.root:
                raise EndpointError('postmaster identity mismatch')
            if len(lines) < 6:
                if _startup:
                    raise _StartupNotReady('postmaster identity incomplete')
                raise EndpointError('postmaster identity mismatch')
        except (OSError, UnicodeError) as exc:
            raise EndpointError('endpoint identity unavailable') from exc

    def _environment(self):
        return dict(self.env, PGHOST=self.root, PGPORT=str(self.port), PGDATABASE='postgres')

    def _probe(self):
        """Fail closed above 4096 bytes per stream or after 5 seconds.

        Drain both pipes concurrently. The limits include all whitespace and
        diagnostic output. Only the direct client child is managed here.
        """
        limit = 4096
        timeout = 5
        args = [self._bin('psql'), '-X', '-qAt', '-w', '-v',
                'ON_ERROR_STOP=1', '-c', 'SHOW cluster_name']
        deadline = time.monotonic() + timeout
        child = subprocess.Popen(args, env=self._environment(), stdout=subprocess.PIPE,
                                 stderr=subprocess.PIPE)
        output = {'stdout': bytearray(), 'stderr': bytearray()}
        try:
            with selectors.DefaultSelector() as selector:
                selector.register(child.stdout, selectors.EVENT_READ, 'stdout')
                selector.register(child.stderr, selectors.EVENT_READ, 'stderr')
                while selector.get_map():
                    remaining = deadline - time.monotonic()
                    if remaining <= 0:
                        raise subprocess.TimeoutExpired(args, timeout)
                    for key, _ in selector.select(remaining):
                        buf = output[key.data]
                        chunk = os.read(key.fd, limit - len(buf) + 1)
                        if not chunk:
                            selector.unregister(key.fileobj)
                        else:
                            buf.extend(chunk)
                            if len(buf) > limit:
                                raise EndpointError('probe ' + key.data + ' exceeds 4096 bytes')
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise subprocess.TimeoutExpired(args, timeout)
            child.wait(timeout=remaining)
            if child.returncode:
                raise subprocess.CalledProcessError(child.returncode, args,
                                                    bytes(output['stdout']), bytes(output['stderr']))
            if bytes(output['stdout']).strip() != self.token.encode('ascii'):
                raise EndpointError('cluster identifier mismatch')
        finally:
            try:
                if child.poll() is None:
                    child.kill()
                # An uninterruptible child can outlive this bounded wait.
                child.wait(timeout=5)
            finally:
                child.stdout.close()
                child.stderr.close()

    def run(self, program, args, *, timeout=120, **kwargs):
        """Run a trusted PostgreSQL client; verify identity on both sides.

        An interrupted or failed command can have made database changes. A
        failed post-check invalidates its result and does not undo effects.
        """
        if program not in ('psql', 'createdb', 'dropdb', 'pg_dump', 'pg_restore'):
            raise ValueError('unsupported client')
        self.check()
        self._probe()
        self.check()
        try:
            return subprocess.run([self._bin(program), *args], env=self._environment(),
                                  check=True, timeout=timeout, **kwargs)
        finally:
            self.check()
            self._probe()
            self.check()

    def close(self):
        if self.closed:
            return
        self.closed = True
        # Popen owns this unreaped direct child, so its PID cannot be recycled.
        if self.process is not None and self.process.poll() is None:
            self.process.send_signal(signal.SIGTERM)
            try:
                self.process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                self.process.kill()
                try:
                    self.process.wait(timeout=5)
                except subprocess.TimeoutExpired as exc:
                    if self.dirfd is not None:
                        os.close(self.dirfd)
                        self.dirfd = None
                    # Keep the cluster directory while the child may still use it.
                    raise EndpointError('postgres did not terminate after kill; cleanup refused') from exc
        if self.dirfd is not None:
            os.close(self.dirfd)
            self.dirfd = None
        if self.root is not None:
            try:
                if identity(self.root) != self.root_id:
                    raise EndpointError('runtime directory replaced; cleanup refused')
            except FileNotFoundError:
                raise EndpointError('runtime directory missing; cleanup refused') from None
            shutil.rmtree(self.root)

    def __exit__(self, *args):
        self.close()
