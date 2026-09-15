import {
  BASE_FEE,
  Contract,
  Keypair,
  TransactionBuilder,
  scValToNative,
  rpc,
  type xdr,
} from '@stellar/stellar-sdk';

import { env } from '../config/env.js';
import { chainUnavailable } from '../lib/errors.js';
import { logger } from '../lib/logger.js';

/**
 * Soroban RPC access.
 *
 * Every write goes through simulate → assemble → sign → submit → poll. Running
 * the simulation first is not an optimisation, it is the mechanism by which
 * resource fees and the ledger footprint are attached to the transaction; a
 * transaction built without it is rejected before it ever executes.
 */
export const server = new rpc.Server(env.SOROBAN_RPC_URL, {
  allowHttp: env.SOROBAN_RPC_URL.startsWith('http://'),
});

export const networkPassphrase = env.STELLAR_NETWORK_PASSPHRASE;

export type ScVal = xdr.ScVal;

export function keypairFromSecret(secret: string): Keypair {
  try {
    return Keypair.fromSecret(secret);
  } catch (cause) {
    throw new Error(`Malformed secret key (expected an S... StrKey): ${String(cause)}`);
  }
}

export interface InvocationResult<T> {
  /** Decoded return value; absent when the contract returns nothing. */
  value?: T | undefined;
  /** Transaction hash once submitted. */
  hash?: string;
  /** Ledger the transaction was included in. */
  ledger?: number;
}

export interface InvocationOptions<T> {
  contractId: string;
  method: string;
  args: ScVal[];
  signer: Keypair;
  /** Simulate only: use for reads, which must never cost a fee. */
  simulateOnly?: boolean;
  /** Decode the raw `ScVal` returned by the host. */
  decode?: (raw: unknown) => T;
}

const POLL_INTERVAL_MS = 1_000;
const POLL_ATTEMPTS = 30;

export async function invoke<T>(options: InvocationOptions<T>): Promise<InvocationResult<T>> {
  const { contractId, method, args, signer, simulateOnly = false, decode } = options;

  try {
    const account = await server.getAccount(signer.publicKey());
    const transaction = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase,
    })
      .addOperation(new Contract(contractId).call(method, ...args))
      .setTimeout(30)
      .build();

    const simulation = await server.simulateTransaction(transaction);

    if (rpc.Api.isSimulationError(simulation)) {
      // The host's error string carries the contract's typed error code, so it is
      // propagated verbatim: mapping it to a friendly message is `errors.ts`'s
      // job, and doing it here would discard the code that mapping needs.
      throw new Error(simulation.error);
    }

    const rawReturn = rpc.Api.isSimulationSuccess(simulation) ? simulation.result?.retval : undefined;
    const value = decodeReturn<T>(rawReturn, decode);

    if (simulateOnly) {
      return value === undefined ? {} : { value };
    }

    const prepared = rpc.assembleTransaction(transaction, simulation).build();
    prepared.sign(signer);

    const sent = await server.sendTransaction(prepared);
    if (sent.status === 'ERROR') {
      throw new Error(`Submission rejected: ${JSON.stringify(sent.errorResult ?? sent.status)}`);
    }

    const confirmed = await pollForResult(sent.hash);
    return { value, hash: sent.hash, ledger: confirmed.ledger };
  } catch (cause) {
    if (cause instanceof Error && cause.message.startsWith('Simulation failed')) {
      throw cause;
    }
    throw chainUnavailable(`${method}@${contractId}`, cause instanceof Error ? cause.message : String(cause));
  }
}

async function pollForResult(hash: string): Promise<{ ledger: number }> {
  for (let attempt = 0; attempt < POLL_ATTEMPTS; attempt += 1) {
    const response = await server.getTransaction(hash);
    if (response.status === rpc.Api.GetTransactionStatus.SUCCESS) {
      return { ledger: response.ledger };
    }
    if (response.status === rpc.Api.GetTransactionStatus.FAILED) {
      throw new Error(`Transaction ${hash} failed on-chain`);
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
  // Not a failure: the transaction may still land. Surfacing the hash is what
  // makes it recoverable, so the caller can reconcile rather than resubmit.
  logger.warn({ hash }, 'transaction not confirmed within the polling window');
  return { ledger: 0 };
}

function decodeReturn<T>(raw: xdr.ScVal | undefined, decode?: (value: unknown) => T): T | undefined {
  if (raw === undefined) return undefined;
  const native = scValToNative(raw) as unknown;
  return decode === undefined ? (native as T) : decode(native);
}

/**
 * Read a contract function without paying a fee or waiting for a ledger.
 *
 * Reads are used on request paths, so an RPC blip must not become a 500 on a
 * page that could have rendered from the database. Callers catch and fall back.
 */
export async function read<T>(options: Omit<InvocationOptions<T>, 'signer' | 'simulateOnly'>): Promise<T | undefined> {
  // Any funded account works as the simulation source; it is never charged.
  const signer = keypairFromSecret(env.OPERATOR_SECRET_KEY);
  const result = await invoke<T>({ ...options, signer, simulateOnly: true });
  return result.value;
}
