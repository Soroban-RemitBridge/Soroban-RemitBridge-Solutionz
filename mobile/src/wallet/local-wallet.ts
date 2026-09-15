import * as SecureStore from 'expo-secure-store';
import { Keypair, TransactionBuilder } from '@stellar/stellar-sdk';

import { WalletUnavailableError, type WalletAdapter } from './adapter';

/**
 * A Stellar keypair held in the device keychain.
 *
 * This exists so the sender flow is actually runnable — against testnet, on a
 * phone, without a browser wallet app. It is **not** a production custody story
 * and the code says so rather than leaving it to be discovered:
 *
 * - The secret is written to `expo-secure-store`, which is the platform keychain
 *   (Keystore / Keychain). On a rooted or jailbroken device that is readable.
 * - There is no passphrase, no biometric gate and no recovery. Losing the device
 *   loses the funds held under this key.
 * - Mainnet is refused outright. Shipping this adapter to mainnet would be a
 *   custody decision made by a default value, which is the kind of decision that
 *   should require someone to write code on purpose.
 *
 * A production build plugs in a WalletConnect adapter behind the same interface;
 * see `adapter.ts`.
 */

const SECRET_KEY_STORAGE_KEY = 'remitbridge.sender.secret';

export class MainnetRefusedError extends Error {
  constructor() {
    super(
      'The local keypair wallet refuses to sign on mainnet. Use a browser or WalletConnect wallet for production.',
    );
    this.name = 'MainnetRefusedError';
  }
}

export class LocalKeypairWallet implements WalletAdapter {
  readonly id = 'local-keypair';
  readonly label = 'This device (testnet)';

  #cached: Keypair | null = null;

  async isAvailable(): Promise<boolean> {
    return true;
  }

  async getPublicKey(): Promise<string> {
    return (await this.#load()).publicKey();
  }

  /**
   * Provision a key for this device if there is not one already.
   *
   * Returns the public key. Called explicitly by the sender flow rather than
   * implicitly on read, so the customer sees "a wallet was created on this
   * device" rather than having one appear.
   */
  async ensureKeypair(): Promise<string> {
    const existing = await SecureStore.getItemAsync(SECRET_KEY_STORAGE_KEY);
    if (existing === null) {
      const generated = Keypair.random();
      await SecureStore.setItemAsync(SECRET_KEY_STORAGE_KEY, generated.secret(), {
        keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
      });
      this.#cached = generated;
      return generated.publicKey();
    }
    const loaded = Keypair.fromSecret(existing);
    this.#cached = loaded;
    return loaded.publicKey();
  }

  async hasKeypair(): Promise<boolean> {
    return (await SecureStore.getItemAsync(SECRET_KEY_STORAGE_KEY)) !== null;
  }

  async signTransaction(unsignedXdr: string, networkPassphrase: string): Promise<string> {
    if (networkPassphrase.toLowerCase().includes('public')) {
      throw new MainnetRefusedError();
    }

    const keypair = await this.#load();

    // Round-tripping through the SDK rather than string surgery: the signature
    // has to cover exactly the envelope the backend built, and a hand-rolled
    // concatenation is how a transaction ends up signed over different bytes
    // than it carries.
    const transaction = TransactionBuilder.fromXDR(unsignedXdr, networkPassphrase);
    if ('sign' in transaction && typeof transaction.sign === 'function') {
      transaction.sign(keypair);
      return transaction.toXDR();
    }
    throw new WalletUnavailableError('The transaction envelope cannot carry signatures.');
  }

  async #load(): Promise<Keypair> {
    if (this.#cached !== null) return this.#cached;
    const stored = await SecureStore.getItemAsync(SECRET_KEY_STORAGE_KEY);
    if (stored === null) {
      throw new WalletUnavailableError(
        'No sender key exists on this device yet. Create one before signing.',
      );
    }
    const keypair = Keypair.fromSecret(stored);
    this.#cached = keypair;
    return keypair;
  }
}
