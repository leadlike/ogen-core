import { z } from 'zod';
import { OrderRefused, type Broker, type BrokerAccount, type BrokerCapabilities, type BrokerOrder, type BrokerPosition, type Execution, type OrderIntent } from '../broker/types';
import { accountSchema, capabilitiesSchema, capitalViewSchema, executionsSchema, orderSchema, positionsSchema } from './wire';


/**
 * The worker's view of the broker: a Broker that forwards to the risk gateway over HTTP.
 * The worker holds a gateway token, never broker credentials.
 * Error contract: a refusal (422) or a request the gateway rejected before doing anything (400/401)
 * becomes OrderRefused, a known "not sent". Timeouts, 5xx and network errors are plain errors,
 * which the executor treats as UNCERTAIN.
 */
export class GatewayBroker implements Broker {
  private constructor(private base: string, private token: string, public readonly capabilities: BrokerCapabilities, private timeoutMs: number) {}

  static async connect(baseUrl: string, token: string, timeoutMs = 8_000): Promise<GatewayBroker> {
    const base = baseUrl.replace(/\/$/, '');
    const res = await fetch(`${base}/capabilities`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) throw new Error(`GATEWAY_UNAVAILABLE: ${res.status}`);
    return new GatewayBroker(base, token, capabilitiesSchema.parse(await res.json()), timeoutMs);
  }

  private async call<T>(path: string, body: unknown, schema: z.ZodType<T>): Promise<T> {
    let res: Response;
    try {
      res = await fetch(`${this.base}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${this.token}` },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (e) {
      throw new Error(`GATEWAY_UNREACHABLE: ${(e as Error).message}`); // outcome unknown
    }
    if (res.status === 422) {
      const j = (await res.json().catch(() => ({}))) as { code?: string };
      throw new OrderRefused(j.code ?? 'REFUSED');
    }
    if (res.status === 400 || res.status === 401) throw new OrderRefused(res.status === 401 ? 'GATEWAY_AUTH' : 'GATEWAY_BAD_REQUEST');
    if (!res.ok) throw new Error(`GATEWAY_ERROR_${res.status}`); // outcome unknown
    return schema.parse(await res.json());
  }

  account(accountId: string): Promise<BrokerAccount> { return this.call('/account', { accountId }, accountSchema); }
  positions(accountId: string): Promise<BrokerPosition[]> { return this.call('/positions', { accountId }, positionsSchema); }
  place(intent: OrderIntent): Promise<BrokerOrder> { return this.call('/place', { intent }, orderSchema) as Promise<BrokerOrder>; }
  getOrder(accountId: string, clientOrderId: string): Promise<BrokerOrder | null> {
    return this.call('/order', { accountId, clientOrderId }, orderSchema.nullable()) as Promise<BrokerOrder | null>;
  }
  executions(accountId: string, sinceMs: number): Promise<Execution[]> { return this.call('/executions', { accountId, sinceMs }, executionsSchema); }
  /** Holdings and fresh prices, for the capital panel. */
  async capital(): Promise<{ cashMinor: string; positions: Array<{ instrumentId: string; quantity: string; costMinor: string; markMinor: string | null }> }> {
    const res = await fetch(`${this.base}/capital`, { headers: { authorization: `Bearer ${this.token}` }, signal: AbortSignal.timeout(this.timeoutMs) });
    if (!res.ok) throw new Error(`GATEWAY_ERROR_${res.status}`);
    return capitalViewSchema.parse(await res.json());
  }
  /** Freezes new entries at the gateway. Only ever makes things stricter. */
  async halt(reason: string): Promise<void> { await this.call('/halt', { reason }, z.object({ ok: z.literal(true) })); }
  cancel(accountId: string, clientOrderId: string): Promise<BrokerOrder> { return this.call('/cancel', { accountId, clientOrderId }, orderSchema) as Promise<BrokerOrder>; }
}
