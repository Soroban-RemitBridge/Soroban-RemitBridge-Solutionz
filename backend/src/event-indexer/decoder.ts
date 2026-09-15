import { scValToNative, xdr } from '@stellar/stellar-sdk';

import { EVENT_TOPICS } from '../config/constants.js';

/**
 * Event decoding.
 *
 * The contract already emitted everything needed to reconcile a payment; this
 * module's job is to refuse to guess. An unrecognised topic or an unexpected
 * payload shape produces an explicit failure rather than a partially-populated
 * row, because a silently-defaulted `amount: 0` in a remittance ledger is far
 * worse than an indexing gap someone has to fix.
 */

export type EventKind =
  | 'transfer.created'
  | 'transfer.claimed'
  | 'transfer.refunded'
  | 'transfer.cancelled'
  | 'agent.registered'
  | 'agent.status_changed'
  | 'agent.bond_topped_up'
  | 'agent.bond_withdrawn'
  | 'agent.slashed'
  | 'region.configured'
  | 'corridor.mapped'
  | 'registry.admin_changed'
  | 'kyc.attestation_published'
  | 'kyc.attestation_revoked'
  | 'kyc.thresholds_updated'
  | 'kyc.operator_updated'
  | 'kyc.pause_changed'
  | 'kyc.escrow_updated'
  | 'kyc.transfer_committed'
  | 'pool.region_configured'
  | 'pool.deposited'
  | 'pool.withdrawn'
  | 'pool.drawn'
  | 'pool.repaid'
  | 'escrow.config_updated'
  | 'escrow.wiring_updated'
  | 'escrow.admin_changed';

const TOPIC_TO_KIND: Record<string, EventKind> = {
  [EVENT_TOPICS.transferCreated]: 'transfer.created',
  [EVENT_TOPICS.transferClaimed]: 'transfer.claimed',
  [EVENT_TOPICS.transferRefunded]: 'transfer.refunded',
  [EVENT_TOPICS.transferCancelled]: 'transfer.cancelled',
  [EVENT_TOPICS.agentRegistered]: 'agent.registered',
  [EVENT_TOPICS.agentStatus]: 'agent.status_changed',
  [EVENT_TOPICS.bondTopUp]: 'agent.bond_topped_up',
  [EVENT_TOPICS.bondWithdraw]: 'agent.bond_withdrawn',
  [EVENT_TOPICS.agentSlashed]: 'agent.slashed',
  [EVENT_TOPICS.regionConfigured]: 'region.configured',
  [EVENT_TOPICS.corridorMapped]: 'corridor.mapped',
  [EVENT_TOPICS.registryAdmin]: 'registry.admin_changed',
  [EVENT_TOPICS.attestationPublished]: 'kyc.attestation_published',
  [EVENT_TOPICS.attestationRevoked]: 'kyc.attestation_revoked',
  [EVENT_TOPICS.thresholdsUpdated]: 'kyc.thresholds_updated',
  [EVENT_TOPICS.attestationOperator]: 'kyc.operator_updated',
  [EVENT_TOPICS.compliancePause]: 'kyc.pause_changed',
  [EVENT_TOPICS.complianceEscrow]: 'kyc.escrow_updated',
  [EVENT_TOPICS.transferCommitted]: 'kyc.transfer_committed',
  [EVENT_TOPICS.poolRegion]: 'pool.region_configured',
  [EVENT_TOPICS.poolDeposit]: 'pool.deposited',
  [EVENT_TOPICS.poolWithdraw]: 'pool.withdrawn',
  [EVENT_TOPICS.poolDraw]: 'pool.drawn',
  [EVENT_TOPICS.poolRepay]: 'pool.repaid',
  [EVENT_TOPICS.escrowConfig]: 'escrow.config_updated',
  [EVENT_TOPICS.escrowWiring]: 'escrow.wiring_updated',
  [EVENT_TOPICS.escrowAdmin]: 'escrow.admin_changed',
};

export interface RawContractEvent {
  contractId: string;
  ledger: number;
  eventIndex: number;
  txHash: string;
  /** Base64 XDR of the event's topic vector. */
  topicXdr: string[];
  /** Base64 XDR of the event's value. */
  valueXdr: string;
  closedAt: string;
}

export interface DecodedEvent {
  kind: EventKind;
  topic: string;
  /** Non-topic identifiers: sender, agent, region, corridor. */
  subjects: string[];
  payload: Record<string, unknown>;
  /** Transfer id, when the event concerns one. Extracted for the projection. */
  transferId: bigint | null;
}

export class UndecodableEventError extends Error {
  constructor(
    message: string,
    readonly event: RawContractEvent,
    readonly topic: string,
  ) {
    super(message);
    this.name = 'UndecodableEventError';
  }
}

