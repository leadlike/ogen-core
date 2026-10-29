import { createHash } from 'node:crypto';
import { integer, OrderRefused, validateIntent, type Broker, type BrokerOrder, type IntentStore, type OrderIntent } from './types';

export interface ExecutorOptions {
  /** A SUBMITTING row younger than this belongs to a call still in flight: wait, do not look up or write. */
  inflightGraceMs?: number;
}

/**
 * Sends orders to a broker's simulation account.
 * Rules: the intent is persisted before the broker call; an uncertain submission is never
 * resubmitted (only looked up by client order id); a stale state can never overwrite a newer one.
 */
export class BrokerExecutor {
  private readonly graceMs: number;
  constructor(private broker: Broker, private store: IntentStore, opts: ExecutorOptions = {}) {
    this.graceMs = opts.inflightGraceMs ?? 30_000;
  }

  private fingerprint(i: OrderIntent): string {
    return createHash('sha256').update(JSON.stringify(Object.entries(i).sort(([a], [b]) => (a < b ? -1 : 1)))).digest('hex');
  }

  private validateOrder(i: OrderIntent, o: BrokerOrder): void {
    if (o.accountId !== i.accountId || o.clientOrderId !== i.clientOrderId || !o.brokerOrderId) throw new Error('BROKER_IDENTITY_MISMATCH');
    if (!['ACCEPTED', 'PART_FILLED', 'FILLED', 'CANCELED', 'REJECTED'].includes(o.status)) throw new Error('INVALID_STATUS');
    const qty = integer(i.quantity, true);
    const filled = integer(o.filledQuantity);
    const protectedQty = integer(o.protectedQuantity);
    const exited = integer(o.exitedQuantity);
    if (filled > qty) throw new Error('FILL_OR_PROTECTION_MISMATCH');
    if (i.kind === 'BUY_BRACKET') {
      if (exited > filled || protectedQty !== filled - exited) throw new Error('FILL_OR_PROTECTION_MISMATCH');
      if (filled > 0n && (o.averageFillMinor === null || integer(o.averageFillMinor, true) > integer(i.entryLimitMinor))) throw new Error('INVALID_FILL_PRICE');
    } else {
      // a close carries no protection of its own
      if (protectedQty !== 0n || exited !== 0n) throw new Error('FILL_OR_PROTECTION_MISMATCH');
      if (filled > 0n && o.averageFillMinor === null) throw new Error('INVALID_FILL_PRICE');
    }
    if (o.status === 'FILLED' && filled !== qty) throw new Error('INCONSISTENT_FILLED_STATUS');
    if (o.status === 'PART_FILLED' && (filled === 0n || filled === qty)) throw new Error('INCONSISTENT_PARTIAL_STATUS');
    if ((o.status === 'ACCEPTED' || o.status === 'REJECTED') && filled !== 0n) throw new Error('INCONSISTENT_EMPTY_STATUS');
  }

  private async persist(i: OrderIntent, o: BrokerOrder): Promise<BrokerOrder> {
    this.validateOrder(i, o);
    await this.store.save(i, o.status, o);
    return o;
  }

  async submit(i: OrderIntent): Promise<BrokerOrder> {
    validateIntent(i);
    const c = this.broker.capabilities;
    if (!c.paper || !c.lookupByClientId) throw new Error('BROKER_CAPABILITY_REQUIRED');
    if (i.kind === 'BUY_BRACKET' && (!c.atomicBracket || !c.partialFillProtection)) throw new Error('BROKER_CAPABILITY_REQUIRED');

    const account = await this.broker.account(i.accountId);
    if (account.mode !== 'BROKER_PAPER' || account.id !== i.accountId || account.currency !== i.currency) throw new Error('ACCOUNT_MISMATCH');
    integer(account.cashMinor);
    await this.store.ensureAccount(i.accountId, i.currency);

    if (i.kind === 'CLOSE') {
      // Cheap pre-check before anything is recorded; the broker remains the authority on the shares.
      const held = (await this.broker.positions(i.accountId)).find((p) => p.instrumentId === i.instrumentId);
      if (!held || integer(held.quantity) < integer(i.quantity)) throw new Error('NO_POSITION_TO_CLOSE');
    }

    const fingerprint = this.fingerprint(i);
    const claim = await this.store.claim(i, fingerprint);
    if (claim.record.fingerprint !== fingerprint) throw new Error('IDEMPOTENCY_PAYLOAD_MISMATCH');
    if (!claim.created) {
      // Never a second placement: not after a timeout, a crash, or an empty lookup.
      if (claim.record.status === 'REJECTED' && claim.record.order) return claim.record.order; // final, nothing to look up
      if (claim.record.status === 'SUBMITTING' && claim.record.ageMs < this.graceMs) throw new Error('ORDER_IN_FLIGHT');
      return this.refresh(i);
    }

    try {
      return await this.persist(i, await this.broker.place(i));
    } catch (error) {
      if (error instanceof OrderRefused) {
        // a definite "not sent": keep that fact so the same id can never be sent later
        await this.store.save(i, 'REJECTED', {
          accountId: i.accountId, clientOrderId: i.clientOrderId, brokerOrderId: `refused:${error.code}`, status: 'REJECTED',
          filledQuantity: '0', averageFillMinor: null, protectedQuantity: '0', exitedQuantity: '0', exitReason: null,
        });
        throw error;
      }
      await this.store.markUnknown(i);
      throw new Error('ORDER_UNCERTAIN_RECONCILE_REQUIRED', { cause: error });
    }
  }

  async refresh(i: OrderIntent): Promise<BrokerOrder> {
    validateIntent(i);
    let order: BrokerOrder | null;
    try {
      order = await this.broker.getOrder(i.accountId, i.clientOrderId);
    } catch (error) {
      await this.store.markUnknown(i);
      throw new Error('ORDER_UNCERTAIN_NO_RESUBMIT', { cause: error });
    }
    if (!order) {
      await this.store.markUnknown(i);
      throw new Error('ORDER_UNCERTAIN_NO_RESUBMIT', { cause: new Error('ORDER_NOT_VISIBLE') });
    }
    return this.persist(i, order);
  }

  async cancel(i: OrderIntent): Promise<BrokerOrder> {
    validateIntent(i);
    try {
      return await this.persist(i, await this.broker.cancel(i.accountId, i.clientOrderId));
    } catch (error) {
      if ((error as Error).message.startsWith('ILLEGAL_TRANSITION')) throw error;
      await this.store.markUnknown(i);
      throw new Error('CANCEL_UNCERTAIN_RECONCILE_REQUIRED', { cause: error });
    }
  }
}
