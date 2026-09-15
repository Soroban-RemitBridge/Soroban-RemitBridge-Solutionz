#![no_std]
#![deny(clippy::all)]
#![warn(clippy::pedantic)]
// Soroban's `Env`/`Address` types are passed by value throughout the generated
// client ABI; the pedantic lints that fire on that are not actionable here.
#![allow(clippy::needless_pass_by_value)]
#![allow(clippy::too_many_arguments)]
#![allow(clippy::missing_errors_doc)]
#![allow(clippy::missing_panics_doc)]
#![allow(clippy::module_name_repetitions)]
#![allow(clippy::must_use_candidate)]
#![allow(clippy::doc_markdown)]

//! # RemitBridge — Agent Registry
//!
//! Bonded registry of the cash-out agents that form RemitBridge's "last mile".
//! A small anchor or MTO onboards local shop owners and mobile-money kiosks as
//! agents; each agent posts a bond, and only agents the operator has explicitly
//! authorized can settle a transfer held in [`remit_escrow`].
//!
//! ## Trust model
//!
//! | Actor | Can do | Cannot do |
//! | --- | --- | --- |
//! | Admin (anchor operator key) | Configure regions and corridor mappings, authorize/suspend/revoke agents, slash bonds | Move an agent's *remaining* bond to itself — slashes are capped at the posted bond and paid to the configured treasury |
//! | Agent | Register, top up, withdraw non-locked bond, settle transfers | Authorize itself, raise its own limits, withdraw bond while authorized |
//! | Anyone | Read any record | Write anything |
//!
//! ## What the bond protects against
//!
//! Cash-out fraud is the dominant last-mile risk: an agent takes a claim code,
//! does not hand over cash, and disappears. Because the escrowed funds are
//! released to the agent's settlement address at claim time, the network's only
//! recourse is the bond. It is sized per region (higher-crime corridors carry a
//! higher `min_bond`) and is slashable only by the operator key, which is why
//! that key's custody is called out in the docs as the highest-value secret in
//! the system.
//!
//! ## What is *not* on-chain
//!
//! No PII. An agent record holds an address, a region `Symbol`, a bond amount
//! and timestamps. Legal name, trade licence, ID documents and KYC artefacts
//! stay in the backend database; only the resulting attestation hash is
//! referenced (via the compliance hook). See `docs/architecture.md`.

mod errors;
mod events;
mod registry;
mod storage;
mod types;

#[cfg(test)]
mod test;

pub use crate::errors::AgentRegistryError;
pub use crate::types::{Agent, AgentStatus, RegionConfig, RegistryStats};

use soroban_sdk::{contract, Address, Env, Symbol, Vec};

/// Public interface of the registry.
///
/// Declaring the entry points as a trait (rather than an inherent `impl`) is
/// what lets `#[contract]` generate `AgentRegistryClient` from it. `RemitEscrow`
/// and `LiquidityPool` depend on this crate and call that generated client, so a
/// signature change here becomes a *compile* error in every dependent contract
/// instead of a runtime surprise.
pub trait AgentRegistryInterface {
    /* ---------------- lifecycle ---------------- */

    /// One-time setup. `admin` is the anchor operator key; `bond_token` is the
    /// asset agents must post as collateral (a stablecoin in practice).
    fn initialize(
        env: Env,
        admin: Address,
        bond_token: Address,
        treasury: Address,
    ) -> Result<(), AgentRegistryError>;

    /// Rotate the operator key. Requires the current admin's authorization.
    fn set_admin(env: Env, new_admin: Address) -> Result<(), AgentRegistryError>;

    /// Redirect slashed funds. Requires admin authorization.
    fn set_treasury(env: Env, treasury: Address) -> Result<(), AgentRegistryError>;

    /* ---------------- region configuration ---------------- */

