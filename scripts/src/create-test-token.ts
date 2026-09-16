import { Asset, Keypair, Operation, StrKey } from '@stellar/stellar-sdk';
import { z } from 'zod';

import { call, createContext, scv, submitOperations } from './stellar.js';

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
 */

const FRIENDBOT = 'https://friendbot.stellar.org';

const NETWORKS = {
  testnet: {
    rpcUrl: 'https://soroban-testnet.stellar.org',
    passphrase: 'Test SDF Network ; September 2015',
  },
  futurenet: {
    rpcUrl: 'https://rpc-futurenet.stellar.org',
    passphrase: 'Test SDF Future Network ; October 2022',
  },
} as const;

const envSchema = z.object({
  ADMIN_SECRET_KEY: z.string().optional(),
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

  // Not fatal. The four contracts can be deployed and wired without a supply;
  // only moving money needs it, so a mint failure should not block a deployment
  // that is otherwise correct.
  try {
    await call(
      context,
      tokenContract,
      'mint',
      [scv.address(admin.publicKey()), scv.i128(INITIAL_SUPPLY)],
      'mint the initial supply',
    );
    console.log(`  minted ${INITIAL_SUPPLY} to the deployer`);
  } catch (cause) {
    console.log(`  could not mint the initial supply: ${String(cause)}`);
    console.log('  the deployment does not need it; only transfers do');
  }

  console.log('\nAdd these to scripts/.env:\n');
  console.log(`ADMIN_SECRET_KEY=${admin.secret()}`);
  console.log(`TREASURY_PUBLIC_KEY=${admin.publicKey()}`);
  console.log(`ATTESTER_PUBLIC_KEY=${admin.publicKey()}`);
  console.log(`TOKEN_CONTRACT=${tokenContract}`);
  console.log(
    '\nTreasury and attester are set to the admin key for a testnet bring-up only.\n' +
      'A real deployment gives each its own key: see scripts/.env.example.',
  );
}

await main();
