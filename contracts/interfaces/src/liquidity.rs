//! Liquidity pool interface: per-region pool state, errors and the trait.
//!
//! Like the escrow trait, this one carries no `#[contractclient]`: nothing
//! on-chain calls the pool, so there is no Rust client to generate.

use soroban_sdk::{contracterror, contracttype, Address, Env, Symbol, Vec};

/// Per-region pool state.
///
/// Accounting is share-based from day one even though the pool pays no yield
/// yet. When settlement fees are routed here, the share price rises for existing
/// depositors without a migration — whereas a naive "balance == deposit" model
/// would have to be replaced, at which point the first depositors' claims become
/// ambiguous.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PoolState {
    pub region_id: Symbol,
    /// Principal deposited by liquidity providers, net of withdrawals.
    pub total_deposited: i128,
    /// Float currently drawn by agents.
    pub total_drawn: i128,
    pub total_shares: i128,
    pub depositor_count: u32,
    /// Ceiling on `total_drawn / total_deposited`, in basis points. This is the
    /// depositors' protection: it guarantees a reserve stays available so a
    /// sudden recall of agent float cannot strand withdrawals.
    pub utilization_cap_bps: u32,
    pub active: bool,
    pub updated_at: u64,
}

impl PoolState {
    /// Float depositors can still take out right now.
    pub fn available(&self) -> i128 {
        self.total_deposited - self.total_drawn
    }

    /// Current utilization in basis points; `0` for an empty pool.
    pub fn utilization_bps(&self) -> u32 {
        if self.total_deposited <= 0 {
            return 0;
        }
        let drawn = self.total_drawn.max(0);
        // Both operands are well inside `i128`, so `u32` cannot lose precision
        // here for any pool this contract can actually hold.
        u32::try_from(drawn * 10_000 / self.total_deposited).unwrap_or(u32::MAX)
    }
}

/// Read-only health snapshot for the operator dashboard and agent app.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PoolStats {
    pub region_id: Symbol,
    pub total_deposited: i128,
    pub total_drawn: i128,
    pub available: i128,
    pub utilization_bps: u32,
    pub utilization_cap_bps: u32,
    pub depositor_count: u32,
    pub active: bool,
}

/// Contract-wide configuration.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PoolConfig {
    pub agent_registry: Address,
    /// The stablecoin agents draw. One token per pool keeps the bond-sufficiency
    /// comparison (registry bond vs pool draw) a like-for-like number.
    pub token: Address,
    /// Bond required per unit of outstanding draw, in basis points — 15_000
    /// means an agent must hold 150% of its draw as bonded collateral.
    pub collateral_ratio_bps: u32,
    /// Utilization cap applied to newly opened regions.
    pub default_utilization_cap_bps: u32,
    pub paused: bool,
}

/// Aggregate counters for the dashboard.
#[contracttype]
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct LiquidityStats {
    pub regions_opened: u32,
    pub total_deposits: u32,
    pub total_withdrawals: u32,
    pub total_draws: u32,
}

// Note: there is no `rejected_draws` counter, and that is not an oversight.
// A refused draw returns a typed error, which reverts the whole invocation, and
// Soroban discards state writes from reverted invocations — so a counter here
// could only ever read zero. Refusals are counted off-chain by the backend,
// which observes the typed error, and the dashboard gets its
// collateral-versus-utilization breakdown from `required_bond_for`, which is a
// pure read and therefore callable on the failing path.

/* ------------------------------------------------------------------ */
/* errors                                                              */
/* ------------------------------------------------------------------ */

/// Failure modes of the liquidity pool.
///
/// `InsufficientCollateral` and `UtilizationCapExceeded` are kept apart on
/// purpose: the first tells an agent to top up its bond, the second tells it that
/// the region as a whole is out of float and no amount of bonding will help.
/// Collapsing them would send agents to the wrong remedy.
#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum LiquidityError {
    NotInitialized = 1,
    AlreadyInitialized = 2,
    /// Caller is not the anchor operator key.
    Unauthorized = 3,
    /// The pool is paused contract-wide.
    Paused = 4,
    /// Amount was zero or negative.
    InvalidAmount = 5,
    /// Region has no pool.
    UnknownRegion = 6,
    /// Region exists but is switched off.
    RegionInactive = 7,
    /// Region already has a pool.
    RegionAlreadyOpen = 8,
    /// Agent is not authorized in the region it is drawing against.
    AgentNotAuthorized = 9,
    /// Agent's registry bond does not cover the requested draw at the configured
    /// collateral ratio.
    InsufficientCollateral = 10,
    /// The draw would push regional utilization past its cap.
    UtilizationCapExceeded = 11,
    /// The pool does not hold enough undrawn float.
    InsufficientLiquidity = 12,
    /// Withdrawal exceeds the caller's share balance.
    InsufficientShares = 13,
    /// Repayment exceeds the agent's outstanding draw.
    RepaymentExceedsExposure = 14,
    /// Nothing to withdraw, or a zero-share position.
    ZeroShares = 15,
    /// A rejected configuration value.
    InvalidConfig = 16,
    /// The agent registry could not be reached or returned an error.
    RegistryCallFailed = 17,
    /// Arithmetic overflowed `i128`.
    Overflow = 18,
}

