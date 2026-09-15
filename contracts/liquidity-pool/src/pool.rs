//! Liquidity pool implementation.

use soroban_sdk::{contractimpl, symbol_short, token, Address, Env, Symbol, Vec};

use remit_interfaces::agent_registry::AgentRegistryClient;
use remit_interfaces::liquidity::{
    LiquidityError, LiquidityPoolInterface, LiquidityStats, PoolConfig, PoolState, PoolStats,
};

use crate::events;
use crate::storage;
use crate::{LiquidityPool, LiquidityPoolArgs, LiquidityPoolClient};

/// Sanity bounds on operator-supplied ratios. A zero collateral ratio would let
/// an unbonded agent drain a pool; an enormous one would make the pool unusable.
const MIN_COLLATERAL_RATIO_BPS: u32 = 10_000;
const MAX_COLLATERAL_RATIO_BPS: u32 = 100_000;
const MAX_UTILIZATION_CAP_BPS: u32 = 9_500;

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

fn require_admin(env: &Env) -> Result<Address, LiquidityError> {
    let admin = storage::get_admin(env)?;
    admin.require_auth();
    Ok(admin)
}

fn load_pool(env: &Env, region_id: &Symbol) -> Result<PoolState, LiquidityError> {
    storage::get_pool(env, region_id).ok_or(LiquidityError::UnknownRegion)
}

/// Bond an agent must hold to cover `exposure` at the configured ratio.
fn bond_requirement(env: &Env, exposure: i128) -> Result<i128, LiquidityError> {
    let config = storage::get_config(env)?;
    exposure
        .checked_mul(i128::from(config.collateral_ratio_bps))
        .ok_or(LiquidityError::Overflow)?
        .checked_div(10_000)
        .ok_or(LiquidityError::Overflow)
}

fn check_authorized(
    env: &Env,
    registry: &Address,
    agent: &Address,
    region_id: &Symbol,
) -> Result<(), LiquidityError> {
    let outcome = AgentRegistryClient::new(env, registry).try_is_authorized(agent, region_id);
    match outcome {
        Ok(Ok(true)) => Ok(()),
        Ok(Ok(false)) => Err(LiquidityError::AgentNotAuthorized),
        // Cannot decode the answer, or the registry rejected the call. Either
        // way the bond cannot be proved, so fail closed.
        Ok(Err(_)) | Err(_) => Err(LiquidityError::RegistryCallFailed),
    }
}

fn registry_bond(env: &Env, registry: &Address, agent: &Address) -> Result<i128, LiquidityError> {
    let outcome = AgentRegistryClient::new(env, registry).try_get_bond(agent);
    match outcome {
        Ok(Ok(bond)) => Ok(bond),
        Ok(Err(_)) | Err(_) => Err(LiquidityError::RegistryCallFailed),
    }
}

fn to_stats(state: &PoolState) -> PoolStats {
    PoolStats {
        region_id: state.region_id.clone(),
        total_deposited: state.total_deposited,
        total_drawn: state.total_drawn,
        available: state.available(),
        utilization_bps: state.utilization_bps(),
        utilization_cap_bps: state.utilization_cap_bps,
        depositor_count: state.depositor_count,
        active: state.active,
    }
}

fn validate_ratio(bps: u32) -> Result<(), LiquidityError> {
    if !(MIN_COLLATERAL_RATIO_BPS..=MAX_COLLATERAL_RATIO_BPS).contains(&bps) {
        return Err(LiquidityError::InvalidConfig);
    }
    Ok(())
}

/* ------------------------------------------------------------------ */
/* contract                                                            */
/* ------------------------------------------------------------------ */

#[contractimpl]
impl LiquidityPoolInterface for LiquidityPool {
    fn initialize(
        env: Env,
        admin: Address,
        agent_registry: Address,
        token: Address,
        collateral_ratio_bps: u32,
        default_utilization_cap_bps: u32,
    ) -> Result<(), LiquidityError> {
        if storage::has_admin(&env) {
            return Err(LiquidityError::AlreadyInitialized);
        }
        validate_ratio(collateral_ratio_bps)?;
        if default_utilization_cap_bps == 0 || default_utilization_cap_bps > MAX_UTILIZATION_CAP_BPS
        {
            return Err(LiquidityError::InvalidConfig);
        }
        admin.require_auth();

        storage::set_admin(&env, &admin);
        storage::set_config(
            &env,
            &PoolConfig {
                agent_registry,
                token,
                collateral_ratio_bps,
                default_utilization_cap_bps,
                paused: false,
            },
        );
        storage::set_stats(&env, &LiquidityStats::default());
        storage::bump_instance(&env);
        Ok(())
    }

