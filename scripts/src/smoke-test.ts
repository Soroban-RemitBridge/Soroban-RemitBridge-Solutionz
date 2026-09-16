import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  Asset,
  BASE_FEE,
  Horizon,
  Keypair,
  Operation,
  StrKey,
  TransactionBuilder,
  xdr,
} from '@stellar/stellar-sdk';

import { parseDeployEnv } from './env.js';
import { call, createContext, readContract, scv, type DeployContext } from './stellar.js';

/**
 * Run one real transfer end to end on a deployed network.
 *
 * Everything else in this repository tests the contracts against a simulated
 * ledger, and `verify-deployment.ts` reads a deployment's *state*. Neither
 * answers the question a first deployment actually raises: does a sender's money
 * reach a bonded agent, through the compliance gate, on a real network? No amount
 * of local testing closes that gap, because the gap is made of the parts the
 * local harness replaces — a funded account, a real trustline, real transaction
 * submission, real fees.
 *
 * The flow, in the order the contracts enforce it:
 *
 *   1. An agent is funded and trusts the token, because bonds are posted in it.
 *   2. The holder sends the agent the token (it holds the supply), and the agent
 *      posts a bond and is authorized by the operator.
 *   3. The attester publishes a STANDARD attestation for the sender — required
 *      because the amount is above the corridor's tier-1 band.
 *   4. The sender creates a transfer, which pulls the token into escrow.
 *   5. The agent claims it with the preimage of the claim hash.
 *   6. Payout and fee are checked against balances read back from the token.
 *
 * ## Whose key signs what
 *
 * Each step is submitted by the account whose authorization the contract will
 * require, because a `require_auth` is satisfied by the *source account's*
 * signature: `create_transfer` is sourced by the sender, `claim_transfer` by the
 * agent, and only the operator calls are sourced by the admin. Sourcing them all
 * from the admin produces a signature error that reads like a contract refusal.
 *
 * ## Testnet only
 *
 * It refuses anything else. It submits transactions that spend fees and move
 * tokens; a mainnet run would move mainnet tokens.
 *
 * Usage:
 *   npm run smoke-test
 */

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const ADDRESSES = resolve(REPO_ROOT, 'deployed-addresses.json');
const FRIENDBOT = 'https://friendbot.stellar.org';
const HORIZON = 'https://horizon-testnet.stellar.org';

/** The corridor and region the shipped deployment config uses. */
const CORRIDOR = 'NGN_LAG';
const REGION = 'NG_LAG';

/** 100 RUSD: above the corridor's 50 RUSD tier-1 band, so KYC is required. */
const AMOUNT = 100_0000000n;
/** The region's minimum bond, from `config/testnet.json`. */
const BOND = 500_0000000n;
/** Bond plus a margin, so the agent can pay its own fees afterwards. */
const AGENT_TOP_UP = BOND + 100_0000000n;
/** The asset code `create-test-token.ts` issues. */
const TOKEN_CODE = 'RUSD';
/**
 * How far ahead the transfer expires, in seconds.
 *
 * The deployed `max_expiry_secs` is 604800 (seven days), and the escrow rejects
 * `expiry - now > max_expiry_secs` where `now` is the *ledger* clock. Setting the
 * expiry to exactly the local clock plus seven days therefore fails: the ledger
 * close that executes the transaction is a few seconds ahead, which is enough to
 * push the difference past the bound and produce `ExpiryTooFar`. Three days
 * leaves room for that drift.
 */
const TRANSFER_EXPIRY_SECS = 3 * 86_400;

/** The claim code's preimage, standing in for the mobile app's CSPRNG output. */
const CLAIM_CODE = Uint8Array.from({ length: 32 }, (_, index) => index + 1);

interface Addresses {
  network: string;
  token: string;
  contracts: {
    agentRegistry: string;
    complianceHook: string;
    liquidityPool: string;
    remitEscrow: string;
  };
}

async function fundWithFriendbot(publicKey: string): Promise<void> {
  const response = await fetch(`${FRIENDBOT}/?addr=${encodeURIComponent(publicKey)}`);
  if (response.ok) return;
  const body = await response.text();
  if (response.status === 400 && /already/i.test(body)) return;
  throw new Error(`Friendbot refused ${publicKey}: HTTP ${response.status}`);
}

/**
 * Create an account's trustline for the token, through Horizon.
 *
 * Two things force this route. A SAC of an account-issued asset is backed by
 * classic trustlines, so without one the account cannot hold the token at all —
 * and a bond transfer then fails with an error naming a balance rather than the
 * missing trustline. And `changeTrust` is a *classic* operation, which Soroban
 * RPC rejects outright, so it cannot go through the same path as the contract
 * calls.
 *
 * The asset is reconstructed from the contract id rather than configured: a SAC
 * address is a hash of the asset, so the (code, issuer) pair that produces this
 * id is checkable, and a mismatch is reported instead of silently creating a
 * trustline to a different asset.
 */
