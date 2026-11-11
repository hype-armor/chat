import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { mkdir, open, readFile, rename, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

export function stateKey(value) {
  const key = Buffer.from(value ?? '', 'base64');
  if (key.length !== 32 || key.toString('base64') !== value) throw new Error('CHAT_BOT_STATE_KEY must be canonical base64 for 32 random bytes.');
  return key;
}

// Uses Node's audited AES-GCM primitive. No plaintext state reaches disk.
export class StateStore {
  constructor(directory, key) { this.directory = directory; this.key = key; }
  async lock() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const info = await stat(this.directory);
    if ((info.mode & 0o077) !== 0) throw new Error('Controller state directory must have mode 0700.');
    this.lockPath = join(this.directory, 'controller.lock');
    const file = await open(this.lockPath, 'a', 0o600);
    await file.close();
    // Linux flock releases the lock after a crash. The child exits when this
    // process closes its private stdin pipe, including on abrupt termination.
    const child = spawn('flock', ['--nonblock', '--exclusive', this.lockPath,
      process.execPath, '-e', 'process.stdout.write("locked\\n"); process.stdin.resume();'],
    { stdio: ['pipe', 'pipe', 'ignore'], env: { PATH: '/usr/bin:/bin' } });
    await new Promise((resolve, reject) => {
      let ready = false;
      child.once('error', () => reject(new Error('Controller OS lock is unavailable.')));
      child.once('exit', () => { if (!ready) reject(new Error('Controller state directory is already locked.')); });
      child.stdout.once('data', () => { ready = true; resolve(); });
    });
    this.lockHandle = child; this.lockAlive = true;
    this.lockExited = new Promise((resolve) => child.once('exit', () => { this.lockAlive = false; resolve(); }));
  }
  async load() {
    let sealed;
    try { sealed = await readFile(join(this.directory, 'controller.enc')); }
    catch (error) { if (error.code === 'ENOENT') return null; throw new Error('Cannot read controller state.'); }
    try {
      if (sealed.length < 29 || sealed[0] !== 1) throw new Error();
      const decipher = createDecipheriv('aes-256-gcm', this.key, sealed.subarray(1, 13));
      decipher.setAAD(Buffer.from('chat-bot-controller-v1'));
      decipher.setAuthTag(sealed.subarray(13, 29));
      return JSON.parse(Buffer.concat([decipher.update(sealed.subarray(29)), decipher.final()]).toString());
    } catch { throw new Error('Controller state authentication failed; do not reset it automatically.'); }
  }
  async save(state) {
    if (!this.lockHandle || !this.lockAlive) throw new Error('Controller state is not locked.');
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    cipher.setAAD(Buffer.from('chat-bot-controller-v1'));
    const body = Buffer.concat([cipher.update(JSON.stringify(state), 'utf8'), cipher.final()]);
    const sealed = Buffer.concat([Buffer.from([1]), iv, cipher.getAuthTag(), body]);
    const temporary = join(this.directory, `controller-${randomBytes(8).toString('hex')}.tmp`);
    const handle = await open(temporary, 'wx', 0o600);
    try { await handle.writeFile(sealed); await handle.sync(); } finally { await handle.close(); }
    await rename(temporary, join(this.directory, 'controller.enc'));
    const directory = await open(this.directory, 'r');
    try { await directory.sync(); } finally { await directory.close(); }
  }
  async close() {
    if (!this.lockHandle) return;
    this.lockHandle.stdin.end(); this.lockHandle = null;
    await this.lockExited;
  }
}
