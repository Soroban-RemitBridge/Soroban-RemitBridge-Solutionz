//! Agent registry interface: types, error taxonomy and the generated client.

use soroban_sdk::{
    contractclient, contracterror, contracttype, Address, Env, Symbol, Vec,
};

/* ------------------------------------------------------------------ */
/* types                                                               */
/* ------------------------------------------------------------------ */

/// Lifecycle state of a cash-out agent.
///
/// Only [`AgentStatus::Authorized`] agents are allowed to claim escrowed
/// transfers. The registry deliberately separates "has posted a bond"
/// (`Pending`) from "is allowed to move money" (`Authorized`) so that a bond
/// alone never grants the right to settle a transfer.
#[contracttype]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum AgentStatus {
    /// Bond posted on-chain, awaiting anchor-operator approval.
    Pending,
    /// Approved: may claim and settle transfers in its assigned region.
    Authorized,
    /// Temporarily blocked while an incident is investigated.
    Suspended,
    /// Permanently removed. The remaining bond stays claimable by the agent.
    Revoked,
}

impl AgentStatus {
    /// Whether an agent in this state may settle transfers.
    pub fn can_settle(self) -> bool {
        matches!(self, AgentStatus::Authorized)
    }

    /// Whether the agent may withdraw its remaining bond.
    pub fn bond_is_withdrawable(self) -> bool {
        !matches!(self, AgentStatus::Authorized)
    }
}

/// An agent's on-chain record.
///
/// **No PII lives here.** `address` is the agent's Stellar account (or the
/// settlement address an operator controls), and everything else is either a
/// numeric bond, an operator-chosen region tag, or a timestamp. Business name,
/// licence numbers and KYC documents are held off-chain and referenced only by
/// hash from the compliance hook.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Agent {
    pub address: Address,
    pub region_id: Symbol,
    /// Token the bond is denominated in; recorded so a later token swap cannot
    /// strand or silently revalue an existing bond.
    pub bond_token: Address,
    pub bond: i128,
    pub status: AgentStatus,
    /// Number of successful slashes; used by the dashboard to prioritise review.
    pub slash_count: u32,
    pub registered_at: u64,
    pub updated_at: u64,
}

/// Per-region operating envelope configured by the anchor operator.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RegionConfig {
    pub region_id: Symbol,
    /// Minimum bond required to register. Raising it never retroactively
    /// evicts agents; it only gates new registrations.
    pub min_bond: i128,
    /// Hard cap on authorized agents in the region. `0` means uncapped.
    pub max_agents: u32,
    pub active: bool,
}

impl RegionConfig {
    /// Whether a candidate bond satisfies this region's minimum.
    pub fn accepts_bond(&self, bond: i128) -> bool {
        bond >= self.min_bond
    }
}

/// Aggregate counters for the operator dashboard.
///
/// These are maintained on write rather than derived on read so the indexer and
/// admin UI can render network health without paging every agent record.
#[contracttype]
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct RegistryStats {
    pub total_agents: u32,
    pub authorized_agents: u32,
    pub total_bonded: i128,
    pub total_slashed: i128,
}

/* ------------------------------------------------------------------ */
/* errors                                                              */
/* ------------------------------------------------------------------ */

/// Every failure mode of `AgentRegistry`.
///
/// The contract never panics for a predictable business failure: each variant
/// is returned as a typed `Result` error so the calling contract
/// (`RemitEscrow`) and off-chain indexers can branch on the exact cause instead
/// of parsing panic strings.
#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum AgentRegistryError {
    /// A read/write happened before `initialize`.
    NotInitialized = 1,
    /// `initialize` was called twice.
    AlreadyInitialized = 2,
    /// Caller is not the configured admin (anchor operator).
    Unauthorized = 3,
    /// Amount was zero or negative.
    InvalidAmount = 4,
    /// Region has not been configured by the operator.
    UnknownRegion = 5,
    /// Region exists but is switched off.
    RegionInactive = 6,
    /// Region already holds `max_agents` authorized agents.
    RegionFull = 7,
    /// Bond posted is below the region minimum.
    BondBelowMinimum = 8,
    /// Agent already has a record in the registry.
    AgentAlreadyRegistered = 9,
    /// No record exists for the given agent.
    AgentNotRegistered = 10,
    /// Agent's bond is too small for the requested operation.
    InsufficientBond = 11,
    /// Bond withdrawal attempted while the agent can still settle transfers.
    BondLockedWhileAuthorized = 12,
    /// Requested lifecycle transition is not permitted.
    InvalidStatusTransition = 13,
    /// Bond was posted in a different token than the configured bond token.
    BondTokenMismatch = 14,
    /// Region already exists.
    RegionAlreadyExists = 15,
    /// Slash amount exceeds the agent's remaining bond.
    SlashExceedsBond = 16,
    /// Corridor has no region mapped to it.
    UnknownCorridor = 17,
    /// Admin address may not be the zero/invalid address.
    InvalidAdmin = 18,
    /// An arithmetic operation would have overflowed `i128`.
    Overflow = 19,
}

/* ------------------------------------------------------------------ */
/* interface                                                           */
/* ------------------------------------------------------------------ */

/// Public interface of the registry.
///
/// `#[contractclient]` generates `AgentRegistryClient` from this trait for
/// cross-contract callers, and the `AgentRegistry` crate implements the very
/// same trait — so a signature change here is a *compile* error on both sides
/// rather than a runtime surprise.
#[contractclient(name = "AgentRegistryClient")]
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
    fn set_region_active(
        env: Env,
        region_id: Symbol,
        active: bool,
    ) -> Result<(), AgentRegistryError>;

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
    fn suspend_agent(env: Env, agent: Address, reason: Symbol) -> Result<(), AgentRegistryError>;

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