    fn set_admin(env: Env, new_admin: Address) -> Result<(), LiquidityError> {
        let previous = require_admin(&env)?;
        storage::set_admin(&env, &new_admin);
        storage::bump_instance(&env);
        events::admin_changed(&env, &previous, &new_admin);
        Ok(())
    }

    fn set_agent_registry(env: Env, agent_registry: Address) -> Result<(), LiquidityError> {
        require_admin(&env)?;
        let mut config = storage::get_config(&env)?;
        config.agent_registry = agent_registry.clone();
        storage::set_config(&env, &config);
        storage::bump_instance(&env);
        events::registry_updated(&env, &agent_registry);
        Ok(())
    }

    fn set_collateral_ratio(env: Env, collateral_ratio_bps: u32) -> Result<(), LiquidityError> {
        require_admin(&env)?;
        validate_ratio(collateral_ratio_bps)?;
        let mut config = storage::get_config(&env)?;
        config.collateral_ratio_bps = collateral_ratio_bps;
        storage::set_config(&env, &config);
        storage::bump_instance(&env);
        events::config_updated(
            &env,
            &symbol_short!("collat"),
            collateral_ratio_bps,
            config.paused,
        );
        Ok(())
    }

    fn set_default_utilization_cap(env: Env, bps: u32) -> Result<(), LiquidityError> {
        require_admin(&env)?;
        if bps == 0 || bps > MAX_UTILIZATION_CAP_BPS {
            return Err(LiquidityError::InvalidConfig);
        }
        let mut config = storage::get_config(&env)?;
        config.default_utilization_cap_bps = bps;
        storage::set_config(&env, &config);
        storage::bump_instance(&env);
        events::config_updated(
            &env,
            &symbol_short!("util"),
            config.collateral_ratio_bps,
            config.paused,
        );
        Ok(())
    }

    fn set_utilization_cap(env: Env, region_id: Symbol, bps: u32) -> Result<(), LiquidityError> {
        require_admin(&env)?;
        if bps == 0 || bps > MAX_UTILIZATION_CAP_BPS {
            return Err(LiquidityError::InvalidConfig);
        }
        let mut state = load_pool(&env, &region_id)?;
        state.utilization_cap_bps = bps;
        state.updated_at = env.ledger().timestamp();
        storage::set_pool(&env, &state);
        storage::bump_instance(&env);
        events::region_configured(&env, &region_id, bps, state.active);
        Ok(())
    }

    fn set_region_active(env: Env, region_id: Symbol, active: bool) -> Result<(), LiquidityError> {
        require_admin(&env)?;
        let mut state = load_pool(&env, &region_id)?;
        state.active = active;
        state.updated_at = env.ledger().timestamp();
        storage::set_pool(&env, &state);
        storage::bump_instance(&env);
        events::region_configured(&env, &region_id, state.utilization_cap_bps, active);
        Ok(())
    }

    fn set_paused(env: Env, paused: bool) -> Result<(), LiquidityError> {
        require_admin(&env)?;
        let mut config = storage::get_config(&env)?;
        config.paused = paused;
        storage::set_config(&env, &config);
        storage::bump_instance(&env);
        events::config_updated(
            &env,
            &symbol_short!("paused"),
            config.collateral_ratio_bps,
            paused,
        );
        Ok(())
    }

    fn open_region(
        env: Env,
        region_id: Symbol,
        utilization_cap_bps: u32,
    ) -> Result<(), LiquidityError> {
        require_admin(&env)?;
        if storage::get_pool(&env, &region_id).is_some() {
            return Err(LiquidityError::RegionAlreadyOpen);
        }
        let config = storage::get_config(&env)?;
        let cap = if utilization_cap_bps == 0 {
            config.default_utilization_cap_bps
        } else if utilization_cap_bps > MAX_UTILIZATION_CAP_BPS {
            return Err(LiquidityError::InvalidConfig);
        } else {
            utilization_cap_bps
        };

        storage::set_pool(
            &env,
            &PoolState {
                region_id: region_id.clone(),
                total_deposited: 0,
                total_drawn: 0,
                total_shares: 0,
                depositor_count: 0,
                utilization_cap_bps: cap,
                active: true,
                updated_at: env.ledger().timestamp(),
            },
        );
        storage::push_region(&env, &region_id);

        let mut counters = storage::get_stats(&env);
        counters.regions_opened = counters.regions_opened.saturating_add(1);
        storage::set_stats(&env, &counters);
        storage::bump_instance(&env);

        events::region_configured(&env, &region_id, cap, true);
        Ok(())
    }

