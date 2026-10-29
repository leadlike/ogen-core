import { closeSync, existsSync, fsyncSync, linkSync, openSync, readFileSync, renameSync, unlinkSync, writeSync, appendFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { z } from 'zod';

const minor = z.string().regex(/^-?\d+$/);
const breaker = z.object({ reason: z.string(), atMs: z.number(), equityMinor: minor }).strict().nullable();
const stateSchema = z.object({
  version: z.literal(1),
  day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  dayStartEquityMinor: minor,
  highWaterMinor: minor,
  breakers: z.object({ dailyLoss: breaker, drawdown: breaker, reconciliation: breaker.default(null) }).strict(),
  /** entries approved and sent (or possibly sent) whose outcome the gateway has not yet seen resolved */
  reservations: z.record(z.string(), z.object({
    instrumentId: z.string(), quantity: minor, limitMinor: minor, atMs: z.number(),
  }).strict()),
  flattened: z.array(z.string()),
  /** the protective stop of the position (or working entry) per instrument, to total the risk still open */
  stops: z.record(z.string(), z.object({ limitMinor: minor, stopMinor: minor, quantity: minor }).strict()).default({}),
}).strict();
export type GatewayState = z.infer<typeof stateSchema>;

/** locks held by this process, released together at exit (one listener, however many gateways) */
const held = new Set<StateFile>();
let exitHooked = false;

function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; }
}

/**
 * The only durable memory of the gateway. Written atomically (temp file, fsync, rename), so a
 * crash leaves either the old or the new state. A file that exists but cannot be parsed is an
 * error, never an empty state: a gateway that forgot a tripped breaker would be worse than a stopped one.
 */
export interface StateFileOptions {
  /**
   * Allow taking over a lock held on ANOTHER host when its heartbeat is older than this. Needed where the
   * state lives on a shared volume and a replacement task has a new hostname (ECS + EFS). Unset: a lock from
   * another host is never taken over. Pick a value well above the heartbeat interval and any clock skew.
   */
  staleAfterMs?: number;
  /** how often the owner refreshes the heartbeat; defaults to a quarter of staleAfterMs */
  heartbeatMs?: number;
}

export class StateFile {
  private lock: { token: string; timer: NodeJS.Timeout | null } | null = null;
  /** called if the lock is found taken by someone else while we thought we held it: this instance must stop acting */
  onLockLost: (() => void) | null = null;
  constructor(private path: string, private opts: StateFileOptions = {}) {}

  get lockPath(): string { return `${this.path}.lock`; }

