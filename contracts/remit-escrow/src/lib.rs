#![no_std]
#![deny(clippy::all)]
#![warn(clippy::pedantic)]
#![allow(clippy::needless_pass_by_value)]
#![allow(clippy::too_many_arguments)]
#![allow(clippy::missing_errors_doc)]
#![allow(clippy::missing_panics_doc)]
#![allow(clippy::module_name_repetitions)]
#![allow(clippy::must_use_candidate)]
#![allow(clippy::doc_markdown)]

//! # RemitBridge — Remit Escrow
//!
//! Locks a sender's funds against a **hash** of a claim code, and releases them
//! only to a bonded, authorized agent who can produce the code. The recipient
//! never needs a wallet: they carry a code or QR to a local agent, who settles
//! it on-chain and hands over cash.
//!
//! ## Why commit-reveal, and not "the escrow holds the code"
//!
//! The naive design stores the claim code in the contract so the agent can check
//! it. That fails in an obvious way once you say it out loud: the code is then
//! readable by anyone with a ledger viewer, so anyone can front-run the intended
//! recipient and claim the transfer.
//!
//! Storing `sha256(code)` instead inverts the trust requirement. The code exists
//! in exactly two places off-chain — the sender's screen and the recipient's
//! hand — and the chain only ever sees a commitment to it. A leaked ledger
//! reveals that *a* transfer exists and how much it is worth, never who can
//! claim it.
//!
//! What this does **not** protect against is a weak code. The contract cannot
//! distinguish `sha256("1234")` from `sha256(256 random bits)`; a guessable code
//! is brute-forceable offline from the published hash. Code generation is
//! therefore a hard requirement on the client, specified in `docs/security.md`
//! and implemented once, in `mobile/src/lib/claim.ts`, so there is a single place
//! to get it right.
//!
//! ## Refund, expiry and the race the design accepts
//!
//! A transfer that nobody claims before `expiry` can be returned by *anyone* via
//! [`refund_expired`]. That is intentional: the sender may have abandoned the
//! transfer or lost their key, and requiring their signature would mean funds
//! locked forever. The destination is always the address recorded at creation,
//! so a third party can help but never redirect.
//!
//! Cancellation is the softer cousin, and it leaves a real race open: a sender
//! who has already handed the code to a recipient can cancel while the agent is
//! counting out cash, and the agent's subsequent claim fails. There is no way to
//! close this on-chain without either forcing the agent to pre-announce its
//! claim (leaking the code) or holding the sender's funds hostage for the full
//! expiry window. It is instead closed procedurally: the agent app re-reads the
//! transfer status immediately before releasing cash, exactly as a card terminal
//! re-authorises at the counter. Documented rather than hidden — see
//! `docs/security.md`.
//!
//! ## Trust model
//!
//! | Actor | Can do | Cannot do |
//! | --- | --- | --- |
//! | Admin (operator key) | Set fee (capped on-chain at 5%), re-point the registry and compliance hook, pause *creation* | Move a pending transfer's funds, unpause into a claim, or exceed the fee cap |
//! | Sender | Create, cancel before any claim | Claim their own transfer |
//! | Authorized agent | Claim with a valid code, in the transfer's corridor only | Claim without the code, claim in another region, claim twice |
//! | Anyone | Trigger an expired refund, read any transfer | Redirect a refund |
//!
//! Note what a pause can and cannot do. `set_paused` stops new transfers and
//! nothing else: claims and refunds keep working, so an incident never traps
//! money that is already in flight. A pause that also froze claims would hand
//! the operator exactly the power this contract exists to constrain.
//!
//! ## What the escrow deliberately does not do
//!
//! It does not verify identity, hold bonds, or price anything. Those live in the
//! compliance hook, the registry and the quoting service respectively — three
//! components that change on regulatory and commercial timescales, none of which
//! should require redeploying the contract that custodies user funds.

mod escrow;
mod events;
mod storage;

#[cfg(test)]
mod test;

pub use remit_interfaces::escrow::{
    ClaimQuote, ClaimReceipt, EscrowConfig, EscrowError, EscrowInterface, EscrowStats, Transfer,
    TransferStatus, MAX_FEE_BPS,
};

use soroban_sdk::contract;

/// The commit-reveal transfer escrow.
///
/// `#[contract]` generates `RemitEscrowClient`, used by the deployment script and
/// by this crate's test suite:
///
/// ```ignore
/// let client = RemitEscrowClient::new(&env, &escrow_id);
/// let id = client.create_transfer(&sender, &amount, &token, &claim_hash, &corridor, &expiry);
/// ```
#[contract]
pub struct RemitEscrow;
