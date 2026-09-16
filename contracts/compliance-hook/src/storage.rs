//! Typed storage layer for the compliance hook.

use soroban_sdk::{contracttype, Address, Env, Symbol, Vec};

use crate::errors::ComplianceError;
use crate::types::{Attestation, ComplianceStats, TierThresholds};

pub const LEDGERS_PER_DAY: u32 = 17_280;
pub const BUMP_AMOUNT: u32 = 30 * LEDGERS_PER_DAY;
pub const BUMP_THRESHOLD: u32 = BUMP_AMOUNT - LEDGERS_PER_DAY;

/// TTL policy for a rolling-volume bucket, which is deliberately much shorter
/// than [`BUMP_AMOUNT`].
///
/// The bucket key embeds the day it covers, so yesterday's bucket is never read
/// again: its useful life is bounded at one day, not thirty. Every other entry
/// in this contract is either configuration or an attestation that stays live
/// for weeks, which is why only this one gets the short policy.
pub const VOLUME_BUMP_AMOUNT: u32 = 3 * LEDGERS_PER_DAY;
pub const VOLUME_BUMP_THRESHOLD: u32 = VOLUME_BUMP_AMOUNT - LEDGERS_PER_DAY;

/// Ledgers a rolling day is measured in for the daily-volume bucket key.
pub const SECONDS_PER_DAY: u64 = 86_400;

/// Namespaced storage keys.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum DataKey {
    Admin,
    Paused,
    Escrow,
    Stats,
    CorridorList,
    /// `Operator(address) -> bool` — addresses allowed to publish attestations.
    /// The backend's attester key lives here, *not* the operator key, so a
    /// compromise of the KYC service cannot reconfigure corridors or unpause.
    Operator(Address),
    /// `TierConfig(corridor_id) -> TierThresholds`
    TierConfig(Symbol),
    /// `Attestation(subject) -> Attestation`
    Attestation(Address),
    /// `DailyVolume(subject, corridor_id, day) -> i128`, `day` being
    /// `timestamp / SECONDS_PER_DAY`.
    DailyVolume(Address, Symbol, u64),
}

/* ---------------------------- instance ---------------------------- */

pub fn has_admin(env: &Env) -> bool {
    env.storage().instance().has(&DataKey::Admin)
}

pub fn get_admin(env: &Env) -> Result<Address, ComplianceError> {
    env.storage()
        .instance()
        .get(&DataKey::Admin)
        .ok_or(ComplianceError::NotInitialized)
}

pub fn set_admin(env: &Env, admin: &Address) {
    env.storage().instance().set(&DataKey::Admin, admin);
}

pub fn is_paused(env: &Env) -> bool {
    env.storage()
        .instance()
        .get(&DataKey::Paused)
        .unwrap_or(false)
}

pub fn set_paused(env: &Env, paused: bool) {
    env.storage().instance().set(&DataKey::Paused, &paused);
}

pub fn get_escrow(env: &Env) -> Result<Address, ComplianceError> {
    env.storage()
        .instance()
        .get(&DataKey::Escrow)
        .ok_or(ComplianceError::EscrowNotSet)
}

pub fn set_escrow(env: &Env, escrow: &Address) {
    env.storage().instance().set(&DataKey::Escrow, escrow);
}

pub fn get_stats(env: &Env) -> ComplianceStats {
    env.storage()
        .instance()
        .get(&DataKey::Stats)
        .unwrap_or_default()
}

pub fn set_stats(env: &Env, stats: &ComplianceStats) {
    env.storage().instance().set(&DataKey::Stats, stats);
}

pub fn bump_instance(env: &Env) {
    env.storage()
        .instance()
        .extend_ttl(BUMP_THRESHOLD, BUMP_AMOUNT);
}

/* --------------------------- persistent --------------------------- */