  /**
   * Single-instance lock. Two gateways on one state file would each approve "the last" headroom and
   * overwrite each other's breakers, so a second instance must refuse to start, not wait or share.
   * Created exclusively (wx). A lock left by a dead process on THIS host is taken over; a live
   * owner, another host, or a lock we cannot read all refuse: guessing wrong here means two
   * gateways, which is worse than a manual `rm`. A reused pid also looks alive and refuses (safe side).
   */
  acquire(): void {
    if (this.lock) return;
    const token = randomUUID();
    const body = () => JSON.stringify({ pid: process.pid, host: hostname(), startedAt: new Date().toISOString(), heartbeatAt: Date.now(), token });
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const fd = openSync(this.lockPath, 'wx', 0o600);
        try { writeSync(fd, body()); fsyncSync(fd); } finally { closeSync(fd); }
        held.add(this);
        if (!exitHooked) { exitHooked = true; process.on('exit', () => { for (const f of [...held]) f.release(); }); }
        this.lock = { token, timer: null };
        if (this.opts.staleAfterMs) this.startHeartbeat(token, body);
        return;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      }
      const raw = (() => { try { return readFileSync(this.lockPath, 'utf8'); } catch { return null; } })();
      if (raw === null) continue; // vanished between the two calls: try again
      let owner: { pid?: unknown; host?: unknown; token?: unknown; heartbeatAt?: unknown };
      try { owner = JSON.parse(raw); } catch { throw new Error(`LOCKED: ${this.lockPath} exists and is unreadable; remove it only if no gateway runs`); }
      if (typeof owner.pid !== 'number' || typeof owner.host !== 'string') throw new Error(`LOCKED: ${this.lockPath} has an unknown format; remove it only if no gateway runs`);
      if (owner.host !== hostname()) {
        // another machine: only a heartbeat that has stopped for long enough proves its owner is gone
        const hb = typeof owner.heartbeatAt === 'number' ? owner.heartbeatAt : null;
        if (!this.opts.staleAfterMs || hb === null || Date.now() - hb <= this.opts.staleAfterMs) {
          throw new Error(`LOCKED: held by pid ${owner.pid} on host ${owner.host}`);
        }
      } else if (pidAlive(owner.pid)) {
        throw new Error(`LOCKED: another gateway (pid ${owner.pid}) is running on this state file`);
      }
      // dead owner: move the stale lock aside atomically (only one contender wins the rename)
      const aside = `${this.lockPath}.stale.${token}`;
      try { renameSync(this.lockPath, aside); } catch { continue; }
      if (readFileSync(aside, 'utf8') !== raw) {
        // we moved a lock that was not the stale one we read: put it back if the slot is still free
        try { linkSync(aside, this.lockPath); } catch { /* someone else holds the slot now */ }
        try { unlinkSync(aside); } catch { /* ignore */ }
        throw new Error('LOCKED: lock changed hands during takeover; retry');
      }
      try { unlinkSync(aside); } catch { /* ignore */ }
    }
    throw new Error('LOCKED: could not acquire the lock');
  }

  private startHeartbeat(token: string, body: () => string): void {
    const every = this.opts.heartbeatMs ?? Math.max(1_000, Math.floor(this.opts.staleAfterMs! / 4));
    const timer = setInterval(() => {
      try {
        const owner = JSON.parse(readFileSync(this.lockPath, 'utf8')) as { token?: string };
        if (owner.token !== token) throw new Error('taken');
        const tmp = `${this.lockPath}.hb`;
        const fd = openSync(tmp, 'w', 0o600);
        try { writeSync(fd, body()); fsyncSync(fd); } finally { closeSync(fd); }
        renameSync(tmp, this.lockPath);
      } catch {
        // lock gone or taken: we are no longer the single instance
        this.loseLock();
      }
    }, every);
    timer.unref();
    this.lock!.timer = timer;
  }

  private loseLock(): void {
    if (!this.lock) return;
    if (this.lock.timer) clearInterval(this.lock.timer);
    this.lock = null;
    held.delete(this);
    this.onLockLost?.();
  }

  /**
   * Synchronous proof of ownership, read from the lock file itself. The heartbeat alone leaves a window: a
   * process frozen past the stale limit (VM pause, storage stall) wakes up believing it still owns the lock
   * until its next tick. Call this immediately before anything that sends an order or writes the state.
   * Throws LOCK_LOST, and fences the gateway, if the lock now belongs to someone else.
   */
  assertOwner(): void {
    if (!this.lock) throw new Error('LOCK_LOST: this instance does not hold the state lock');
    try {
      const owner = JSON.parse(readFileSync(this.lockPath, 'utf8')) as { token?: string };
      if (owner.token === this.lock.token) return;
    } catch { /* unreadable or gone: treat as lost */ }
    this.loseLock();
    throw new Error('LOCK_LOST: the state lock was taken by another instance');
  }

  /** Removes the lock if (and only if) this instance still owns it. Safe to call twice. */
  release(): void {
    if (!this.lock) return;
    const { token, timer } = this.lock;
    if (timer) clearInterval(timer);
    this.lock = null;
    held.delete(this);
    try {
      const owner = JSON.parse(readFileSync(this.lockPath, 'utf8')) as { token?: string };
      if (owner.token === token) unlinkSync(this.lockPath);
    } catch { /* already gone */ }
  }

  load(): GatewayState | null {
    if (!existsSync(this.path)) return null;
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(this.path, 'utf8'));
    } catch (e) {
      throw new Error(`STATE_CORRUPT: ${this.path} is not valid JSON (${(e as Error).message}); refusing to start`);
    }
    const parsed = stateSchema.safeParse(raw);
    if (!parsed.success) throw new Error(`STATE_CORRUPT: ${this.path} failed validation; refusing to start`);
    return parsed.data;
  }

  save(state: GatewayState): void {
    const tmp = `${this.path}.tmp`;
    const fd = openSync(tmp, 'w', 0o600);
    try {
      writeSync(fd, JSON.stringify(state));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, this.path);
  }

  /** Append-only decision log, one JSON object per line. */
  audit(entry: Record<string, unknown>): void {
    appendFileSync(`${this.path}.audit.jsonl`, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n', { mode: 0o600 });
  }
}