    fn deposit_liquidity(
        env: Env,
        provider: Address,
        region_id: Symbol,
        amount: i128,
    ) -> Result<i128, LiquidityError> {
        provider.require_auth();
        if amount <= 0 {
            return Err(LiquidityError::InvalidAmount);
        }
        let config = storage::get_config(&env)?;
        if config.paused {
            return Err(LiquidityError::Paused);
        }

        let mut state = load_pool(&env, &region_id)?;
        if !state.active {
            return Err(LiquidityError::RegionInactive);
        }

        // Share price is `total_deposited / total_shares`. The first deposit
        // sets it at exactly 1, which keeps the arithmetic an integer division
        // rather than a rational and makes the first shares trivially auditable.
        let shares = if state.total_shares <= 0 || state.total_deposited <= 0 {
            amount
        } else {
            amount
                .checked_mul(state.total_shares)
                .ok_or(LiquidityError::Overflow)?
                .checked_div(state.total_deposited)
                .ok_or(LiquidityError::Overflow)?
        };
        if shares <= 0 {
            // Depositing less than one share's worth of float is a rounding loss
            // the depositor would eat silently; refuse it instead.
            return Err(LiquidityError::ZeroShares);
        }

        token::Client::new(&env, &config.token).transfer(
            &provider,
            &env.current_contract_address(),
            &amount,
        );

        let previous_shares = storage::get_shares(&env, &provider, &region_id);
        storage::set_shares(&env, &provider, &region_id, previous_shares + shares);

        state.total_deposited = state
            .total_deposited
            .checked_add(amount)
            .ok_or(LiquidityError::Overflow)?;
        state.total_shares = state
            .total_shares
            .checked_add(shares)
            .ok_or(LiquidityError::Overflow)?;
        if previous_shares == 0 {
            state.depositor_count = state.depositor_count.saturating_add(1);
        }
        state.updated_at = env.ledger().timestamp();
        storage::set_pool(&env, &state);

        let mut counters = storage::get_stats(&env);
        counters.total_deposits = counters.total_deposits.saturating_add(1);
        storage::set_stats(&env, &counters);
        storage::bump_instance(&env);

        events::liquidity_deposited(
            &env,
            &provider,
            &region_id,
            amount,
            shares,
            state.total_deposited,
        );
        Ok(shares)
    }

    fn withdraw_liquidity(
        env: Env,
        provider: Address,
        region_id: Symbol,
        shares: i128,
    ) -> Result<i128, LiquidityError> {
        provider.require_auth();
        if shares <= 0 {
            return Err(LiquidityError::InvalidAmount);
        }
        let config = storage::get_config(&env)?;
        if config.paused {
            return Err(LiquidityError::Paused);
        }

        let mut state = load_pool(&env, &region_id)?;
        let held = storage::get_shares(&env, &provider, &region_id);
        if shares > held {
            return Err(LiquidityError::InsufficientShares);
        }
        if state.total_shares <= 0 {
            return Err(LiquidityError::ZeroShares);
        }

        let amount = shares
            .checked_mul(state.total_deposited)
            .ok_or(LiquidityError::Overflow)?
            .checked_div(state.total_shares)
            .ok_or(LiquidityError::Overflow)?;

        // The utilization cap exists for exactly this moment: an agent's draw is
        // out in the field as cash, and pretending it can be recalled on demand
        // would make the pool a run risk.
        if amount > state.available() {
            return Err(LiquidityError::InsufficientLiquidity);
        }

        token::Client::new(&env, &config.token).transfer(
            &env.current_contract_address(),
            &provider,
            &amount,
        );

        storage::set_shares(&env, &provider, &region_id, held - shares);

        state.total_deposited -= amount;
        state.total_shares -= shares;
        if held - shares == 0 {
            state.depositor_count = state.depositor_count.saturating_sub(1);
        }
        state.updated_at = env.ledger().timestamp();
        storage::set_pool(&env, &state);

        let mut counters = storage::get_stats(&env);
        counters.total_withdrawals = counters.total_withdrawals.saturating_add(1);
        storage::set_stats(&env, &counters);
        storage::bump_instance(&env);

        events::liquidity_withdrawn(
            &env,
            &provider,
            &region_id,
            shares,
            amount,
            state.total_deposited,
        );
        Ok(amount)
    }

