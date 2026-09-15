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
#![allow(clippy::cast_possible_truncation)]

//! # RemitBridge — Compliance Hook
//!
//! The tiered KYC/AML gate that [`remit_escrow`] consults *before* it locks any
//! sender funds. Splitting this out of the escrow is the whole point: the
//! value-moving contract stays small and auditable, and compliance rules that
//! change far more often (per corridor, per regulator) can be reconfigured —
//! or, in a future version, swapped for a different contract — without touching
//! custody logic.
//!
//! ## Data minimisation is the design, not a feature
//!
//! The chain never sees a name, a document number or a screening result. What it
//! sees is:
//!
//! * `sha256` of the backend's signed verification payload ([`Attestation::attestation_hash`])
//! * an ordinal tier, so the contract can compare it against a threshold
//! * an expiry, so verification is periodically refreshed
//! * a provider tag, so a provider migration is visible in the event history
//!
//! Everything else stays in Postgres. `docs/trust-and-compliance.md` covers the
//! retention and access-control argument, and the API in
//! `backend/src/kyc-orchestration` is the only supported way to write here.
//!
//! ## Tier bands
//!
//! Per corridor, `tier1_max` and `tier2_max` partition transfer amounts:
//!
//! | Amount | Required tier |
//! | --- | --- |
//! | `<= tier1_max` | none |
//! | `<= tier2_max` | `Standard` |
//! | `> tier2_max` | `Enhanced` |
//!
//! A separate `daily_limit` is enforced cumulatively per sender, because the
//! classic structuring attack — many small transfers just under the reporting
//! threshold — is invisible to a per-transfer rule.
//!
//! ## Trust model
//!
//! | Actor | Can do | Cannot do |
//! | --- | --- | --- |
//! | Admin (operator key) | Set tier thresholds, grant/revoke attester keys, register the escrow, pause everything | Read the underlying KYC record |
//! | Attester (backend key) | Publish and revoke attestations for a subject | Change tiers, pause, or read other subjects' records |
//! | Escrow contract | Commit a sender's volume after a successful check | Publish attestations |
//! | Anyone | Call `check_transfer_allowed` / `explain_transfer` (read-only, no state) | Write anything |

mod errors;
mod events;
mod hook;
mod storage;
mod types;

#[cfg(test)]
mod test;

pub use crate::errors::ComplianceError;
pub use crate::types::{Attestation, ComplianceStats, KycTier, TierThresholds, TransferDecision};

use soroban_sdk::{contract, Address, BytesN, Env, Symbol, Vec};

/// Public interface of the compliance hook.
///
/// `#[contract]` generates `ComplianceHookClient` from this trait, which is what
/// `RemitEscrow` calls. Because the escrow depends on this crate, changing a
/// signature here breaks the escrow's build instead of its runtime behaviour.
pub trait ComplianceHookInterface {
    /* ---------------- admin ---------------- */

    /// One-time setup with the anchor operator key.
    fn initialize(env: Env, admin: Address) -> Result<(), ComplianceError>;

    /// Grant or revoke a backend key's right to publish attestations.
    ///
    /// This is deliberately separate from the admin key: the compliance service
    /// runs hot and is the most exposed component, so it must not be able to
    /// reconfigure thresholds or unpause the network.
    fn set_operator(
        env: Env,
        operator: Address,
        allowed: bool,
    ) -> Result<(), ComplianceError>;

    /// Register (or rotate) the single escrow contract allowed to commit volume.
    fn set_escrow(env: Env, escrow: Address) -> Result<(), ComplianceError>;

    /// Emergency stop for *all* corridors. Reads still work so the console can
    /// explain the outage.
    fn set_paused(env: Env, paused: bool) -> Result<(), ComplianceError>;

    /// Create or replace a corridor's tier bands.
    fn set_tier_thresholds(
        env: Env,
        thresholds: TierThresholds,
    ) -> Result<(), ComplianceError>;

    fn get_tier_thresholds(env: Env, corridor_id: Symbol) -> Option<TierThresholds>;

    fn list_corridors(env: Env) -> Vec<Symbol>;

    /* ---------------- attestations ---------------- */

    /// Publish a verification result for `subject`.
    ///
    /// `attester` is passed explicitly (rather than inferred) so the contract can
    /// check it against the operator allowlist *and* call `require_auth` on it,
    /// making the authorization tree self-documenting in the transaction.
    fn publish_attestation(
        env: Env,
        attester: Address,
        subject: Address,
        tier: KycTier,
        attestation_hash: BytesN<32>,
        region_id: Symbol,
        provider_id: Symbol,
        expires_at: u64,
    ) -> Result<(), ComplianceError>;

    /// Revoke a subject's attestation (sanctions hit, chargeback, fraud).
    fn revoke_attestation(
        env: Env,
        attester: Address,
        subject: Address,
        reason: Symbol,
    ) -> Result<(), ComplianceError>;

    fn get_attestation(env: Env, subject: Address) -> Option<Attestation>;

    /* ---------------- the gate ---------------- */

    /// Whether a transfer of `amount` from `sender` may proceed in `corridor_id`.
    ///
    /// Pure: performs no writes, so it is safe to call from a read-only
    /// simulation, from the sender app to preflight an amount, and from the
    /// escrow before it locks funds.
    ///
    /// Returns `Ok(true)` when allowed, and a typed error identifying exactly
    /// which rule refused it otherwise. `Ok(false)` is reserved for a future
    /// "allowed pending manual review" outcome and is not produced in v1.
    fn check_transfer_allowed(
        env: Env,
        sender: Address,
        amount: i128,
        corridor_id: Symbol,
    ) -> Result<bool, ComplianceError>;

    /// Non-failing companion to [`Self::check_transfer_allowed`] for UIs.
    fn explain_transfer(
        env: Env,
        sender: Address,
        amount: i128,
        corridor_id: Symbol,
    ) -> TransferDecision;

    /// Commit a checked transfer's amount to the sender's rolling daily bucket.
    ///
    /// Split from the check so the escrow can perform reserve → commit inside one
    /// atomic transaction: the check decides, the commit records, and a failure
    /// in either reverts the whole transfer.
    fn commit_transfer(
        env: Env,
        sender: Address,
        amount: i128,
        corridor_id: Symbol,
    ) -> Result<i128, ComplianceError>;

    fn daily_volume(env: Env, sender: Address, corridor_id: Symbol, day: u64) -> i128;

    fn compliance_stats(env: Env) -> ComplianceStats;
}

/// The on-chain compliance gate.
#[contract]
pub struct ComplianceHook;
