//! Typed storage layer for the escrow.

use soroban_sdk::{contracttype, Address, Env, Vec};

use remit_interfaces::escrow::{EscrowConfig, EscrowError, EscrowStats, Transfer};

pub const LEDGERS_PER_DAY: u32 = 17_280;
pub const BUMP_AMOUNT: u32 = 30 * LEDGERS_PER_DAY;
pub const BUMP_THRESHOLD: u32 = BUMP_AMOUNT - LEDGERS_PER_DAY;

/// Namespaced storage keys.
///
/// `Admin`, `Config`, `Stats` and `NextId` are contract-wide singletons in
/// instance storage: they are touched by nearly every call, so paying the
/// slightly higher rent for instance storage is cheaper than a persistent lookup
/// on the hot path. Per-transfer records are persistent — a transfer must
/// outlive any period of inactivity, because a sender may reasonably refund
/// months later.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum DataKey {
    Admin,
    Config,
    Stats,
    NextId,
    /// `Transfer(transfer_id) -> Transfer`
    Transfer(u64),
    /// `SenderTransfers(sender) -> Vec<u64>`
    SenderTransfers(Address),
}

/* ---------------------------- instance ---------------------------- */

pub fn has_admin(env: &Env) -> bool {
    env.storage().instance().has(&DataKey::Admin)
}

pub fn get_admin(env: &Env) -> Result<Address, EscrowError> {
    env.storage()
        .instance()
        .get(&DataKey::Admin)
        .ok_or(EscrowError::NotInitialized)
}

pub fn set_admin(env: &Env, admin: &Address) {
    env.storage().instance().set(&DataKey::Admin, admin);
}

pub fn get_config(env: &Env) -> Result<EscrowConfig, EscrowError> {
    env.storage()
        .instance()
        .get(&DataKey::Config)
        .ok_or(EscrowError::NotInitialized)
}

pub fn set_config(env: &Env, config: &EscrowConfig) {
    env.storage().instance().set(&DataKey::Config, config);
}

pub fn get_stats(env: &Env) -> EscrowStats {
    env.storage()
        .instance()
        .get(&DataKey::Stats)
        .unwrap_or_default()
}

pub fn set_stats(env: &Env, stats: &EscrowStats) {
    env.storage().instance().set(&DataKey::Stats, stats);
}

/// Allocate the next transfer id.
///
/// Ids are monotonic and never reused, so an indexer that has seen id `n` can
/// safely assume every id below it exists.
pub fn next_id(env: &Env) -> u64 {
    let current: u64 = env.storage().instance().get(&DataKey::NextId).unwrap_or(0);
    let next = current + 1;
    env.storage().instance().set(&DataKey::NextId, &next);
    next
}

pub fn transfer_count(env: &Env) -> u64 {
    env.storage().instance().get(&DataKey::NextId).unwrap_or(0)
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

pub fn get_transfer(env: &Env, id: u64) -> Option<Transfer> {
    let key = DataKey::Transfer(id);
    let record: Option<Transfer> = env.storage().persistent().get(&key);
    if record.is_some() {
        bump_persistent(env, &key);
    }
    record
}

pub fn set_transfer(env: &Env, transfer: &Transfer) {
    let key = DataKey::Transfer(transfer.id);
    env.storage().persistent().set(&key, transfer);
    bump_persistent(env, &key);
}

pub fn sender_transfers(env: &Env, sender: &Address) -> Vec<u64> {
    env.storage()
        .persistent()
        .get(&DataKey::SenderTransfers(sender.clone()))
        .unwrap_or_else(|| Vec::new(env))
}

/// Append a transfer id to the sender's index.
///
/// Like the registry's region index, this is a plain `Vec` rewritten on each
/// insert: correct and cheap at the scale this network targets, but a deployment
/// with thousands of transfers per sender should move to a bucketed index — see
/// the roadmap in the README.
pub fn push_sender_transfer(env: &Env, sender: &Address, id: u64) {
    let mut ids = sender_transfers(env, sender);
    ids.push_back(id);
    let key = DataKey::SenderTransfers(sender.clone());
    env.storage().persistent().set(&key, &ids);
    bump_persistent(env, &key);
}