    fn draw_liquidity(
        env: Env,
        agent: Address,
        region_id: Symbol,
        amount: i128,
    ) -> Result<i128, LiquidityError> {
        agent.require_auth();
        if amount <= 0 {
            return Err(LiquidityError::InvalidAmount);
        }
        let config = storage::get_config(&env)?;
        if config.paused {
            return Err(LiquidityError::Paused);
        }

        let mut state = load_pool(&env, &region_id)?;
        if !state.active {
            return Err(LiquidityError::RegionInactive);
        }

        // Only agents the operator has authorized in this region may hold float
        // here: an unbonded or revoked agent drawing cash is the exact failure
        // the bond exists to price.
        check_authorized(&env, &config.agent_registry, &agent, &region_id)?;

        if amount > state.available() {
            return Err(LiquidityError::InsufficientLiquidity);
        }

        let drawn_after = state
            .total_drawn
            .checked_add(amount)
            .ok_or(LiquidityError::Overflow)?;
        let utilization_after = if state.total_deposited <= 0 {
            10_000u32
        } else {
            u32::try_from(drawn_after * 10_000 / state.total_deposited).unwrap_or(u32::MAX)
        };
        if utilization_after > state.utilization_cap_bps {
            return Err(LiquidityError::UtilizationCapExceeded);
        }

        // Bond sufficiency is checked against the agent's *total* exposure in the
        // region, not the incremental draw, so an agent cannot escape the ratio
        // by drawing repeatedly in small amounts.
        let exposure_before = storage::get_exposure(&env, &agent, &region_id);
        let exposure_after = exposure_before
            .checked_add(amount)
            .ok_or(LiquidityError::Overflow)?;
        let required = bond_requirement(&env, exposure_after)?;
        let bond = registry_bond(&env, &config.agent_registry, &agent)?;
        if bond < required {
            return Err(LiquidityError::InsufficientCollateral);
        }

        token::Client::new(&env, &config.token).transfer(
            &env.current_contract_address(),
            &agent,
            &amount,
        );

        storage::set_exposure(&env, &agent, &region_id, exposure_after);

        state.total_drawn = drawn_after;
        state.updated_at = env.ledger().timestamp();
        storage::set_pool(&env, &state);

        let mut counters = storage::get_stats(&env);
        counters.total_draws = counters.total_draws.saturating_add(1);
        storage::set_stats(&env, &counters);
        storage::bump_instance(&env);

        events::liquidity_drawn(
            &env,
            &agent,
            &region_id,
            amount,
            exposure_after,
            state.utilization_bps(),
        );
        Ok(exposure_after)
    }

    fn repay_liquidity(
        env: Env,
        agent: Address,
        region_id: Symbol,
        amount: i128,
    ) -> Result<i128, LiquidityError> {
        agent.require_auth();
        if amount <= 0 {
            return Err(LiquidityError::InvalidAmount);
        }

        let config = storage::get_config(&env)?;
        let mut state = load_pool(&env, &region_id)?;

        let exposure = storage::get_exposure(&env, &agent, &region_id);
        if amount > exposure {
            return Err(LiquidityError::RepaymentExceedsExposure);
        }

        // Note the absence of a pause check: repayments stay open even when the
        // pool is paused, so an incident cannot trap agents in debt.
        token::Client::new(&env, &config.token).transfer(
            &agent,
            &env.current_contract_address(),
            &amount,
        );

        let exposure_after = exposure - amount;
        storage::set_exposure(&env, &agent, &region_id, exposure_after);

        state.total_drawn -= amount;
        state.updated_at = env.ledger().timestamp();
        storage::set_pool(&env, &state);
        storage::bump_instance(&env);

        events::liquidity_repaid(&env, &agent, &region_id, amount, exposure_after);
        Ok(exposure_after)
    }

    fn get_pool_health(env: Env, region_id: Symbol) -> Option<PoolStats> {
        storage::get_pool(&env, &region_id).map(|state| to_stats(&state))
    }

    fn pool_state(env: Env, region_id: Symbol) -> Option<PoolState> {
        storage::get_pool(&env, &region_id)
    }

    fn list_pool_regions(env: Env) -> Vec<Symbol> {
        storage::region_list(&env)
    }

    fn agent_exposure(env: Env, agent: Address, region_id: Symbol) -> i128 {
        storage::get_exposure(&env, &agent, &region_id)
    }

    fn share_balance(env: Env, provider: Address, region_id: Symbol) -> i128 {
        storage::get_shares(&env, &provider, &region_id)
    }

    fn required_bond_for(env: Env, agent: Address, region_id: Symbol, additional: i128) -> i128 {
        // Pure and non-failing on purpose: this is the call the agent app makes
        // to explain a refused draw, so it has to work on the failing path.
        if additional <= 0 {
            return 0;
        }
        let exposure = storage::get_exposure(&env, &agent, &region_id);
        bond_requirement(&env, exposure.saturating_add(additional)).unwrap_or(0)
    }

    fn pool_config(env: Env) -> Option<PoolConfig> {
        storage::get_config(&env).ok()
    }

    fn liquidity_stats(env: Env) -> LiquidityStats {
        storage::get_stats(&env)
    }
}
