//! Typed storage layer for the liquidity pool.

use soroban_sdk::{contracttype, Address, Env, Symbol, Vec};

use remit_interfaces::liquidity::{LiquidityError, LiquidityStats, PoolConfig, PoolState};

pub const LEDGERS_PER_DAY: u32 = 17_280;
pub const BUMP_AMOUNT: u32 = 30 * LEDGERS_PER_DAY;
pub const BUMP_THRESHOLD: u32 = BUMP_AMOUNT - LEDGERS_PER_DAY;

/// Namespaced storage keys.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum DataKey {
    Admin,
    Config,
    Stats,
    RegionList,
    /// `Pool(region_id) -> PoolState`
    Pool(Symbol),
    /// `Exposure(agent, region_id) -> i128` — float currently drawn.
    Exposure(Address, Symbol),
    /// `Shares(provider, region_id) -> i128`
    Shares(Address, Symbol),
}

/* ---------------------------- instance ---------------------------- */

pub fn has_admin(env: &Env) -> bool {
    env.storage().instance().has(&DataKey::Admin)
}

pub fn get_admin(env: &Env) -> Result<Address, LiquidityError> {
    env.storage()
        .instance()
        .get(&DataKey::Admin)
        .ok_or(LiquidityError::NotInitialized)
}

pub fn set_admin(env: &Env, admin: &Address) {
    env.storage().instance().set(&DataKey::Admin, admin);
}

pub fn get_config(env: &Env) -> Result<PoolConfig, LiquidityError> {
    env.storage()
        .instance()
        .get(&DataKey::Config)
        .ok_or(LiquidityError::NotInitialized)
}

pub fn set_config(env: &Env, config: &PoolConfig) {
    env.storage().instance().set(&DataKey::Config, config);
}

pub fn get_stats(env: &Env) -> LiquidityStats {
    env.storage()
        .instance()
        .get(&DataKey::Stats)
        .unwrap_or_default()
}

pub fn set_stats(env: &Env, stats: &LiquidityStats) {
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

pub fn get_pool(env: &Env, region_id: &Symbol) -> Option<PoolState> {
    let key = DataKey::Pool(region_id.clone());
    let state: Option<PoolState> = env.storage().persistent().get(&key);
    if state.is_some() {
        bump_persistent(env, &key);
    }
    state
}

pub fn set_pool(env: &Env, state: &PoolState) {
    let key = DataKey::Pool(state.region_id.clone());
    env.storage().persistent().set(&key, state);
    bump_persistent(env, &key);
}

pub fn region_list(env: &Env) -> Vec<Symbol> {
    env.storage()
        .persistent()
        .get(&DataKey::RegionList)
        .unwrap_or_else(|| Vec::new(env))
}

pub fn push_region(env: &Env, region_id: &Symbol) {
    let mut list = region_list(env);
    if !list.contains(region_id) {
        list.push_back(region_id.clone());
    }
    let key = DataKey::RegionList;
    env.storage().persistent().set(&key, &list);
    bump_persistent(env, &key);
}

pub fn get_exposure(env: &Env, agent: &Address, region_id: &Symbol) -> i128 {
    let key = DataKey::Exposure(agent.clone(), region_id.clone());
    let value: i128 = env.storage().persistent().get(&key).unwrap_or(0);
    if value != 0 {
        bump_persistent(env, &key);
    }
    value
}

pub fn set_exposure(env: &Env, agent: &Address, region_id: &Symbol, value: i128) {
    let key = DataKey::Exposure(agent.clone(), region_id.clone());
    env.storage().persistent().set(&key, &value);
    bump_persistent(env, &key);
}

pub fn get_shares(env: &Env, provider: &Address, region_id: &Symbol) -> i128 {
    let key = DataKey::Shares(provider.clone(), region_id.clone());
    let value: i128 = env.storage().persistent().get(&key).unwrap_or(0);
    if value != 0 {
        bump_persistent(env, &key);
    }
    value
}

pub fn set_shares(env: &Env, provider: &Address, region_id: &Symbol, value: i128) {
    let key = DataKey::Shares(provider.clone(), region_id.clone());
    env.storage().persistent().set(&key, &value);
    bump_persistent(env, &key);
}
