import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type pg from 'pg';
import { closePool, resetDb } from './dbhelper';
import { BrokerExecutor } from '../src/broker/executor';
import { FakeBroker } from '../src/broker/fake';
import { MemoryIntentStore, PostgresIntentStore } from '../src/broker/store';
import { validateIntent, type BuyBracketIntent, type CloseIntent, type OrderIntent } from '../src/broker/types';

const buy = (id = 'order-1', over: Partial<BuyBracketIntent> = {}): BuyBracketIntent => ({
  kind: 'BUY_BRACKET', mode: 'BROKER_PAPER', accountId: 'test-paper', clientOrderId: id, instrumentId: 'TESTEQ', currency: 'USD',
  quantity: '3', entryLimitMinor: '1000', stopMinor: '900', targetMinor: '1250', ...over,
});
const close = (id = 'close-1', qty = '2'): CloseIntent => ({
  kind: 'CLOSE', mode: 'BROKER_PAPER', accountId: 'test-paper', clientOrderId: id, instrumentId: 'TESTEQ', currency: 'USD', quantity: qty,
});

/** Same fake, but placement takes real time so that concurrent callers genuinely overlap. */
class SlowFake extends FakeBroker {
  override async place(i: OrderIntent) {
    await new Promise((r) => setTimeout(r, 60));
    return super.place(i);
  }
}

let pool: pg.Pool;
beforeEach(async () => { pool = await resetDb(); });
afterAll(async () => { await closePool(); });

const statuses = async (id: string) =>
  (await pool.query(`select to_status from broker_order_events where client_order_id=$1 order by id`, [id])).rows.map((r) => r.to_status);
const dbStatus = async (id: string) =>
  (await pool.query(`select status from broker_order_intents where client_order_id=$1`, [id])).rows[0]?.status;

describe('idempotency and ambiguity (PostgreSQL store)', () => {
  it('accepts a bracket and never places a duplicate', async () => {
    const broker = new FakeBroker();
    const ex = new BrokerExecutor(broker, new PostgresIntentStore(pool), { inflightGraceMs: 0 });
    expect((await ex.submit(buy())).status).toBe('ACCEPTED');
    expect((await ex.submit(buy())).status).toBe('ACCEPTED');
    expect(broker.placeCalls).toBe(1);
    expect(await statuses('order-1')).toEqual(['SUBMITTING', 'ACCEPTED', 'ACCEPTED']);
  });

  it('concurrent requests place once and the in-flight one is not overwritten with UNKNOWN', async () => {
    const broker = new SlowFake();
    const ex = new BrokerExecutor(broker, new PostgresIntentStore(pool));
    const results = await Promise.allSettled([ex.submit(buy()), ex.submit(buy()), ex.submit(buy())]);
    expect(broker.placeCalls).toBe(1);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected').every((r) => String((r as PromiseRejectedResult).reason).includes('ORDER_IN_FLIGHT'))).toBe(true);
    expect(await dbStatus('order-1')).toBe('ACCEPTED');
    expect(await statuses('order-1')).toEqual(['SUBMITTING', 'ACCEPTED']);
  });

  it('same key with a changed payload is rejected', async () => {
    const broker = new FakeBroker();
    const ex = new BrokerExecutor(broker, new PostgresIntentStore(pool));
    await ex.submit(buy());
    await expect(ex.submit(buy('order-1', { quantity: '4' }))).rejects.toThrow('PAYLOAD_MISMATCH');
    expect(broker.placeCalls).toBe(1);
  });

  it('timeout after acceptance: a NEW process with a NEW store recovers by lookup, no second order', async () => {
    const broker = new FakeBroker();
    broker.scenario = 'TIMEOUT_AFTER_ACCEPT';
    await expect(new BrokerExecutor(broker, new PostgresIntentStore(pool)).submit(buy())).rejects.toThrow('UNCERTAIN');
    expect(await dbStatus('order-1')).toBe('UNKNOWN');
    // restart: nothing in memory, only the database
    const restarted = new BrokerExecutor(broker, new PostgresIntentStore(pool), { inflightGraceMs: 0 });
    expect((await restarted.submit(buy())).status).toBe('ACCEPTED');
    expect(broker.placeCalls).toBe(1);
    expect(await dbStatus('order-1')).toBe('ACCEPTED');
  });

  it('crash between claim and broker call leaves SUBMITTING; after the grace period it is looked up, never resubmitted', async () => {
    const broker = new FakeBroker();
    const store = new PostgresIntentStore(pool);
    await store.ensureAccount('test-paper', 'USD');
    await store.claim(buy(), new BrokerExecutor(broker, store)['fingerprint'](buy())); // process died here
    const early = new BrokerExecutor(broker, store, { inflightGraceMs: 60_000 });
    await expect(early.submit(buy())).rejects.toThrow('ORDER_IN_FLIGHT');
    const later = new BrokerExecutor(broker, store, { inflightGraceMs: 0 });
    await expect(later.submit(buy())).rejects.toThrow('NO_RESUBMIT');
    expect(broker.placeCalls).toBe(0);
    expect(await dbStatus('order-1')).toBe('UNKNOWN');
  });

  it('empty lookup after a pre-acceptance timeout never causes a resubmit', async () => {
    const broker = new FakeBroker();
    broker.scenario = 'TIMEOUT_BEFORE_ACCEPT';
    const ex = new BrokerExecutor(broker, new PostgresIntentStore(pool), { inflightGraceMs: 0 });
    await expect(ex.submit(buy())).rejects.toThrow('UNCERTAIN');
    await expect(ex.submit(buy())).rejects.toThrow('NO_RESUBMIT');
    expect(broker.placeCalls).toBe(1);
  });

  it('a response with fills but no protection is treated as uncertain, not accepted', async () => {
    const broker = new FakeBroker();
    const real = broker.place.bind(broker);
    vi.spyOn(broker, 'place').mockImplementation(async (i) => ({ ...(await real(i)), filledQuantity: '1', averageFillMinor: '1000', protectedQuantity: '0', status: 'PART_FILLED' }));
    await expect(new BrokerExecutor(broker, new PostgresIntentStore(pool)).submit(buy())).rejects.toThrow('UNCERTAIN');
    expect(await dbStatus('order-1')).toBe('UNKNOWN');
  });
});

