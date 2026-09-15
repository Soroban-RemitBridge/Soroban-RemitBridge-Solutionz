/**
 * Wallet seam.
 *
 * The sender's escrow deposit is authorised by their own key, so the signing
 * step has to happen on the device. Which *implementation* does that is a
 * deployment choice, and the two realistic answers have very different shapes:
 *
 * - **Browser/extension wallets** (Freighter, xBull, Stellar Wallets Kit) sign
 *   inside the wallet app. On mobile this arrives over WalletConnect or a deep
 *   link, so `signTransaction` becomes a round trip the user confirms.
 * - **A key on the device** signs locally. Necessary for testnet demos and for
 *   users who have no wallet app at all — which, for a recipient-facing
 *   product, is most of them.
 *
 * Both are expressed by this interface, so the flows call `signTransaction` and
 * do not care which one is plugged in. `LocalKeypairWallet` implements it for
 * development against testnet; see `local-wallet.ts` for why it refuses to run
 * on mainnet.
 *
 * Note that recipients never touch this. The whole point of the agent network is
 * that a recipient needs no wallet, no seed phrase and no literacy in either
 * before they can collect cash.
 */

export interface WalletAdapter {
  /** Stable identifier, e.g. `local-keypair` or `walletconnect`. */
  readonly id: string;
  /** Human-readable name for the UI. */
  readonly label: string;
  /**
   * Whether this wallet can sign right now. A browser-wallet adapter returns
   * false when the wallet app is not reachable; the UI then offers the deep link
   * instead of a submit button that will fail.
   */
  isAvailable(): Promise<boolean>;
  /** The account that will be debited. */
  getPublicKey(): Promise<string>;
  /**
   * Sign an unsigned transaction envelope.
   *
   * Takes and returns base64 XDR rather than a parsed object so the adapter does
   * not need to agree with the caller about how transactions are built — the
   * backend builds, the wallet signs, the backend submits. The secret never
   * leaves whichever component holds it.
   */
  signTransaction(unsignedXdr: string, networkPassphrase: string): Promise<string>;
}

export class WalletUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WalletUnavailableError';
  }
}