    /// Configure a new operating region. `max_agents = 0` means uncapped.
    fn add_region(
        env: Env,
        region_id: Symbol,
        min_bond: i128,
        max_agents: u32,
    ) -> Result<(), AgentRegistryError>;

    /// Update the minimum bond for future registrations in a region.
    fn set_min_bond(env: Env, region_id: Symbol, min_bond: i128) -> Result<(), AgentRegistryError>;

    /// Switch a region on or off. Existing agents keep their status but stop
    /// being able to settle while the region is inactive.
    fn set_region_active(env: Env, region_id: Symbol, active: bool)
        -> Result<(), AgentRegistryError>;

    /// Map a corridor symbol (as used by the escrow) to a region.
    fn map_corridor(
        env: Env,
        corridor_id: Symbol,
        region_id: Symbol,
    ) -> Result<(), AgentRegistryError>;

    /* ---------------- agent lifecycle ---------------- */

    /// Post a bond and enter the registry as `Pending`.
    ///
    /// Re-registration is allowed only from `Revoked`, and only by posting a
    /// bond that satisfies the region minimum again — a revoked agent cannot
    /// re-enter on the strength of its old record.
    fn register_agent(
        env: Env,
        agent: Address,
        region_id: Symbol,
        bond_amount: i128,
    ) -> Result<Agent, AgentRegistryError>;

    /// Add collateral. Allowed in any status.
    fn top_up_bond(env: Env, agent: Address, amount: i128) -> Result<i128, AgentRegistryError>;

    /// Withdraw unencumbered collateral. Blocked while the agent is authorized.
    fn withdraw_bond(env: Env, agent: Address, amount: i128) -> Result<i128, AgentRegistryError>;

    /// Approve an agent to settle transfers in its region.
    fn authorize_agent(env: Env, agent: Address) -> Result<(), AgentRegistryError>;

    /// Temporarily block an agent pending investigation.
    fn suspend_agent(env: Env, agent: Address, reason: Symbol)
        -> Result<(), AgentRegistryError>;

    /// Permanently remove an agent.
    fn revoke_agent(env: Env, agent: Address, reason: Symbol) -> Result<(), AgentRegistryError>;

    /// Confiscate part of a bond for confirmed fraud/no-show and pay it to the
    /// treasury. Returns the amount actually recovered.
    fn slash_agent(
        env: Env,
        agent: Address,
        amount: i128,
        reason: Symbol,
    ) -> Result<i128, AgentRegistryError>;

    /* ---------------- read model ---------------- */

    /// Whether `agent` may currently settle transfers in `region_id`.
    fn is_authorized(env: Env, agent: Address, region_id: Symbol) -> bool;

    /// Convenience read used by the escrow: resolves `corridor_id` to a region
    /// and reports whether the agent is authorized there.
    fn is_authorized_for_corridor(env: Env, agent: Address, corridor_id: Symbol) -> bool;

    fn get_agent(env: Env, agent: Address) -> Option<Agent>;

    /// Current bond for an agent; `0` when the agent is unknown.
    fn get_bond(env: Env, agent: Address) -> i128;

    fn get_region(env: Env, region_id: Symbol) -> Option<RegionConfig>;

    fn list_regions(env: Env) -> Vec<Symbol>;

    fn list_region_agents(env: Env, region_id: Symbol) -> Vec<Address>;

    /// Total agents registered in a region (any status). The dashboard renders
    /// this next to the authorized count to spot regions that are falling
    /// behind on operator review.
    fn region_agent_count(env: Env, region_id: Symbol) -> u32;

    fn registry_stats(env: Env) -> RegistryStats;
}

/// The on-chain agent registry contract.
///
/// Cross-contract callers use the generated `AgentRegistryClient`:
///
/// ```ignore
/// let client = AgentRegistryClient::new(&env, &registry_id);
/// let ok = client.is_authorized_for_corridor(&agent, &corridor_id);
/// ```
#[contract]
pub struct AgentRegistry;
