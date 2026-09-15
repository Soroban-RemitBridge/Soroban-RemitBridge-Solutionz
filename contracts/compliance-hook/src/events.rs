//! Contract events for the compliance gate.
//!
//! The operator console subscribes to these to build its compliance-monitoring
//! view. Note what is *absent*: no name, no document reference, no provider
//! payload — only the subject's address, a tier, an opaque hash and the reason
//! tag. Travel-rule data is assembled off-chain where it can be access
//! controlled and retained lawfully.

use soroban_sdk::{symbol_short, Address, BytesN, Env, Symbol};

use crate::types::{KycTier, TierThresholds};

/// An attester published or refreshed a verification result.
pub fn attestation_published(
    env: &Env,
    subject: &Address,
    tier: KycTier,
    attestation_hash: &BytesN<32>,
    provider_id: &Symbol,
    expires_at: u64,
) {
    env.events().publish(
        (symbol_short!("kyc_pub"), subject.clone()),
        (tier, attestation_hash.clone(), provider_id.clone(), expires_at),
    );
}

/// An attester revoked a verification result. Kept separate from
/// `attestation_published` so a sanctions hit is unmissable in the log.
pub fn attestation_revoked(env: &Env, subject: &Address, reason: &Symbol) {
    env.events()
        .publish((symbol_short!("kyc_rev"), subject.clone()), reason.clone());
}

/// The operator changed a corridor's tiering rules.
pub fn thresholds_updated(env: &Env, corridor_id: &Symbol, thresholds: &TierThresholds) {
    env.events().publish(
        (symbol_short!("kyc_tier"), corridor_id.clone()),
        (
            thresholds.tier1_max,
            thresholds.tier2_max,
            thresholds.daily_limit,
        ),
    );
}

/// An attester key was granted or revoked.
pub fn operator_updated(env: &Env, operator: &Address, allowed: bool) {
    env.events()
        .publish((symbol_short!("kyc_oper"), operator.clone()), allowed);
}

/// Compliance enforcement was paused or resumed contract-wide.
pub fn pause_changed(env: &Env, paused: bool) {
    env.events().publish((symbol_short!("kyc_paus"),), paused);
}

/// The escrow contract allowed to commit volume was set or rotated.
pub fn escrow_updated(env: &Env, escrow: &Address) {
    env.events()
        .publish((symbol_short!("kyc_escr"),), escrow.clone());
}

/// A transfer passed the gate and its volume was committed to the daily bucket.
pub fn transfer_committed(
    env: &Env,
    sender: &Address,
    corridor_id: &Symbol,
    amount: i128,
    tier: KycTier,
    new_daily_total: i128,
) {
    env.events().publish(
        (symbol_short!("kyc_comm"), sender.clone(), corridor_id.clone()),
        (amount, tier, new_daily_total),
    );
}

// Note: there is deliberately no `transfer_refused` event.
//
// A refusal makes the escrow revert the whole transaction, and Soroban discards
// events from reverted invocations — so an on-chain refusal log is not
// achievable without committing a write on every rejected attempt, which would
// hand an attacker a cheap way to bloat the ledger. Refusals are instead
// recorded off-chain by the backend, which sees the typed error the escrow
// returns, and the machine-readable tags in `hook::reason_tag` give that record
// a stable vocabulary.