fn bump_persistent(env: &Env, key: &DataKey) {
    env.storage()
        .persistent()
        .extend_ttl(key, BUMP_THRESHOLD, BUMP_AMOUNT);
}

pub fn is_operator(env: &Env, operator: &Address) -> bool {
    env.storage()
        .persistent()
        .get(&DataKey::Operator(operator.clone()))
        .unwrap_or(false)
}

pub fn set_operator(env: &Env, operator: &Address, allowed: bool) {
    let key = DataKey::Operator(operator.clone());
    env.storage().persistent().set(&key, &allowed);
    bump_persistent(env, &key);
}

pub fn get_thresholds(env: &Env, corridor_id: &Symbol) -> Option<TierThresholds> {
    let key = DataKey::TierConfig(corridor_id.clone());
    let config: Option<TierThresholds> = env.storage().persistent().get(&key);
    if config.is_some() {
        bump_persistent(env, &key);
    }
    config
}

pub fn set_thresholds(env: &Env, config: &TierThresholds) {
    let key = DataKey::TierConfig(config.corridor_id.clone());
    env.storage().persistent().set(&key, config);
    bump_persistent(env, &key);
}

pub fn corridor_list(env: &Env) -> Vec<Symbol> {
    env.storage()
        .persistent()
        .get(&DataKey::CorridorList)
        .unwrap_or_else(|| Vec::new(env))
}

pub fn push_corridor(env: &Env, corridor_id: &Symbol) {
    let mut list = corridor_list(env);
    if !list.contains(corridor_id) {
        list.push_back(corridor_id.clone());
    }
    let key = DataKey::CorridorList;
    env.storage().persistent().set(&key, &list);
    bump_persistent(env, &key);
}

pub fn get_attestation(env: &Env, subject: &Address) -> Option<Attestation> {
    let key = DataKey::Attestation(subject.clone());
    let record: Option<Attestation> = env.storage().persistent().get(&key);
    if record.is_some() {
        bump_persistent(env, &key);
    }
    record
}

pub fn set_attestation(env: &Env, record: &Attestation) {
    let key = DataKey::Attestation(record.subject.clone());
    env.storage().persistent().set(&key, record);
    bump_persistent(env, &key);
}

/* ------------------------- rolling volume ------------------------- */

/// UTC-day bucket used to bucket rolling volume.
pub fn day_of(timestamp: u64) -> u64 {
    timestamp / SECONDS_PER_DAY
}

/// Read a day's volume bucket without extending its TTL.
///
/// Deliberately no bump here. A bucket is kept alive by the write that charges
/// it, and every other reader of this value is either the ceiling check in the
/// same invocation or an off-chain view; extending on read would make the
/// cheapest path (a query) the one that reserves rent.
pub fn daily_volume(env: &Env, subject: &Address, corridor_id: &Symbol, day: u64) -> i128 {
    let key = DataKey::DailyVolume(subject.clone(), corridor_id.clone(), day);
    env.storage().persistent().get(&key).unwrap_or(0)
}

/// Write a day's volume bucket.
///
/// The total is passed in rather than added here so that the caller that
/// *checked* the ceiling against a value is the one that stores it. Reading the
/// bucket again to add to it would let the check and the write disagree if two
/// callers interleaved, and costs an extra ledger read on every transfer.
pub fn set_daily_volume(
    env: &Env,
    subject: &Address,
    corridor_id: &Symbol,
    day: u64,
    total: i128,
) -> i128 {
    let key = DataKey::DailyVolume(subject.clone(), corridor_id.clone(), day);
    env.storage().persistent().set(&key, &total);
    // A bucket is only ever consulted on the day it covers, so it is bumped for
    // days, not for a month. Reserving thirty days of rent for a value that is
    // dead tomorrow was the single largest avoidable cost in the transfer path.
    env.storage()
        .persistent()
        .extend_ttl(&key, VOLUME_BUMP_THRESHOLD, VOLUME_BUMP_AMOUNT);
    total
}