function decodeXdr(base64: string): unknown {
  const value = xdr.ScVal.fromXDR(base64, 'base64');
  return scValToNative(value) as unknown;
}

function asBigInt(value: unknown, field: string, event: RawContractEvent): bigint {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number' && Number.isInteger(value)) return BigInt(value);
  if (typeof value === 'string' && /^-?\d+$/.test(value)) return BigInt(value);
  throw new UndecodableEventError(`expected an integer for "${field}", got ${typeof value}`, event, field);
}

export function decodeEvent(event: RawContractEvent): DecodedEvent {
  const topics = event.topicXdr.map(decodeXdr);

  const topicSymbol = topics[0];
  if (typeof topicSymbol !== 'string') {
    throw new UndecodableEventError('first topic is not a symbol', event, String(topicSymbol));
  }

  const kind = TOPIC_TO_KIND[topicSymbol];
  if (kind === undefined) {
    // Not a warning. A topic we do not know means the contract was upgraded
    // without the indexer, and continuing would silently drop events from the
    // read model that the API then reports as "no such transfer".
    throw new UndecodableEventError(`unknown event topic "${topicSymbol}"`, event, topicSymbol);
  }

  const subjects = topics.slice(1).map((subject) => String(subject));
  const value = decodeXdr(event.valueXdr);

  const base = { kind, topic: topicSymbol, subjects };

  switch (kind) {
    case 'transfer.created': {
      const [id, amount, token, claimHash, expiry] = asTuple(value, 5, event);
      return {
        ...base,
        payload: {
          id: asBigInt(id, 'id', event).toString(),
          amount: asBigInt(amount, 'amount', event).toString(),
          token: String(token),
          claimHash: toHex(claimHash),
          expiry: asBigInt(expiry, 'expiry', event).toString(),
        },
        transferId: asBigInt(id, 'id', event),
      };
    }
    case 'transfer.claimed': {
      const [id, gross, fee, payout] = asTuple(value, 4, event);
      return {
        ...base,
        payload: {
          id: asBigInt(id, 'id', event).toString(),
          gross: asBigInt(gross, 'gross', event).toString(),
          fee: asBigInt(fee, 'fee', event).toString(),
          payout: asBigInt(payout, 'payout', event).toString(),
        },
        transferId: asBigInt(id, 'id', event),
      };
    }
    case 'transfer.refunded':
    case 'transfer.cancelled': {
      const [id, amount] = asTuple(value, 2, event);
      return {
        ...base,
        payload: {
          id: asBigInt(id, 'id', event).toString(),
          amount: asBigInt(amount, 'amount', event).toString(),
        },
        transferId: asBigInt(id, 'id', event),
      };
    }
    case 'agent.registered': {
      return { ...base, payload: { bond: asBigInt(value, 'bond', event).toString() }, transferId: null };
    }
    case 'agent.slashed': {
      const [requested, recovered] = asTuple(value, 2, event);
      return {
        ...base,
        payload: {
          requested: asBigInt(requested, 'requested', event).toString(),
          recovered: asBigInt(recovered, 'recovered', event).toString(),
        },
        transferId: null,
      };
    }
    case 'pool.drawn': {
      const [amount, exposure, utilization] = asTuple(value, 3, event);
      return {
        ...base,
        payload: {
          amount: asBigInt(amount, 'amount', event).toString(),
          exposure: asBigInt(exposure, 'exposure', event).toString(),
          utilizationBps: Number(utilization),
        },
        transferId: null,
      };
    }
    default:
      // Everything else passes through as-is. Losing the shape of a config change
      // is survivable; guessing at one is not, so the raw decoded value is kept.
      return { ...base, payload: { value: normalise(value) }, transferId: null };
  }
}

function asTuple(value: unknown, expectedLength: number, event: RawContractEvent): unknown[] {
  if (!Array.isArray(value)) {
    throw new UndecodableEventError('event payload is not a tuple', event, 'payload');
  }
  if (value.length < expectedLength) {
    throw new UndecodableEventError(
      `expected at least ${expectedLength} fields in the event payload, got ${value.length}`,
      event,
      'payload',
    );
  }
  return value;
}

function toHex(value: unknown): string {
  if (Buffer.isBuffer(value)) return value.toString('hex');
  if (value instanceof Uint8Array) return Buffer.from(value).toString('hex');
  return String(value);
}

/** Convert `bigint` values to strings so the payload is JSON-serialisable. */
function normalise(value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString();
  if (Array.isArray(value)) return value.map(normalise);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, normalise(entry)]));
  }
  return value;
}

export const __testing = { TOPIC_TO_KIND };