describe('state can only move forward', () => {
  it('a stale or backwards write is refused by the database store', async () => {
    const broker = new FakeBroker();
    broker.scenario = 'PARTIAL';
    const store = new PostgresIntentStore(pool);
    const ex = new BrokerExecutor(broker, store);
    const first = await ex.submit(buy());
    expect(first.status).toBe('PART_FILLED');
    broker.fill('order-1', '3', '1000');
    const last = await ex.refresh(buy());
    expect(last.status).toBe('FILLED');
    // a slow reader now tries to write the older snapshot
    await expect(store.save(buy(), 'PART_FILLED', first)).rejects.toThrow('ILLEGAL_TRANSITION');
    await expect(store.save(buy(), 'ACCEPTED', { ...last, status: 'ACCEPTED' })).rejects.toThrow('ILLEGAL_TRANSITION');
    expect(await dbStatus('order-1')).toBe('FILLED');
  });

  it('the same rules hold in the in-memory store', async () => {
    const broker = new FakeBroker();
    broker.scenario = 'PARTIAL';
    const store = new MemoryIntentStore();
    const ex = new BrokerExecutor(broker, store);
    const first = await ex.submit(buy());
    broker.fill('order-1', '3', '1000');
    await ex.refresh(buy());
    await expect(store.save(buy(), 'PART_FILLED', first)).rejects.toThrow('ILLEGAL_TRANSITION');
  });

  it('the event history is append-only', async () => {
    await new BrokerExecutor(new FakeBroker(), new PostgresIntentStore(pool)).submit(buy());
    await expect(pool.query(`update broker_order_events set to_status='FILLED'`)).rejects.toThrow('append-only');
    await expect(pool.query(`delete from broker_order_events`)).rejects.toThrow('append-only');
  });
});

describe('protection lives at the broker', () => {
  async function filled() {
    const broker = new FakeBroker();
    const ex = new BrokerExecutor(broker, new PostgresIntentStore(pool));
    await ex.submit(buy());
    broker.fill('order-1', '3', '1000'); // cash 50000 - 3000
    await ex.refresh(buy());
    return { broker, ex };
  }

  it('partial fill: protection covers only filled shares; cancel keeps it', async () => {
    const broker = new FakeBroker();
    broker.scenario = 'PARTIAL';
    const ex = new BrokerExecutor(broker, new PostgresIntentStore(pool));
    const o = await ex.submit(buy());
    expect([o.status, o.protectedQuantity]).toEqual(['PART_FILLED', '1']);
    const c = await ex.cancel(buy());
    expect([c.status, c.protectedQuantity]).toEqual(['CANCELED', '1']);
    expect(await broker.positions('test-paper')).toEqual([{ instrumentId: 'TESTEQ', quantity: '1', costMinor: '1000' }]);
  });

  it('the stop fires with no worker involved, and the executor sees it on the next refresh', async () => {
    const { broker, ex } = await filled();
    broker.tick('TESTEQ', '900');
    const o = await ex.refresh(buy());
    expect([o.exitedQuantity, o.protectedQuantity, o.exitReason]).toEqual(['3', '0', 'STOP']);
    expect(await broker.positions('test-paper')).toEqual([]);
    expect((await broker.account('test-paper')).cashMinor).toBe('49700'); // 50000 - 3000 + 3*900
  });

  it('a gap through the stop fills at the worse price, not at the stop price', async () => {
    const { broker } = await filled();
    broker.tick('TESTEQ', '820');
    expect((await broker.account('test-paper')).cashMinor).toBe('49460'); // 47000 + 3*820
  });

  it('the target fires at the target', async () => {
    const { broker, ex } = await filled();
    broker.tick('TESTEQ', '1300');
    const o = await ex.refresh(buy());
    expect(o.exitReason).toBe('TARGET');
    expect((await broker.account('test-paper')).cashMinor).toBe('50750'); // 47000 + 3*1250
  });

  it('price between stop and target changes nothing', async () => {
    const { broker, ex } = await filled();
    broker.tick('TESTEQ', '1000');
    expect((await ex.refresh(buy())).exitedQuantity).toBe('0');
  });
});

