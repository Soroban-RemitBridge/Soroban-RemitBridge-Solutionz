//! Escrow events.
//!
//! This is the primary feed for the backend's event indexer, which rebuilds both
//! the sender-facing "where is my money" tracker and the agent-side transaction
//! history from it. Two properties matter more than completeness here:
//!
//! 1. **Topic-first layout.** Soroban filters events by topic, not payload, so
//!    every event leads with a symbol and keeps identifiers in the topic tuple.
//! 2. **Everything needed to reconcile, nothing needed to deanonymise.** Amounts,
//!    ids, addresses and the claim hash are here; the claim code and the
//!    recipient's identity are not, and never were on-chain.

use soroban_sdk::{symbol_short, Address, BytesN, Env, Symbol};

/// Funds locked and a claim code hash committed.
///
/// `claim_hash` is emitted so a watcher can independently confirm, at claim time,
/// that the reveal the agent presented hashed to what the sender committed.
pub fn transfer_created(
    env: &Env,
    id: u64,
    sender: &Address,
    amount: i128,
    token: &Address,
    corridor_id: &Symbol,
    claim_hash: &BytesN<32>,
    expiry: u64,
) {
    env.events().publish(
        (
            symbol_short!("tr_create"),
            sender.clone(),
            corridor_id.clone(),
        ),
        (id, amount, token.clone(), claim_hash.clone(), expiry),
    );
}

/// A transfer settled to an agent. `payout` is net of the platform fee.
pub fn transfer_claimed(
    env: &Env,
    id: u64,
    agent: &Address,
    corridor_id: &Symbol,
    gross: i128,
    fee: i128,
    payout: i128,
) {
    env.events().publish(
        (
            symbol_short!("tr_claim"),
            agent.clone(),
            corridor_id.clone(),
        ),
        (id, gross, fee, payout),
    );
}

/// An expired transfer was returned to its sender.
pub fn transfer_refunded(env: &Env, id: u64, sender: &Address, amount: i128, corridor_id: &Symbol) {
    env.events().publish(
        (
            symbol_short!("tr_refnd"),
            sender.clone(),
            corridor_id.clone(),
        ),
        (id, amount),
    );
}

/// The sender withdrew a transfer nobody had claimed.
pub fn transfer_cancelled(
    env: &Env,
    id: u64,
    sender: &Address,
    amount: i128,
    corridor_id: &Symbol,
) {
    env.events().publish(
        (
            symbol_short!("tr_cncl"),
            sender.clone(),
            corridor_id.clone(),
        ),
        (id, amount),
    );
}

/// Configuration changed (fee, treasury, pause, expiry ceiling).
///
/// One topic with a tag in the payload rather than four separate events: the
/// console renders them all in the same configuration-audit timeline, and
/// consumers that care about the detail can read the payload.
pub fn config_updated(env: &Env, tag: &Symbol, fee_bps: u32, paused: bool, max_expiry_secs: u64) {
    env.events().publish(
        (symbol_short!("esc_cfg"), tag.clone()),
        (fee_bps, paused, max_expiry_secs),
    );
}

/// The cross-contract address of the registry or the compliance hook changed.
///
/// Worth an explicit event because it is the escrow's sharpest operational
/// control: re-pointing these is both an upgrade path and an incident-response
/// action.
pub fn wiring_updated(env: &Env, tag: &Symbol, address: &Address) {
    env.events()
        .publish((symbol_short!("esc_wire"), tag.clone()), address.clone());
}

/// The operator key rotated.
pub fn admin_changed(env: &Env, previous: &Address, next: &Address) {
    env.events()
        .publish((symbol_short!("esc_adm"), previous.clone()), next.clone());
}
