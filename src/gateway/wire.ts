import { z } from 'zod';

const id = z.string().min(1).max(128);
const int = z.string().regex(/^\d+$/);
const base = { mode: z.literal('BROKER_PAPER'), accountId: id, clientOrderId: id, instrumentId: id, currency: z.string().regex(/^[A-Z]{3}$/), quantity: int };

export const intentSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('BUY_BRACKET'), ...base, entryLimitMinor: int, stopMinor: int, targetMinor: int }).strict(),
  z.object({ kind: z.literal('CLOSE'), ...base }).strict(),
]);

export const orderSchema = z.object({
  accountId: id, clientOrderId: id, brokerOrderId: z.string().min(1),
  status: z.enum(['ACCEPTED', 'PART_FILLED', 'FILLED', 'CANCELED', 'REJECTED']),
  filledQuantity: int, averageFillMinor: int.nullable(), protectedQuantity: int, exitedQuantity: int,
  exitReason: z.enum(['STOP', 'TARGET', 'CLOSE']).nullable(),
}).strict();

export const accountSchema = z.object({ id, mode: z.literal('BROKER_PAPER'), currency: z.string().regex(/^[A-Z]{3}$/), cashMinor: int }).strict();
export const positionsSchema = z.array(z.object({ instrumentId: id, quantity: int, costMinor: int }).strict());
export const capabilitiesSchema = z.object({ paper: z.boolean(), atomicBracket: z.boolean(), partialFillProtection: z.boolean(), lookupByClientId: z.boolean() }).strict();

export const accountReq = z.object({ accountId: id }).strict();
export const orderReq = z.object({ accountId: id, clientOrderId: id }).strict();
export const placeReq = z.object({ intent: intentSchema }).strict();
export const noteReq = z.object({ note: z.string().min(3).max(500) }).strict();
export const releaseReq = z.object({ clientOrderId: id, note: z.string().min(3).max(500) }).strict();

export const executionsSchema = z.array(z.object({
  executionId: z.string().min(1).max(128), clientOrderId: z.string().max(128).nullable(), instrumentId: id,
  side: z.enum(['BUY', 'SELL']), quantity: int, priceMinor: int, feeMinor: int, atMs: z.number().int().nonnegative(),
}).strict());
export const executionsReq = z.object({ accountId: id, sinceMs: z.number().int().nonnegative() }).strict();
export const haltReq = z.object({ reason: z.string().min(3).max(500) }).strict();

export const capitalViewSchema = z.object({
  cashMinor: int,
  positions: z.array(z.object({ instrumentId: id, quantity: int, costMinor: int, markMinor: int.nullable() }).strict()),
}).strict();

export const quoteReq = z.object({ instrumentId: id }).strict();
export const quoteSchema = z.object({
  instrumentId: id, priceMinor: int, bidMinor: int.nullable(), askMinor: int.nullable(), asOfMs: z.number().int().nonnegative(),
}).strict().nullable();