async function trustToken(
  passphrase: string,
  signer: Keypair,
  token: string,
  issuer: string,
): Promise<Asset> {
  const asset = new Asset(TOKEN_CODE, issuer);
  if (asset.contractId(passphrase) !== token) {
    throw new Error(
      `the token ${token} is not ${TOKEN_CODE}:${issuer.slice(0, 8)}… — this smoke test only ` +
        'understands the asset `npm run token:create` issues, and refuses to guess at another.',
    );
  }

  const server = new Horizon.Server(HORIZON);
  const account = await server.loadAccount(signer.publicKey());
  const transaction = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase: passphrase })
    .addOperation(Operation.changeTrust({ asset }))
    .setTimeout(120)
    .build();
  transaction.sign(signer);
  await server.submitTransaction(transaction);
  return asset;
}

async function balanceOf(context: DeployContext, token: string, who: string): Promise<bigint> {
  const value = (await readContract(context, token, 'balance', [scv.address(who)])) as
    | bigint
    | undefined;
  return value ?? 0n;
}

function contextFor(url: string, secret: string, passphrase: string): DeployContext {
  return createContext({
    rpcUrl: url,
    adminSecret: secret,
    networkPassphrase: passphrase,
    dryRun: false,
  });
}

async function main(): Promise<void> {
  const env = parseDeployEnv();
  if (env.STELLAR_NETWORK !== 'testnet') {
    throw new Error(
      `Refusing to run against ${env.STELLAR_NETWORK}: this script submits transactions that move ` +
        'real tokens. Testnet only.',
    );
  }
  if (!existsSync(ADDRESSES)) {
    throw new Error(`No addresses file at ${ADDRESSES}. Deploy first.`);
  }

  const addresses = JSON.parse(readFileSync(ADDRESSES, 'utf8')) as Addresses;
  if (StrKey.isValidContract(addresses.token) === false) {
    throw new Error(`deployed-addresses.json has no usable token address (${addresses.token}).`);
  }

  const admin = Keypair.fromSecret(env.ADMIN_SECRET_KEY);
  const holderSecret = process.env['TEST_HOLDER_SECRET_KEY'];
  if (holderSecret === undefined) {
    throw new Error(
      'TEST_HOLDER_SECRET_KEY is required: it is the funded account holding the token supply, ' +
        'which `npm run token:create` creates.',
    );
  }
  const holder = Keypair.fromSecret(holderSecret);

  // The escrow pays its fee to whatever `TREASURY_PUBLIC_KEY` the deployment was
  // initialised with, and a payment to an account that does not trust the token
  // fails at the token. The treasury is therefore held to the same requirement
  // as the agent below, and the key must match the one the deployment recorded —
  // otherwise the fee check would be reading an account that never receives
  // anything and reporting a passing flow for the wrong reason.
  const treasurySecret = process.env['TEST_TREASURY_SECRET_KEY'];
  if (treasurySecret === undefined) {
    throw new Error(
      'TEST_TREASURY_SECRET_KEY is required: the fee lands in TREASURY_PUBLIC_KEY, and proving it ' +
        'arrived means holding that key. `npm run deploy` records the address it wired.',
    );
  }
  const treasury = Keypair.fromSecret(treasurySecret);
  if (treasury.publicKey() !== env.TREASURY_PUBLIC_KEY) {
    throw new Error(
      `TEST_TREASURY_SECRET_KEY holds ${treasury.publicKey()}, but this deployment pays fees to ` +
        `${env.TREASURY_PUBLIC_KEY}. Using the wrong key would make the fee check vacuous.`,
    );
  }

  // Reused across runs when it is set, so a re-run does not strand a bond under
  // a key nothing kept.
  const agentSecret = process.env['TEST_AGENT_SECRET_KEY'] ?? Keypair.random().secret();
  const agent = Keypair.fromSecret(agentSecret);

  console.log(`Network         ${addresses.network}`);
  console.log(`Sender (holder) ${holder.publicKey()}`);
  console.log(`Agent           ${agent.publicKey()}`);
  console.log(`Treasury        ${treasury.publicKey()}`);
  if (process.env['TEST_AGENT_SECRET_KEY'] === undefined) {
    console.log(`                TEST_AGENT_SECRET_KEY=${agentSecret}`);
  }
  console.log();

  const context = contextFor(env.SOROBAN_RPC_URL, env.ADMIN_SECRET_KEY, env.STELLAR_NETWORK_PASSPHRASE);
  const agentContext = contextFor(env.SOROBAN_RPC_URL, agentSecret, env.STELLAR_NETWORK_PASSPHRASE);
  const senderContext = contextFor(env.SOROBAN_RPC_URL, holderSecret, env.STELLAR_NETWORK_PASSPHRASE);

  // --- 1. Fund the agent and the treasury, and give both a token trustline --
  await fundWithFriendbot(agent.publicKey());
  await trustToken(env.STELLAR_NETWORK_PASSPHRASE, agent, addresses.token, admin.publicKey());
  await fundWithFriendbot(treasury.publicKey());
  await trustToken(env.STELLAR_NETWORK_PASSPHRASE, treasury, addresses.token, admin.publicKey());
  console.log('  ✓ agent and treasury funded and trusting the token');

  // --- 2. Move the bond to the agent, in the token ------------------------
  await call(
    senderContext,
    addresses.token,
    'transfer',
    [
      scv.address(holder.publicKey()),
      scv.address(agent.publicKey()),
      scv.i128(AGENT_TOP_UP.toString()),
    ],
    'fund the agent with the token',
  );

  // Sourced by the agent: `register_agent` requires the agent's own auth, and a
  // contract's `require_auth` is satisfied by the *transaction's* signer. Sending
  // this from the operator key fails with an authentication error that looks like
  // a refusal from the registry.
  await call(
    agentContext,
    addresses.contracts.agentRegistry,
    'register_agent',
    [scv.address(agent.publicKey()), scv.symbol(REGION), scv.i128(BOND.toString())],
    `register the agent in ${REGION}`,
  );
  await call(
    context,
    addresses.contracts.agentRegistry,
    'authorize_agent',
    [scv.address(agent.publicKey())],
    'authorize the agent',
  );
  console.log('  ✓ agent bonded and authorized');

  // --- 3. Attest the sender ----------------------------------------------
  const attestationHash = createHash('sha256').update('smoke-test-attestation').digest();
  await call(
    context,
    addresses.contracts.complianceHook,
    'publish_attestation',
    [
      scv.address(admin.publicKey()),
      scv.address(holder.publicKey()),
      // `KycTier::Standard`. A bare `scv.symbol('Standard')` is *not* accepted
      // here — see `scv.enumCase` for the measurement behind that.
      scv.enumCase('Standard'),
      xdr.ScVal.scvBytes(attestationHash),
      scv.symbol(REGION),
      scv.symbol('mock'),
      scv.u64(Math.floor(Date.now() / 1000) + 30 * 86_400),
    ],
    'publish a STANDARD attestation for the sender',
  );
  console.log('  ✓ sender attested at STANDARD');

  // --- 4. Create the transfer --------------------------------------------
  const escrow = addresses.contracts.remitEscrow;
  const before = {
    escrow: await balanceOf(context, addresses.token, escrow),
    agent: await balanceOf(context, addresses.token, agent.publicKey()),
    treasury: await balanceOf(context, addresses.token, env.TREASURY_PUBLIC_KEY),
  };

  const claimHash = createHash('sha256').update(CLAIM_CODE).digest();
  await call(
    senderContext,
    escrow,
    'create_transfer',
    [
      scv.address(holder.publicKey()),
      scv.i128(AMOUNT.toString()),
      scv.address(addresses.token),
      xdr.ScVal.scvBytes(claimHash),
      scv.symbol(CORRIDOR),
      scv.u64(Math.floor(Date.now() / 1000) + TRANSFER_EXPIRY_SECS),
    ],
    'create the transfer',
  );
  const transferId = (await readContract(context, escrow, 'transfer_count', [])) as bigint;
  console.log(`  ✓ escrow holds ${AMOUNT} stroops against transfer ${transferId}`);

  // --- 5. Claim it -------------------------------------------------------
  await call(
    agentContext,
    escrow,
    'claim_transfer',
    [
      scv.address(agent.publicKey()),
      scv.u64(transferId),
      xdr.ScVal.scvBytes(CLAIM_CODE),
    ],
    'claim the transfer',
  );

  // --- 6. Check the money actually moved ---------------------------------
  const after = {
    escrow: await balanceOf(context, addresses.token, escrow),
    agent: await balanceOf(context, addresses.token, agent.publicKey()),
    treasury: await balanceOf(context, addresses.token, env.TREASURY_PUBLIC_KEY),
  };

  const fee = (AMOUNT * 200n) / 10_000n;
  const payout = AMOUNT - fee;

  const checks: Array<[string, boolean]> = [
    ['the escrow is back to its opening balance (nothing is stuck)', after.escrow === before.escrow],
    ['the agent received the payout', after.agent - before.agent === payout],
    ['the treasury received the fee', after.treasury - before.treasury === fee],
    ['the transfer is settled, not pending', (await readContract(context, escrow, 'get_transfer', [scv.u64(transferId)])) !== null],
  ];

  console.log();
  for (const [claim, ok] of checks) console.log(`  ${ok ? '✓' : '✗'} ${claim}`);

  const failures = checks.filter(([, ok]) => !ok);
  if (failures.length > 0) {
    console.error(`\n${failures.length} check(s) failed`);
    process.exitCode = 1;
    return;
  }

  console.log(
    `\nA transfer settled on ${addresses.network}: ${payout} stroops to the agent, ${fee} to the ` +
      'treasury, and the escrow holds nothing.',
  );
}

await main();
