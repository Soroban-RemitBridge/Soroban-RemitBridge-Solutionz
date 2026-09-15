//! Typed storage layer for the compliance hook.

use soroban_sdk::{contracttype, Address, Env, Symbol, Vec};

use crate::errors::ComplianceError;
use crate::types::{Attestation, ComplianceStats, TierThresholds};

pub const LEDGERS_PER_DAY: u32 = 17_280;
pub const BUMP_AMOUNT: u32 = 30 * LEDGERS_PER_DAY;
pub const BUMP_THRESHOLD: u32 = BUMP_AMOUNT - LEDGERS_PER_DAY;

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

pub fn daily_volume(env: &Env, subject: &Address, corridor_id: &Symbol, day: u64) -> i128 {
    let key = DataKey::DailyVolume(subject.clone(), corridor_id.clone(), day);
    let value: i128 = env.storage().persistent().get(&key).unwrap_or(0);
    if value != 0 {
        bump_persistent(env, &key);
    }
    value
}

pub fn add_daily_volume(
    env: &Env,
    subject: &Address,
    corridor_id: &Symbol,
    day: u64,
    amount: i128,
) -> Result<i128, ComplianceError> {
    let current = daily_volume(env, subject, corridor_id, day);
    let updated = current
        .checked_add(amount)
        .ok_or(ComplianceError::Overflow)?;
    let key = DataKey::DailyVolume(subject.clone(), corridor_id.clone(), day);
    env.storage().persistent().set(&key, &updated);
    bump_persistent(env, &key);
    Ok(updated)
}
