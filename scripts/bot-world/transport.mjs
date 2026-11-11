import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

const SAFE_NATIVE_CODES = new Set(['invalid_command', 'disabled', 'not_connected', 'network_error', 'storage_error',
  'events_pending', 'membership_changed', 'membership_unreconciled', 'unknown_bot', 'crypto_error',
  'operation_conflict', 'unknown_conversation', 'registration_error', 'key_package_unavailable',
  'key_identity_mismatch', 'protocol_error', 'auth_error', 'transport_busy', 'state_capacity_operator_rollover_required']);

// A private stdio pipe, not a listening plaintext HTTP API.
export class NativeTransport {
  constructor(binary, { env = process.env, onEvent = () => {}, onFailure = () => {} } = {}) {
    this.pending = new Map(); this.nextId = 0; this.closed = false;
    const nativeEnv = Object.fromEntries(['CHAT_BOTS_ENABLED', 'CHAT_BOT_SERVER', 'CHAT_BOT_STATE_DIR', 'CHAT_BOT_STATE_KEY']
      .filter((key) => env[key] !== undefined).map((key) => [key, env[key]]));
    this.child = spawn(binary, [], { env: nativeEnv, stdio: ['pipe', 'pipe', 'inherit'] });
    this.lines = createInterface({ input: this.child.stdout, crlfDelay: Infinity });
    let buffered = 0;
    this.child.stdout.on('data', (chunk) => {
      buffered += chunk.length;
      if (chunk.includes(10)) buffered = chunk.length - chunk.lastIndexOf(10) - 1;
      if (buffered > 2 * 1024 * 1024) this.child.kill('SIGTERM');
    });
    this.lines.on('line', (line) => {
      if (Buffer.byteLength(line) > 2 * 1024 * 1024) { this.child.kill('SIGTERM'); return; }
      let message;
      try { message = JSON.parse(line); } catch { this.child.kill('SIGTERM'); return; }
      if (message.event) { onEvent(message); return; }
      const pending = this.pending.get(message.id);
      if (!pending) return;
      clearTimeout(pending.timer); this.pending.delete(message.id);
      if (message.ok) pending.resolve(message.result);
      else {
        const error = new Error('Native bot operation failed.');
        error.nativeOperation = true;
        error.nativeCode = SAFE_NATIVE_CODES.has(message.error) ? message.error : 'operation_failed';
        pending.reject(error);
      }
    });
    const fail = () => {
      if (this.closed) return;
      this.closed = true;
      for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new Error('Native bot transport stopped.')); }
      this.pending.clear(); onFailure();
    };
    this.child.stdin.on('error', fail);
    this.child.on('error', fail); this.child.on('exit', fail);
  }
  request(op, args = {}) {
    if (this.closed || this.pending.size >= 256) return Promise.reject(new Error('Native bot transport unavailable.'));
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('Native bot operation timed out.')); }, 120000);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(`${JSON.stringify({ ...args, id, op })}\n`, (error) => {
        if (!error) return;
        const pending = this.pending.get(id);
        if (pending) { clearTimeout(timer); this.pending.delete(id); reject(new Error('Native bot input failed.')); }
      });
    });
  }
  close() { this.child.stdin.end(); this.child.kill('SIGTERM'); }
}
