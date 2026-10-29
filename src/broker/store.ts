import type pg from 'pg';
import { assertTransition, type BrokerOrder, type IntentRecord, type IntentStore, type OrderIntent, type OrderStatus } from './types';

const keyOf = (i: OrderIntent): string => JSON.stringify([i.mode, i.accountId, i.clientOrderId]);

/** Tests only. Does not survive a process restart. */
export class MemoryIntentStore implements IntentStore {
  private rows = new Map<string, IntentRecord & { at: number }>();
  constructor(private now: () => number = Date.now) {}

  async ensureAccount(): Promise<void> { /* nothing to persist */ }

  private view(r: IntentRecord & { at: number }): IntentRecord {
    const { at, ...rest } = r;
    return structuredClone({ ...rest, ageMs: this.now() - at });
  }

  async claim(intent: OrderIntent, fingerprint: string) {
    const k = keyOf(intent);
    const prior = this.rows.get(k);
    if (prior) return { created: false, record: this.view(prior) };
    const row = { intent: structuredClone(intent), fingerprint, status: 'SUBMITTING' as OrderStatus, order: null, ageMs: 0, at: this.now() };
    this.rows.set(k, row);
    return { created: true, record: this.view(row) };
  }

  async save(intent: OrderIntent, status: OrderStatus, order: BrokerOrder | null): Promise<void> {
    const row = this.rows.get(keyOf(intent));
    if (!row) throw new Error('INTENT_NOT_FOUND');
    assertTransition(row.status, status, row.order, order);
    row.status = status;
    row.order = structuredClone(order);
    row.at = this.now();
  }

  async markUnknown(intent: OrderIntent): Promise<void> {
    const row = this.rows.get(keyOf(intent));
    if (row && row.status === 'SUBMITTING') { row.status = 'UNKNOWN'; row.at = this.now(); }
  }
}

/**
 * Durable. The claim is committed before the broker is called. Every state change locks the row,
 * checks the transition, updates and appends an event in one transaction, so two concurrent
 * writers can never leave an older state on top of a newer one.
 */
export class PostgresIntentStore implements IntentStore {
  constructor(private pool: pg.Pool) {}

  async ensureAccount(accountId: string, currency: string): Promise<void> {
    await this.pool.query(
      `insert into broker_accounts(mode, account_id, currency) values ('BROKER_PAPER', $1, $2) on conflict do nothing`,
      [accountId, currency],
    );
    const r = await this.pool.query(`select currency from broker_accounts where mode='BROKER_PAPER' and account_id=$1`, [accountId]);
    if (r.rows[0].currency.trim() !== currency) throw new Error('ACCOUNT_CURRENCY_CHANGED');
  }

  async claim(intent: OrderIntent, fingerprint: string) {
    // one statement: the intent and its first audit event commit together or not at all
    const ins = await this.pool.query(
      `with ins as (
         insert into broker_order_intents(mode, account_id, client_order_id, kind, fingerprint, intent, status)
         values ('BROKER_PAPER', $1, $2, $3, $4, $5, 'SUBMITTING')
         on conflict (mode, account_id, client_order_id) do nothing
         returning mode, account_id, client_order_id)
       insert into broker_order_events(mode, account_id, client_order_id, from_status, to_status)
       select mode, account_id, client_order_id, null, 'SUBMITTING' from ins`,
      [intent.accountId, intent.clientOrderId, intent.kind, fingerprint, JSON.stringify(intent)],
    );
    const created = ins.rowCount === 1;
    const r = await this.pool.query(
      `select intent, fingerprint, status, broker_order, (extract(epoch from (now() - updated_at)) * 1000)::float8 as age_ms
         from broker_order_intents where mode='BROKER_PAPER' and account_id=$1 and client_order_id=$2`,
      [intent.accountId, intent.clientOrderId],
    );
    const row = r.rows[0];
    if (!row) throw new Error('INTENT_NOT_FOUND');
    return { created, record: { intent: row.intent, fingerprint: row.fingerprint.trim(), status: row.status, order: row.broker_order, ageMs: row.age_ms } as IntentRecord };
  }

  private async locked<T>(intent: OrderIntent, fn: (c: pg.PoolClient, status: OrderStatus, order: BrokerOrder | null) => Promise<T>): Promise<T> {
    const c = await this.pool.connect();
    try {
      await c.query('begin');
      const r = await c.query(
        `select status, broker_order from broker_order_intents where mode='BROKER_PAPER' and account_id=$1 and client_order_id=$2 for update`,
        [intent.accountId, intent.clientOrderId],
      );
      if (!r.rows[0]) throw new Error('INTENT_NOT_FOUND');
      const out = await fn(c, r.rows[0].status, r.rows[0].broker_order);
      await c.query('commit');
      return out;
    } catch (e) {
      await c.query('rollback');
      throw e;
    } finally {
      c.release();
    }
  }

  private async write(c: pg.PoolClient, intent: OrderIntent, from: OrderStatus, to: OrderStatus, order: BrokerOrder | null): Promise<void> {
    await c.query(
      `update broker_order_intents set status=$1, broker_order=$2, updated_at=now()
        where mode='BROKER_PAPER' and account_id=$3 and client_order_id=$4`,
      [to, order === null ? null : JSON.stringify(order), intent.accountId, intent.clientOrderId],
    );
    await c.query(
      `insert into broker_order_events(mode, account_id, client_order_id, from_status, to_status, broker_order) values ('BROKER_PAPER', $1, $2, $3, $4, $5)`,
      [intent.accountId, intent.clientOrderId, from, to, order === null ? null : JSON.stringify(order)],
    );
  }

  async save(intent: OrderIntent, status: OrderStatus, order: BrokerOrder | null): Promise<void> {
    await this.locked(intent, async (c, from, prior) => {
      assertTransition(from, status, prior, order);
      await this.write(c, intent, from, status, order);
    });
  }

  async markUnknown(intent: OrderIntent): Promise<void> {
    await this.locked(intent, async (c, from, prior) => {
      if (from === 'SUBMITTING') await this.write(c, intent, from, 'UNKNOWN', prior);
    });
  }
}
