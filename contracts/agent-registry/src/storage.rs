//! Typed storage layer.
//!
//! All state is reached through the accessors here rather than by touching
//! `env.storage()` directly, so TTL extension, instance-vs-persistent placement
//! and the "missing key means business error" mapping are decided in one place.

use soroban_sdk::{contracttype, Address, Env, Symbol, Vec};

use crate::errors::AgentRegistryError;
use crate::types::{Agent, RegionConfig, RegistryStats};

/// Soroban closes a ledger roughly every 5 seconds; ~17_280 ledgers is a day.
pub const LEDGERS_PER_DAY: u32 = 17_280;
/// How far ahead we push an entry's time-to-live on every touch.
pub const BUMP_AMOUNT: u32 = 30 * LEDGERS_PER_DAY;
/// Extend only once an entry has dropped below this remaining TTL, so we do not
/// pay for a bump on every single call.
pub const BUMP_THRESHOLD: u32 = BUMP_AMOUNT - LEDGERS_PER_DAY;

/// Namespaced storage keys.
///
/// `Admin`, `BondToken` and `Stats` are contract-wide singletons and live in
/// *instance* storage (cheap to read on every call, dies with the contract);
/// per-agent and per-region entries live in *persistent* storage because they
/// must outlive long stretches of inactivity.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum DataKey {
    Admin,
    BondToken,
    /// Destination for slashed bond. Separate from `Admin` so a hot operator
    /// key can be rotated or compromised without redirecting recovered funds.
    Treasury,
    Stats,
    /// Every region the operator has ever configured.
    RegionList,
    /// `Region(region_id) -> RegionConfig`
    Region(Symbol),
    /// `RegionAgents(region_id) -> Vec<Address>`
    RegionAgents(Symbol),
    /// `CorridorRegion(corridor_id) -> region_id`. Lets `RemitEscrow`, which
    /// only knows a corridor symbol, resolve the region an agent must belong to.
    CorridorRegion(Symbol),
    /// `Agent(address) -> Agent`
    Agent(Address),
}

/* ------------------------------------------------------------------ */
/* instance storage                                                    */
/* ------------------------------------------------------------------ */

pub fn has_admin(env: &Env) -> bool {
    env.storage().instance().has(&DataKey::Admin)
}

pub fn get_admin(env: &Env) -> Result<Address, AgentRegistryError> {
    env.storage()
        .instance()
        .get(&DataKey::Admin)
        .ok_or(AgentRegistryError::NotInitialized)
}

pub fn set_admin(env: &Env, admin: &Address) {
    env.storage().instance().set(&DataKey::Admin, admin);
}

pub fn get_bond_token(env: &Env) -> Result<Address, AgentRegistryError> {
    env.storage()
        .instance()
        .get(&DataKey::BondToken)
        .ok_or(AgentRegistryError::NotInitialized)
}

pub fn set_bond_token(env: &Env, token: &Address) {
    env.storage().instance().set(&DataKey::BondToken, token);
}

pub fn get_treasury(env: &Env) -> Result<Address, AgentRegistryError> {
    env.storage()
        .instance()
        .get(&DataKey::Treasury)
        .ok_or(AgentRegistryError::NotInitialized)
}

pub fn set_treasury(env: &Env, treasury: &Address) {
    env.storage().instance().set(&DataKey::Treasury, treasury);
}

pub fn get_stats(env: &Env) -> RegistryStats {
    env.storage()
        .instance()
        .get(&DataKey::Stats)
        .unwrap_or_default()
}

pub fn set_stats(env: &Env, stats: &RegistryStats) {
    env.storage().instance().set(&DataKey::Stats, stats);
}

/// Push the contract's instance TTL forward. Called on every mutating entry
/// point so the admin, token and counters never expire mid-life.
pub fn bump_instance(env: &Env) {
    env.storage()
        .instance()
        .extend_ttl(BUMP_THRESHOLD, BUMP_AMOUNT);
}

/* ------------------------------------------------------------------ */
/* persistent storage                                                  */
/* ------------------------------------------------------------------ */

fn bump_persistent(env: &Env, key: &DataKey) {
    env.storage()
        .persistent()
        .extend_ttl(key, BUMP_THRESHOLD, BUMP_AMOUNT);
}

pub fn get_region(env: &Env, region_id: &Symbol) -> Option<RegionConfig> {
    env.storage()
        .persistent()
        .get(&DataKey::Region(region_id.clone()))
}

pub fn set_region(env: &Env, config: &RegionConfig) {
    let key = DataKey::Region(config.region_id.clone());
    env.storage().persistent().set(&key, config);
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

pub fn get_agent(env: &Env, agent: &Address) -> Option<Agent> {
    let key = DataKey::Agent(agent.clone());
    let record: Option<Agent> = env.storage().persistent().get(&key);
    if record.is_some() {
        bump_persistent(env, &key);
    }
    record
}

pub fn set_agent(env: &Env, agent: &Agent) {
    let key = DataKey::Agent(agent.address.clone());
    env.storage().persistent().set(&key, agent);
    bump_persistent(env, &key);
}

pub fn region_agents(env: &Env, region_id: &Symbol) -> Vec<Address> {
    env.storage()
        .persistent()
        .get(&DataKey::RegionAgents(region_id.clone()))
        .unwrap_or_else(|| Vec::new(env))
}

/// Add an agent to a region's index.
///
/// The index is a plain `Vec` and therefore re-written on each insert: fine for
/// the hundreds-of-agents scale this network targets, but a production
/// deployment at tens of thousands of agents per region should move to a
/// bucketed/paginated index to keep write costs flat.
pub fn push_region_agent(env: &Env, region_id: &Symbol, agent: &Address) {
    let mut agents = region_agents(env, region_id);
    if !agents.contains(agent) {
        agents.push_back(agent.clone());
    }
    let key = DataKey::RegionAgents(region_id.clone());
    env.storage().persistent().set(&key, &agents);
    bump_persistent(env, &key);
}

pub fn count_region_agents(env: &Env, region_id: &Symbol) -> u32 {
    region_agents(env, region_id).len()
}

pub fn get_corridor_region(env: &Env, corridor_id: &Symbol) -> Option<Symbol> {
    env.storage()
        .persistent()
        .get(&DataKey::CorridorRegion(corridor_id.clone()))
}

pub fn set_corridor_region(env: &Env, corridor_id: &Symbol, region_id: &Symbol) {
    let key = DataKey::CorridorRegion(corridor_id.clone());
    env.storage().persistent().set(&key, region_id);
    bump_persistent(env, &key);
}
