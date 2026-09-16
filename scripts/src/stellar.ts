import { createHash, randomBytes } from 'node:crypto';

import {
  Address,
  BASE_FEE,
  Contract,
  Keypair,
  Operation,
  TransactionBuilder,
  nativeToScVal,
  rpc,
  scValToNative,
  StrKey,
  xdr,
} from '@stellar/stellar-sdk';

/**
 * Soroban deploy helpers.
 *
 * Every write goes simulate → assemble → sign → submit → poll. The simulation is
 * not an optimisation: it is how resource fees and the ledger footprint get
 * attached to the transaction, and a transaction built without it is rejected
 * before it executes.
 *
 * Failures are wrapped with the method and contract they came from. A deploy
 * touches four contracts and calls a dozen methods, and an unwrapped "host
 * error" leaves the operator to work out which of those dozen it was — on a
 * network where a partially-wired deployment cannot simply be rolled back.
 */

const POLL_INTERVAL_MS = 1_000;
const POLL_ATTEMPTS = 60;

export interface DeployContext {
  server: rpc.Server;
  admin: Keypair;
  networkPassphrase: string;
  /** When true, simulate everything and submit nothing. */
  dryRun: boolean;
  log: (message: string) => void;
}

export function createContext(options: {
  rpcUrl: string;
  adminSecret: string;
  networkPassphrase: string;
  dryRun: boolean;
}): DeployContext {
  let admin: Keypair;
  try {
    admin = Keypair.fromSecret(options.adminSecret);
  } catch (cause) {
    // The SDK's own message for this is "invalid encoded string", which does not
    // say which variable was wrong. A deploy script is run rarely and by hand,
    // so the message has to carry its own context.
    throw new Error(
      `ADMIN_SECRET_KEY is not a valid Stellar secret key (expected an S... StrKey). ${String(cause)}`,
    );
  }

  return {
    server: new rpc.Server(options.rpcUrl, { allowHttp: options.rpcUrl.startsWith('http://') }),
    admin,
    networkPassphrase: options.networkPassphrase,
    dryRun: options.dryRun,
    log: (message) => {
      process.stdout.write(`${message}\n`);
    },
  };
}

/**
 * The Wasm hash is `sha256` of the Wasm bytes.
 *
 * This is the invariant the host uses when it stores uploaded code, so it is
 * computed locally rather than round-tripped through an RPC endpoint: fewer
 * moving parts, and the same value works on any provider. It also means the
 * hash can be compared against `sha256sum` of the artifact when something looks
 * wrong.
 */
export function wasmHash(wasm: Buffer): string {
  return createHash('sha256').update(wasm).digest('hex');
}

/**
 * Build, simulate, sign, submit and wait for one transaction.
 *
 * Exported because the token setup needs the same path for a contract this file
 * does not deploy (a Stellar Asset Contract, which the host creates from an asset
 * preimage rather than from uploaded Wasm). Simulate → assemble → sign → submit →
 * poll is not something to write twice: the simulation is what attaches the
 * resource fees, and a second copy that forgot it would fail in a way that looks
 * like a contract bug.
 */
export async function submitOperations(
  context: DeployContext,
  operations: xdr.Operation[],
  label: string,
): Promise<{ hash: string; returnValue: unknown }> {
  const account = await context.server.getAccount(context.admin.publicKey());

  let builder = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: context.networkPassphrase,
  });
  for (const operation of operations) {
    builder = builder.addOperation(operation);
  }
  const transaction = builder.setTimeout(120).build();

  const simulation = await context.server.simulateTransaction(transaction);
  if (rpc.Api.isSimulationError(simulation)) {
    throw new Error(`${label} failed during simulation: ${simulation.error}`);
  }

  const returnValue = rpc.Api.isSimulationSuccess(simulation)
    ? scValToNative(simulation.result?.retval as xdr.ScVal)
    : undefined;

  const prepared = rpc.assembleTransaction(transaction, simulation).build();
  prepared.sign(context.admin);

  const sent = await context.server.sendTransaction(prepared);
  if (sent.status === 'ERROR') {
    throw new Error(`${label} was rejected: ${JSON.stringify(sent.errorResult ?? sent.status)}`);
  }

  const confirmed = await poll(context, sent.hash, label);
  context.log(`  ${label} → ${sent.hash} (ledger ${confirmed.ledger})`);
  return { hash: sent.hash, returnValue };
}