describe('closing positions (SELL) needs no stop', () => {
  async function filled() {
    const broker = new FakeBroker();
    const ex = new BrokerExecutor(broker, new PostgresIntentStore(pool));
    await ex.submit(buy());
    broker.fill('order-1', '3', '1000');
    await ex.refresh(buy());
    broker.tick('TESTEQ', '1100');
    return { broker, ex };
  }

  it('sells part of a position and lowers the protected quantity with it', async () => {
    const { broker, ex } = await filled();
    const sold = await ex.submit(close('close-1', '2'));
    expect([sold.status, sold.filledQuantity, sold.averageFillMinor]).toEqual(['FILLED', '2', '1100']);
    expect((await broker.getOrder('test-paper', 'order-1'))!.protectedQuantity).toBe('1');
    expect(await broker.positions('test-paper')).toEqual([{ instrumentId: 'TESTEQ', quantity: '1', costMinor: '1000' }]);
    expect((await broker.account('test-paper')).cashMinor).toBe('49200'); // 47000 + 2*1100
  });

  it('after a full close the old stop cannot sell the same shares again', async () => {
    const { broker, ex } = await filled();
    await ex.submit(close('close-all', '3'));
    broker.tick('TESTEQ', '800'); // would have hit the stop
    expect(await broker.positions('test-paper')).toEqual([]);
    expect((await broker.account('test-paper')).cashMinor).toBe('50300'); // 47000 + 3*1100, no second sale
  });

  it('refuses to sell shares it does not hold, before anything is recorded', async () => {
    const { broker, ex } = await filled();
    const before = broker.placeCalls;
    await expect(ex.submit(close('close-big', '4'))).rejects.toThrow('NO_POSITION_TO_CLOSE');
    expect(broker.placeCalls).toBe(before);
    expect(await dbStatus('close-big')).toBeUndefined();
  });

  it('a close with no market price is rejected by the broker, never filled at an invented price', async () => {
    const broker = new FakeBroker();
    const ex = new BrokerExecutor(broker, new PostgresIntentStore(pool));
    await ex.submit(buy());
    broker.fill('order-1', '3', '1000'); // no tick: the fake has no mark
    expect((await ex.submit(close('close-nomark', '1'))).status).toBe('REJECTED');
  });
});

describe('boundaries', () => {
  it('LIVE is refused before any broker call', async () => {
    const broker = new FakeBroker();
    await expect(new BrokerExecutor(broker, new PostgresIntentStore(pool)).submit({ ...buy(), mode: 'LIVE' } as unknown as OrderIntent)).rejects.toThrow('PAPER_ONLY');
    expect(broker.placeCalls).toBe(0);
  });

  it('a broker without atomic brackets cannot take a bracket order', async () => {
    const broker = new FakeBroker();
    broker.capabilities.atomicBracket = false;
    await expect(new BrokerExecutor(broker, new PostgresIntentStore(pool)).submit(buy())).rejects.toThrow('CAPABILITY');
    expect(broker.placeCalls).toBe(0);
  });

  it('currency mismatch is refused', async () => {
    const broker = new FakeBroker();
    await expect(new BrokerExecutor(broker, new PostgresIntentStore(pool)).submit(buy('o', { currency: 'EUR' }))).rejects.toThrow('ACCOUNT_MISMATCH');
    expect(broker.placeCalls).toBe(0);
  });

  it('whole shares and ordered prices are required', () => {
    expect(() => validateIntent(buy('o', { quantity: '0.5' }))).toThrow();
    expect(() => validateIntent(buy('o', { stopMinor: '1100' }))).toThrow('INVALID_BRACKET_PRICES');
    expect(() => validateIntent(buy('o', { targetMinor: '1000' }))).toThrow('INVALID_BRACKET_PRICES');
  });

  it('the database itself keeps BROKER_PAPER apart from the other modes and requires a registered account', async () => {
    await expect(pool.query(
      `insert into broker_order_intents(mode,account_id,client_order_id,kind,fingerprint,intent,status) values ('PAPER','a','c','CLOSE',repeat('0',64),'{}','SUBMITTING')`,
    )).rejects.toThrow();
    await expect(pool.query(
      `insert into broker_order_intents(mode,account_id,client_order_id,kind,fingerprint,intent,status) values ('BROKER_PAPER','nobody','c','CLOSE',repeat('0',64),'{}','SUBMITTING')`,
    )).rejects.toThrow('foreign key');
  });

  it('BROKER_PAPER market data must be real, never fixtures', async () => {
    await expect(pool.query(
      `insert into market_snapshots(mode,mint,pool,provider,origin,data_ts,payload) values ('BROKER_PAPER','X','p','t','fixture',now(),'{}')`,
    )).rejects.toThrow('snapshot_origin_matches_mode');
  });
});
