import {
  Asset,
  BASE_FEE,
  Horizon,
  Keypair,
  Operation,
  StrKey,
  TransactionBuilder,
  type Keypair as KeypairType,
} from '@stellar/stellar-sdk';
import { config as loadDotenv } from 'dotenv';
import { z } from 'zod';

import { call, createContext, scv, submitOperations } from './stellar.js';

// Load `scripts/.env` before reading the environment below.
//
// This import is the whole difference between the documented behaviour and what
// the script actually did: without it, `ADMIN_SECRET_KEY` was never in
// `process.env` for an ordinary `npm run token:create`, so the "reuse the
// deployment key" branch below could never be taken and every run generated a
// throwaway keypair. The address is printed, the secret is printed once, and the
// token is then stranded under a key nothing else in the project knows — while
// the script's own docs promised the opposite. `deploy-contracts.ts` got this
// for free by importing `./env.js`; this script imports `stellar.js` only.
loadDotenv();

/**
 * Create the testnet token contract a deployment needs, and fund the account
 * that deploys it.
 *
 * `scripts/.env.example` tells you to run
 * `stellar contract asset deploy --asset <CODE>:<ISSUER>` here. That works, but
 * it makes the Stellar CLI a prerequisite for deploying at all, and it solves
 * only half the problem: a fresh testnet deployment also needs *funded* accounts,
 * which means a trip to Friendbot that the CLI route leaves to you.
 *
 * This does both, with the SDK the deploy script already depends on.
 *
 * ## Testnet only, and the key it uses
 *
 * There is no mainnet path. The issuer of the asset is the same keypair that
 * administers the four contracts (`ADMIN_SECRET_KEY`), which is a deliberate
 * simplification for a test network and a bad idea in production: the asset
 * issuer can mint supply, and the operator key is supposed to be cold and to
 * reach only thresholds, authorization and slashing. A real deployment issues its
 * asset under a separate issuer key and never lets the operator mint.
 *
 * ## Usage
 *
 *   npm run token:create                  # asset code defaults to RUSD
 *   npm run token:create -- --code XUSD   # a different code
 *
 * Writes nothing to disk: it prints the `TOKEN_CONTRACT` line to put in
 * `scripts/.env`, because a script that edits a secrets file is a script that
 * can half-edit one.
 *
 * ## Why the supply goes to a separate holder account
 *
 * A Stellar asset **cannot be minted to its own issuer** — the SAC rejects it
 * with `Error(Contract, #2)`, "operation invalid on issuer", because a classic
 * asset's issuer holds no balance to credit. That is a property of the asset,
 * not of this script: mint to the issuer and the call always fails.
 *
 * So the supply is minted to a dedicated holder, created and funded here. That
 * account is also what a bring-up needs next: a sender with tokens and XLM to
 * pay fees, when the alternative is hand-funding one before the first
 * `create_transfer` can be attempted.
 */

const FRIENDBOT = 'https://friendbot.stellar.org';

const NETWORKS = {
  testnet: {
    rpcUrl: 'https://soroban-testnet.stellar.org',
    horizonUrl: 'https://horizon-testnet.stellar.org',
    passphrase: 'Test SDF Network ; September 2015',
  },
  futurenet: {
    rpcUrl: 'https://rpc-futurenet.stellar.org',
    horizonUrl: 'https://horizon-futurenet.stellar.org',
    passphrase: 'Test SDF Future Network ; October 2022',
  },
} as const;

const envSchema = z.object({
  ADMIN_SECRET_KEY: z.string().optional(),
  /** Reused when present, so re-running does not strand a funded holder. */
  TEST_HOLDER_SECRET_KEY: z.string().optional(),
  STELLAR_NETWORK: z.enum(['testnet', 'futurenet']).default('testnet'),
  SOROBAN_RPC_URL: z.string().url().optional(),
});

/** Minted to the deployer so the network is usable straight after it comes up. */
const INITIAL_SUPPLY = '1000000000000000';