async function poll(
  context: DeployContext,
  hash: string,
  label: string,
): Promise<{ ledger: number }> {
  for (let attempt = 0; attempt < POLL_ATTEMPTS; attempt += 1) {
    const response = await context.server.getTransaction(hash);
    if (response.status === rpc.Api.GetTransactionStatus.SUCCESS) {
      return { ledger: response.ledger };
    }
    if (response.status === rpc.Api.GetTransactionStatus.FAILED) {
      throw new Error(`${label} failed on-chain: ${hash}`);
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
  throw new Error(
    `${label} was submitted as ${hash} but did not confirm within ${(POLL_ATTEMPTS * POLL_INTERVAL_MS) / 1000}s. Check the hash before retrying — resubmitting could deploy a second instance.`,
  );
}

export async function uploadWasm(
  context: DeployContext,
  contractName: string,
  wasm: Buffer,
): Promise<string> {
  const hash = wasmHash(wasm);

  if (context.dryRun) {
    context.log(`  [dry-run] would upload ${contractName} (${wasm.byteLength} bytes, ${hash})`);
    return hash;
  }

  await submitOperations(
    context,
    [Operation.uploadContractWasm({ wasm })],
    `upload ${contractName}`,
  );
  return hash;
}

export async function deployContract(
  context: DeployContext,
  contractName: string,
  hash: string,
): Promise<string> {
  if (context.dryRun) {
    // A *valid* contract address, derived deterministically from the name.
    // A readable placeholder like `C_DRY_RUN_ESCROW` would fail the moment it
    // was passed to `Address.fromString`, which means a dry run would stop
    // exercising the argument encoding at exactly the point it gets interesting
    // — the cross-contract wiring. This way a dry run really does validate every
    // argument it would send.
    const placeholder = StrKey.encodeContract(
      createHash('sha256').update(`dry-run:${contractName}`).digest(),
    );
    context.log(`  [dry-run] would deploy ${contractName} → ${placeholder}`);
    return placeholder;
  }

  const result = await submitOperations(
    context,
    [
      Operation.createCustomContract({
        address: new Address(context.admin.publicKey()),
        wasmHash: Buffer.from(hash, 'hex'),
        // Deployment salt only needs to be unique, not secret: it distinguishes
        // this instance from any other deployed by the same admin key. A
        // collision fails the deployment rather than overwriting anything, which
        // is the safe direction.
        salt: randomBytes(32),
      }),
    ],
    `deploy ${contractName}`,
  );

  const contractId = result.returnValue;
  if (typeof contractId !== 'string' || !contractId.startsWith('C')) {
    throw new Error(
      `${contractName} deployment did not return a contract address (got ${typeof contractId}).`,
    );
  }
  return contractId;
}

/** Invoke a contract method as the admin, and return the decoded result. */
export async function call(
  context: DeployContext,
  contractId: string,
  method: string,
  args: xdr.ScVal[],
  label?: string,
): Promise<unknown> {
  const name = label ?? `${method} on ${contractId.slice(0, 8)}…`;

  if (context.dryRun) {
    context.log(`  [dry-run] would call ${name}`);
    return undefined;
  }

  const result = await submitOperations(
    context,
    [new Contract(contractId).call(method, ...args)],
    name,
  );
  return result.returnValue;
}

/** Read a contract method without paying a fee or waiting for a ledger. */
export async function readContract(
  context: DeployContext,
  contractId: string,
  method: string,
  args: xdr.ScVal[],
): Promise<unknown> {
  const account = await context.server.getAccount(context.admin.publicKey());
  const transaction = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: context.networkPassphrase,
  })
    .addOperation(new Contract(contractId).call(method, ...args))
    .setTimeout(30)
    .build();

  const simulation = await context.server.simulateTransaction(transaction);
  if (rpc.Api.isSimulationError(simulation)) {
    throw new Error(`${method} on ${contractId} failed: ${simulation.error}`);
  }
  return rpc.Api.isSimulationSuccess(simulation)
    ? scValToNative(simulation.result?.retval as xdr.ScVal)
    : undefined;
}

/**
 * Build a Soroban struct value.
 *
 * Rust structs cross the ABI as maps keyed by field name, and `ScMap` is a
 * *sorted* list of entries — the host rejects an unsorted one. Sorting here
 * rather than at each call site means a new field cannot silently produce a
 * value the contract refuses to deserialize.
 *
 * Keys must match the Rust field names exactly (`tier1_max`, not `tier1Max`).
 */
export function struct(fields: Record<string, xdr.ScVal>): xdr.ScVal {
  const entries = Object.entries(fields)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([key, value]) => new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol(key), val: value }));
  return xdr.ScVal.scvMap(entries);
}

export const scv = {
  address: (value: string): xdr.ScVal => new Address(value).toScVal(),
  symbol: (value: string): xdr.ScVal => nativeToScVal(value, { type: 'symbol' }),
  u32: (value: number): xdr.ScVal => nativeToScVal(value, { type: 'u32' }),
  u64: (value: number | bigint): xdr.ScVal => nativeToScVal(value, { type: 'u64' }),
  i128: (value: string): xdr.ScVal => nativeToScVal(BigInt(value), { type: 'i128' }),
  bool: (value: boolean): xdr.ScVal => nativeToScVal(value),
};