/* ------------------------------------------------------------------ */
/* interface                                                           */
/* ------------------------------------------------------------------ */

/// Public interface of the regional liquidity pool.
pub trait LiquidityPoolInterface {
    /* ---------------- lifecycle ---------------- */

    /// One-time setup. `collateral_ratio_bps` is the bond-to-draw requirement
    /// (15_000 = 150%); `default_utilization_cap_bps` is applied to regions
    /// opened later.
    fn initialize(
        env: Env,
        admin: Address,
        agent_registry: Address,
        token: Address,
        collateral_ratio_bps: u32,
        default_utilization_cap_bps: u32,
    ) -> Result<(), LiquidityError>;

    fn set_admin(env: Env, new_admin: Address) -> Result<(), LiquidityError>;

    /// Re-point the registry used for bond-sufficiency checks. Doubles as an
    /// incident-response control.
    fn set_agent_registry(env: Env, agent_registry: Address) -> Result<(), LiquidityError>;

    fn set_collateral_ratio(env: Env, collateral_ratio_bps: u32) -> Result<(), LiquidityError>;

    fn set_default_utilization_cap(env: Env, bps: u32) -> Result<(), LiquidityError>;

    fn set_utilization_cap(env: Env, region_id: Symbol, bps: u32) -> Result<(), LiquidityError>;

    fn set_region_active(env: Env, region_id: Symbol, active: bool) -> Result<(), LiquidityError>;

    /// Pause deposits, withdrawals and draws. Repayments keep working, so agents
    /// can always unwind exposure during an incident.
    fn set_paused(env: Env, paused: bool) -> Result<(), LiquidityError>;

    fn open_region(env: Env, region_id: Symbol, utilization_cap_bps: u32)
        -> Result<(), LiquidityError>;

    /* ---------------- liquidity providers ---------------- */

    /// Deposit float into a region's pool and receive shares at the current
    /// share price.
    fn deposit_liquidity(
        env: Env,
        provider: Address,
        region_id: Symbol,
        amount: i128,
    ) -> Result<i128, LiquidityError>;

    /// Redeem shares for the underlying float. Limited to the undrawn balance,
    /// which is the whole point of the utilization cap.
    fn withdraw_liquidity(
        env: Env,
        provider: Address,
        region_id: Symbol,
        shares: i128,
    ) -> Result<i128, LiquidityError>;

    /* ---------------- agents ---------------- */

    /// Draw float against the agent's registry bond.
    ///
    /// Checks, in order: region live, agent authorized in that region, pool has
    /// the float, the draw stays inside the utilization cap, and the agent's
    /// bond still covers its total exposure at the configured collateral ratio.
    fn draw_liquidity(
        env: Env,
        agent: Address,
        region_id: Symbol,
        amount: i128,
    ) -> Result<i128, LiquidityError>;

    /// Return drawn float, typically from settled remittance volume.
    fn repay_liquidity(
        env: Env,
        agent: Address,
        region_id: Symbol,
        amount: i128,
    ) -> Result<i128, LiquidityError>;

    /* ---------------- read model ---------------- */

    fn get_pool_health(env: Env, region_id: Symbol) -> Option<PoolStats>;

    fn pool_state(env: Env, region_id: Symbol) -> Option<PoolState>;

    fn list_pool_regions(env: Env) -> Vec<Symbol>;

    /// Outstanding float drawn by an agent in a region.
    fn agent_exposure(env: Env, agent: Address, region_id: Symbol) -> i128;

    fn share_balance(env: Env, provider: Address, region_id: Symbol) -> i128;

    /// Bond an agent would need to draw `additional` more in a region, so the
    /// agent app can prompt for a top-up before the draw fails.
    fn required_bond_for(
        env: Env,
        agent: Address,
        region_id: Symbol,
        additional: i128,
    ) -> i128;

    fn pool_config(env: Env) -> Option<PoolConfig>;

    fn liquidity_stats(env: Env) -> LiquidityStats;
}