function parseArgs(argv: string[]): { code: string } {
  const codeIndex = argv.indexOf('--code');
  const code = codeIndex === -1 ? 'RUSD' : (argv[codeIndex + 1] ?? 'RUSD');

  // Asset codes are 1-12 alphanumeric characters on Stellar. Checked here because
  // the failure otherwise arrives as a host error on a paid transaction.
  if (!/^[A-Z0-9]{1,12}$/.test(code)) {
    throw new Error(`--code must be 1-12 upper-case alphanumeric characters, got "${code}".`);
  }
  return { code };
}

/**
 * Ask Friendbot for testnet funds.
 *
 * A 400 here is the expected answer for an account that already exists, so it is
 * not an error: the caller only needs the account to be funded, and it is.
 */
/**
 * Submit a *classic* operation through Horizon.
 *
 * The two paths are not interchangeable, and the difference is not obvious from
 * the SDK: Soroban RPC's `simulateTransaction` accepts only Soroban operations,
 * and rejects a classic one with "transaction contains unsupported operation
 * type: OperationTypeChangeTrust". Creating a trustline is a classic operation,
 * so it goes to Horizon and is signed and submitted exactly as it always was.
 *
 * The alternative — skipping the trustline — is not available for an asset
 * issued by an account: the trustline is the balance the SAC mints into.
 */
async function submitClassic(
  horizonUrl: string,
  networkPassphrase: string,
  signer: KeypairType,
  operation: ReturnType<typeof Operation.changeTrust>,
  label: string,
): Promise<string> {
  const server = new Horizon.Server(horizonUrl);
  const account = await server.loadAccount(signer.publicKey());
  const transaction = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase,
  })
    .addOperation(operation)
    .setTimeout(120)
    .build();
  transaction.sign(signer);

  try {
    const result = await server.submitTransaction(transaction);
    console.log(`  ${label} → ${result.hash}`);
    return result.hash;
  } catch (cause) {
    throw new Error(`${label} failed: ${describeHorizonError(cause)}`);
  }
}

/**
 * Horizon reports failures as a result-code envelope, and the top-level message
 * says nothing useful — "Transaction Failed" — while the reason sits in
 * `extras.result_codes`.
 */
function describeHorizonError(cause: unknown): string {
  const response = (cause as { response?: { data?: { extras?: { result_codes?: unknown } } } })
    ?.response?.data;
  if (response?.extras?.result_codes !== undefined) {
    return JSON.stringify(response.extras.result_codes);
  }
  return cause instanceof Error ? cause.message : String(cause);
}

async function fundWithFriendbot(publicKey: string): Promise<boolean> {
  const response = await fetch(`${FRIENDBOT}/?addr=${encodeURIComponent(publicKey)}`);
  if (response.ok) return true;

  const body = await response.text();
  if (response.status === 400 && /createAccountAlreadyExist|already/i.test(body)) {
    return false;
  }
  throw new Error(`Friendbot refused ${publicKey}: HTTP ${response.status} ${body.slice(0, 200)}`);
}

async function main(): Promise<void> {
  const { code } = parseArgs(process.argv.slice(2));

  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    throw new Error(
      `Invalid environment:\n${parsed.error.issues
        .map((issue) => `  - ${issue.path.join('.')}: ${issue.message}`)
        .join('\n')}`,
    );
  }
  const env = parsed.data;

  const network = NETWORKS[env.STELLAR_NETWORK];
  const rpcUrl = env.SOROBAN_RPC_URL ?? network.rpcUrl;

  // Reuse the deployment key when there is one, so re-running this does not
  // strand a token by a previous run under a key nothing else knows about.
  const admin =
    env.ADMIN_SECRET_KEY === undefined
      ? Keypair.random()
      : Keypair.fromSecret(env.ADMIN_SECRET_KEY);

  const freshKey = env.ADMIN_SECRET_KEY === undefined;

  console.log(`Network      ${env.STELLAR_NETWORK} (${rpcUrl})`);
  console.log(`Admin        ${admin.publicKey()}`);
  if (freshKey) {
    console.log('             a new key was generated; ADMIN_SECRET_KEY below is the only copy');
  }

  console.log('Funding the deployer account…');
  const funded = await fundWithFriendbot(admin.publicKey());
  console.log(funded ? '  funded by Friendbot' : '  already funded');

  const asset = new Asset(code, admin.publicKey());
  const expected = asset.contractId(network.passphrase);

  const context = createContext({
    rpcUrl,
    adminSecret: admin.secret(),
    networkPassphrase: network.passphrase,
    dryRun: false,
  });

  console.log(`Creating the Stellar Asset Contract for ${code}:${admin.publicKey().slice(0, 8)}…`);
  let tokenContract = expected;
  try {
    const result = await submitOperations(
      context,
      [Operation.createStellarAssetContract({ asset })],
      `deploy ${code} SAC`,
    );
    if (typeof result.returnValue === 'string' && StrKey.isValidContract(result.returnValue)) {
      tokenContract = result.returnValue;
    }
  } catch (cause) {
    // The address of a SAC is derived from the asset, so "already exists" means
    // the contract is exactly the one we were about to create. Re-running this
    // script should be uneventful rather than fatal.
    const message = cause instanceof Error ? cause.message : String(cause);
    if (!/exist|AlreadyExists/i.test(message)) throw cause;
    console.log('  the SAC for this asset already exists; reusing it');
  }

  console.log(`  token contract ${tokenContract}`);

  // The holder, not the issuer: see the module docs — minting to the issuer is
  // rejected by the asset itself and always has been.
  const holder =
    env.TEST_HOLDER_SECRET_KEY === undefined
      ? Keypair.random()
      : Keypair.fromSecret(env.TEST_HOLDER_SECRET_KEY);
  console.log(`Holder       ${holder.publicKey()}`);
  console.log('Funding the holder account…');
  const holderFunded = await fundWithFriendbot(holder.publicKey());
  console.log(holderFunded ? '  funded by Friendbot' : '  already funded');

  // The holder's classic trustline, before anything is minted to it.
  //
  // A SAC of an account-issued asset is backed by trustlines: the docs are
  // explicit that where a trustline does not exist, any function that touches
  // that balance errors. Minting first and creating the trustline afterwards
  // fails with `Error(Contract, #13)` and a message that names neither the
  // account nor the missing trustline — which is how this went unnoticed here.
  //
  // `changeTrust` has to be sourced by the account holding the trustline, so the
  // holder signs it — through Horizon, because it is a classic operation.
  await submitClassic(
    network.horizonUrl,
    network.passphrase,
    holder,
    Operation.changeTrust({ asset }),
    `the holder trusts ${code}`,
  );

  // Fatal, unlike before. A deployment whose supply silently failed to mint
  // looks healthy and only fails later, on the first transfer, with an error
  // that names a balance rather than the cause.
  await call(
    context,
    tokenContract,
    'mint',
    [scv.address(holder.publicKey()), scv.i128(INITIAL_SUPPLY)],
    'mint the initial supply',
  );
  console.log(`  minted ${INITIAL_SUPPLY} to the holder`);

  console.log('\nAdd these to scripts/.env:\n');
  console.log(`ADMIN_SECRET_KEY=${admin.secret()}`);
  console.log(`TEST_HOLDER_SECRET_KEY=${holder.secret()}`);
  console.log(`TREASURY_PUBLIC_KEY=${admin.publicKey()}`);
  console.log(`ATTESTER_PUBLIC_KEY=${admin.publicKey()}`);
  console.log(`TOKEN_CONTRACT=${tokenContract}`);
  console.log(
    '\nTreasury and attester are set to the admin key for a testnet bring-up only.\n' +
      'A real deployment gives each its own key: see scripts/.env.example.\n' +
      'TEST_HOLDER_SECRET_KEY is a testnet sender: it holds the token supply and\n' +
      'the XLM to pay fees. Never use it for anything of value.',
  );
}

await main();
