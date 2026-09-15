//! Liquidity pool test suite.
//!
//! The two ratios are the subject of most of these tests, because they are what
//! stand between an agent's cash drawer and a depositor's capital: the collateral
//! ratio protects the network, the utilization cap protects depositors, and both
//! have to hold against an agent that draws repeatedly rather than once.

use soroban_sdk::{
    symbol_short,
    testutils::{Address as _, Ledger as _},
    token::{Client as TokenClient, StellarAssetClient},
    Address, Env, Symbol,
};

use agent_registry::AgentRegistryClient;

use remit_interfaces::liquidity::LiquidityError;

use crate::{LiquidityPool, LiquidityPoolClient};

fn region() -> Symbol {
    symbol_short!("NG_LAG")
}

/// 150% bond-to-draw requirement.
const COLLATERAL_BPS: u32 = 15_000;
/// 80% draw-to-deposit ceiling.
const UTILIZATION_BPS: u32 = 8_000;

struct Fixture {
    env: Env,
    pool: LiquidityPoolClient<'static>,
    registry: AgentRegistryClient<'static>,
    admin: Address,
    token: Address,
    pool_id: Address,
}

fn setup() -> Fixture {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_timestamp(1_000_000);

    let admin = Address::generate(&env);
    let token = env
        .register_stellar_asset_contract_v2(admin.clone())
        .address();

    let registry_id = env.register(agent_registry::AgentRegistry, ());
    let registry = AgentRegistryClient::new(&env, &registry_id);
    registry.initialize(&admin, &token, &admin);
    registry.add_region(&region(), &100, &0);

    let pool_id = env.register(LiquidityPool, ());
    let pool = LiquidityPoolClient::new(&env, &pool_id);
    pool.initialize(
        &admin,
        &registry_id,
        &token,
        &COLLATERAL_BPS,
        &UTILIZATION_BPS,
    );
    pool.open_region(&region(), &0);

    Fixture {
        env,
        pool,
        registry,
        admin,
        token,
        pool_id,
    }
}

fn fund(f: &Fixture, who: &Address, amount: i128) {
    StellarAssetClient::new(&f.env, &f.token).mint(who, &amount);
}

fn balance(f: &Fixture, who: &Address) -> i128 {
    TokenClient::new(&f.env, &f.token).balance(who)
}

/// Onboard an agent with `bond` of bonded collateral and authorize it.
fn agent_with_bond(f: &Fixture, bond: i128) -> Address {
    let agent = Address::generate(&f.env);
    fund(f, &agent, bond);
    f.registry.register_agent(&agent, &region(), &bond);
    f.registry.authorize_agent(&agent);
    agent
}

/// A liquidity provider that deposits `amount` into the region's pool.
fn provider_with_deposit(f: &Fixture, amount: i128) -> Address {
    let provider = Address::generate(&f.env);
    fund(f, &provider, amount);
    f.pool.deposit_liquidity(&provider, &region(), &amount);
    provider
}

/* ------------------------------------------------------------------ */
/* configuration                                                       */
/* ------------------------------------------------------------------ */

#[test]
fn initialize_is_not_repeatable() {
    let f = setup();
    let outcome = f.pool.try_initialize(
        &f.admin,
        &f.pool_id,
        &f.token,
        &COLLATERAL_BPS,
        &UTILIZATION_BPS,
    );
    assert_eq!(outcome, Err(Ok(LiquidityError::AlreadyInitialized)));
}

#[test]
fn a_zero_or_absurd_collateral_ratio_is_rejected() {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let id = env.register(LiquidityPool, ());
    let pool = LiquidityPoolClient::new(&env, &id);

    // Zero would let an unbonded agent drain the pool.
    assert_eq!(
        pool.try_initialize(&admin, &id, &id, &0, &UTILIZATION_BPS),
        Err(Ok(LiquidityError::InvalidConfig))
    );
    assert_eq!(
        pool.try_initialize(&admin, &id, &id, &(100_000 + 1), &UTILIZATION_BPS),
        Err(Ok(LiquidityError::InvalidConfig))
    );
    assert_eq!(
        pool.try_initialize(&admin, &id, &id, &COLLATERAL_BPS, &0),
        Err(Ok(LiquidityError::InvalidConfig))
    );
}

#[test]
fn ratios_can_be_tuned_within_bounds() {
    let f = setup();
    assert_eq!(
        f.pool.try_set_collateral_ratio(&9_999),
        Err(Ok(LiquidityError::InvalidConfig))
    );
    f.pool.set_collateral_ratio(&20_000);
    assert_eq!(f.pool.pool_config().unwrap().collateral_ratio_bps, 20_000);

    assert_eq!(
        f.pool.try_set_utilization_cap(&region(), &9_501),
        Err(Ok(LiquidityError::InvalidConfig))
    );
    f.pool.set_utilization_cap(&region(), &5_000);
    assert_eq!(
        f.pool
            .get_pool_health(&region())
            .unwrap()
            .utilization_cap_bps,
        5_000
    );
}

#[test]
fn a_region_can_only_be_opened_once() {
    let f = setup();
    assert_eq!(
        f.pool.try_open_region(&region(), &0),
        Err(Ok(LiquidityError::RegionAlreadyOpen))
    );
    assert_eq!(f.pool.list_pool_regions().len(), 1);
    assert_eq!(f.pool.liquidity_stats().regions_opened, 1);
}

#[test]
fn opening_a_region_without_a_cap_uses_the_default() {
    let f = setup();
    let other = symbol_short!("KE_NBO");
    f.pool.open_region(&other, &0);
    assert_eq!(
        f.pool.get_pool_health(&other).unwrap().utilization_cap_bps,
        UTILIZATION_BPS
    );
}

#[test]
fn unknown_regions_are_reported_rather_than_defaulted() {
    let f = setup();
    let missing = symbol_short!("ZZ_ZZZ");
    assert!(f.pool.get_pool_health(&missing).is_none());
    assert_eq!(
        f.pool.try_set_utilization_cap(&missing, &5_000),
        Err(Ok(LiquidityError::UnknownRegion))
    );

    let provider = Address::generate(&f.env);
    fund(&f, &provider, 100);
    assert_eq!(
        f.pool.try_deposit_liquidity(&provider, &missing, &100),
        Err(Ok(LiquidityError::UnknownRegion))
    );
}

/* ------------------------------------------------------------------ */
/* deposits and shares                                                 */
/* ------------------------------------------------------------------ */

#[test]
fn the_first_deposit_sets_the_share_price_at_one() {
    let f = setup();
    let provider = provider_with_deposit(&f, 1_000);

    assert_eq!(f.pool.share_balance(&provider, &region()), 1_000);
    assert_eq!(balance(&f, &provider), 0);
    assert_eq!(balance(&f, &f.pool_id), 1_000);

    let health = f.pool.get_pool_health(&region()).unwrap();
    assert_eq!(health.total_deposited, 1_000);
    assert_eq!(health.total_drawn, 0);
    assert_eq!(health.available, 1_000);
    assert_eq!(health.utilization_bps, 0);
    assert_eq!(health.depositor_count, 1);
}

#[test]
fn additional_deposits_from_the_same_provider_accumulate_shares() {
    let f = setup();
    let provider = provider_with_deposit(&f, 1_000);

    fund(&f, &provider, 500);
    f.pool.deposit_liquidity(&provider, &region(), &500);

    assert_eq!(f.pool.share_balance(&provider, &region()), 1_500);
    // Still one depositor: the counter tracks distinct providers, not deposits.
    assert_eq!(
        f.pool.get_pool_health(&region()).unwrap().depositor_count,
        1
    );
    assert_eq!(f.pool.liquidity_stats().total_deposits, 2);
}

#[test]
fn non_positive_deposits_are_rejected() {
    let f = setup();
    let provider = Address::generate(&f.env);
    assert_eq!(
        f.pool.try_deposit_liquidity(&provider, &region(), &0),
        Err(Ok(LiquidityError::InvalidAmount))
    );
}

#[test]
fn withdrawing_more_shares_than_held_is_rejected() {
    let f = setup();
    let provider = provider_with_deposit(&f, 1_000);

    assert_eq!(
        f.pool.try_withdraw_liquidity(&provider, &region(), &1_001),
        Err(Ok(LiquidityError::InsufficientShares))
    );
    assert!(f
        .pool
        .try_withdraw_liquidity(&provider, &region(), &0)
        .is_err());
}

#[test]
fn a_provider_can_redeem_shares_for_float() {
    let f = setup();
    let provider = provider_with_deposit(&f, 1_000);

    let received = f.pool.withdraw_liquidity(&provider, &region(), &400);

    assert_eq!(received, 400);
    assert_eq!(balance(&f, &provider), 400);
    assert_eq!(f.pool.share_balance(&provider, &region()), 600);
    assert_eq!(
        f.pool.get_pool_health(&region()).unwrap().total_deposited,
        600
    );
}

#[test]
fn withdrawals_cannot_dip_into_float_agents_are_holding() {
    let f = setup();
    let agent = agent_with_bond(&f, 10_000);
    let provider = provider_with_deposit(&f, 1_000);

    // 80% cap on a 1_000 pool: the agent draws 800, leaving 200 undrawn.
    f.pool.draw_liquidity(&agent, &region(), &800);

    // Redeeming the full position would need to claw back cash that is already
    // in an agent's till.
    assert_eq!(
        f.pool.try_withdraw_liquidity(&provider, &region(), &1_000),
        Err(Ok(LiquidityError::InsufficientLiquidity))
    );

    // Undrawn float is still available.
    let received = f.pool.withdraw_liquidity(&provider, &region(), &200);
    assert_eq!(received, 200);
}

/* ------------------------------------------------------------------ */
/* agent draws                                                         */
/* ------------------------------------------------------------------ */

#[test]
fn only_authorized_agents_may_draw() {
    let f = setup();
    provider_with_deposit(&f, 10_000);

    // Bonded but never approved by the operator.
    let pending = Address::generate(&f.env);
    fund(&f, &pending, 5_000);
    f.registry.register_agent(&pending, &region(), &5_000);
    assert_eq!(
        f.pool.try_draw_liquidity(&pending, &region(), &100),
        Err(Ok(LiquidityError::AgentNotAuthorized))
    );

    // Not registered at all.
    let stranger = Address::generate(&f.env);
    assert_eq!(
        f.pool.try_draw_liquidity(&stranger, &region(), &100),
        Err(Ok(LiquidityError::AgentNotAuthorized))
    );
    assert_eq!(balance(&f, &stranger), 0);
}

#[test]
fn a_draw_within_the_collateral_ratio_succeeds() {
    let f = setup();
    // 1_500 bonded at 150% covers exactly 1_000 of exposure.
    let agent = agent_with_bond(&f, 1_500);
    provider_with_deposit(&f, 5_000);

    let exposure = f.pool.draw_liquidity(&agent, &region(), &1_000);

    assert_eq!(exposure, 1_000);
    assert_eq!(balance(&f, &agent), 1_000);
    assert_eq!(f.pool.agent_exposure(&agent, &region()), 1_000);

    let health = f.pool.get_pool_health(&region()).unwrap();
    assert_eq!(health.total_drawn, 1_000);
    assert_eq!(health.available, 4_000);
    assert_eq!(health.utilization_bps, 2_000);
}

#[test]
fn a_draw_beyond_the_collateral_ratio_is_refused() {
    let f = setup();
    let agent = agent_with_bond(&f, 1_500);
    provider_with_deposit(&f, 5_000);

    // 1_500 of bond at 150% covers 1_000; 1_001 does not.
    assert_eq!(
        f.pool.try_draw_liquidity(&agent, &region(), &1_001),
        Err(Ok(LiquidityError::InsufficientCollateral))
    );
    assert_eq!(balance(&f, &agent), 0);
    assert_eq!(f.pool.get_pool_health(&region()).unwrap().total_drawn, 0);
}

#[test]
fn repeated_small_draws_cannot_escape_the_collateral_ratio() {
    let f = setup();
    let agent = agent_with_bond(&f, 1_500);
    provider_with_deposit(&f, 5_000);

    // Ten 100 draws are each individually fine and collectively fine (1_000),
    // then the eleventh must fail: the check uses total exposure, not the
    // increment, so there is nothing to gain by going in small pieces.
    for _ in 0..10 {
        f.pool.draw_liquidity(&agent, &region(), &100);
    }
    assert_eq!(f.pool.agent_exposure(&agent, &region()), 1_000);
    assert_eq!(
        f.pool.try_draw_liquidity(&agent, &region(), &100),
        Err(Ok(LiquidityError::InsufficientCollateral))
    );
}

#[test]
fn the_utilization_cap_binds_before_the_balance_runs_out() {
    let f = setup();
    // Bond is deliberately generous, so the cap is the only binding constraint.
    let agent = agent_with_bond(&f, 100_000);
    provider_with_deposit(&f, 1_000);

    // 80% of 1_000 is 800; 801 is refused even though 1_000 sits in the pool.
    assert_eq!(
        f.pool.try_draw_liquidity(&agent, &region(), &801),
        Err(Ok(LiquidityError::UtilizationCapExceeded))
    );
    assert_eq!(f.pool.draw_liquidity(&agent, &region(), &800), 800);

    let health = f.pool.get_pool_health(&region()).unwrap();
    assert_eq!(health.utilization_bps, 8_000);
    assert_eq!(health.available, 200);
}

#[test]
fn a_draw_larger_than_the_pool_is_reported_as_illiquidity() {
    let f = setup();
    let agent = agent_with_bond(&f, 100_000);
    provider_with_deposit(&f, 1_000);

    assert_eq!(
        f.pool.try_draw_liquidity(&agent, &region(), &900),
        Err(Ok(LiquidityError::UtilizationCapExceeded))
    );

    // Corridor with only 100 deposited: even the whole pool is under the cap.
    let small = symbol_short!("SMALL");
    f.pool.open_region(&small, &0);
    let agent2 = Address::generate(&f.env);
    fund(&f, &agent2, 10_000);
    f.registry.add_region(&small, &100, &0);
    f.registry.register_agent(&agent2, &small, &10_000);
    f.registry.authorize_agent(&agent2);
    let p2 = Address::generate(&f.env);
    fund(&f, &p2, 100);
    f.pool.deposit_liquidity(&p2, &small, &100);

    assert_eq!(
        f.pool.try_draw_liquidity(&agent2, &small, &200),
        Err(Ok(LiquidityError::InsufficientLiquidity))
    );
}

#[test]
fn non_positive_draws_are_rejected() {
    let f = setup();
    let agent = agent_with_bond(&f, 1_500);
    provider_with_deposit(&f, 1_000);
    assert_eq!(
        f.pool.try_draw_liquidity(&agent, &region(), &0),
        Err(Ok(LiquidityError::InvalidAmount))
    );
}

/* ------------------------------------------------------------------ */
/* repayment                                                           */
/* ------------------------------------------------------------------ */

#[test]
fn repaying_reduces_exposure_and_frees_utilization() {
    let f = setup();
    let agent = agent_with_bond(&f, 10_000);
    provider_with_deposit(&f, 1_000);

    f.pool.draw_liquidity(&agent, &region(), &800);
    let remaining = f.pool.repay_liquidity(&agent, &region(), &300);

    assert_eq!(remaining, 500);
    // 1_000 deposited, 800 out with the agent, 300 back in.
    assert_eq!(balance(&f, &f.pool_id), 500);
    let health = f.pool.get_pool_health(&region()).unwrap();
    assert_eq!(health.total_drawn, 500);
    assert_eq!(health.utilization_bps, 5_000);
}

#[test]
fn an_agent_cannot_repay_more_than_it_owes() {
    let f = setup();
    let agent = agent_with_bond(&f, 10_000);
    provider_with_deposit(&f, 1_000);
    f.pool.draw_liquidity(&agent, &region(), &500);

    assert_eq!(
        f.pool.try_repay_liquidity(&agent, &region(), &501),
        Err(Ok(LiquidityError::RepaymentExceedsExposure))
    );
}

#[test]
fn repayments_stay_open_while_the_pool_is_paused() {
    let f = setup();
    let agent = agent_with_bond(&f, 10_000);
    provider_with_deposit(&f, 1_000);
    f.pool.draw_liquidity(&agent, &region(), &500);

    f.pool.set_paused(&true);

    // Deposits and draws stop...
    let provider = Address::generate(&f.env);
    fund(&f, &provider, 100);
    assert_eq!(
        f.pool.try_deposit_liquidity(&provider, &region(), &100),
        Err(Ok(LiquidityError::Paused))
    );
    assert_eq!(
        f.pool.try_draw_liquidity(&agent, &region(), &100),
        Err(Ok(LiquidityError::Paused))
    );
    assert_eq!(
        f.pool.try_withdraw_liquidity(&provider, &region(), &100),
        Err(Ok(LiquidityError::Paused))
    );

    // ...but an agent can always unwind. A pause that trapped debt would hand
    // the operator a lever it should not have.
    assert_eq!(f.pool.repay_liquidity(&agent, &region(), &500), 0);
}

#[test]
fn a_deactivated_region_stops_new_business_only() {
    let f = setup();
    let agent = agent_with_bond(&f, 10_000);
    let provider = provider_with_deposit(&f, 1_000);
    f.pool.draw_liquidity(&agent, &region(), &500);

    f.pool.set_region_active(&region(), &false);

    let newcomer = Address::generate(&f.env);
    fund(&f, &newcomer, 100);
    assert_eq!(
        f.pool.try_deposit_liquidity(&newcomer, &region(), &100),
        Err(Ok(LiquidityError::RegionInactive))
    );
    assert_eq!(
        f.pool.try_draw_liquidity(&agent, &region(), &100),
        Err(Ok(LiquidityError::RegionInactive))
    );

    // Existing exposure can still be repaid, and the region can be reopened.
    assert_eq!(f.pool.repay_liquidity(&agent, &region(), &500), 0);
    assert_eq!(f.pool.share_balance(&provider, &region()), 1_000);
    f.pool.set_region_active(&region(), &true);
    assert!(f.pool.get_pool_health(&region()).unwrap().active);
}

/* ------------------------------------------------------------------ */
/* read model                                                          */
/* ------------------------------------------------------------------ */

#[test]
fn required_bond_for_explains_a_refused_draw() {
    let f = setup();
    let agent = agent_with_bond(&f, 1_500);
    provider_with_deposit(&f, 5_000);

    // 150% of 1_000 is 1_500 — exactly the bond held.
    assert_eq!(f.pool.required_bond_for(&agent, &region(), &1_000), 1_500);
    // 150% of 1_001 is 1_501.5, rounded down in the agent's favour.
    assert_eq!(f.pool.required_bond_for(&agent, &region(), &1_001), 1_501);

    f.pool.draw_liquidity(&agent, &region(), &1_000);
    // Now the same question accounts for existing exposure.
    assert_eq!(f.pool.required_bond_for(&agent, &region(), &100), 1_650);
    assert_eq!(f.pool.required_bond_for(&agent, &region(), &0), 0);
}

#[test]
fn an_unreachable_registry_fails_draws_closed() {
    let f = setup();
    let agent = agent_with_bond(&f, 10_000);
    provider_with_deposit(&f, 1_000);

    f.pool.set_agent_registry(&Address::generate(&f.env));

    assert_eq!(
        f.pool.try_draw_liquidity(&agent, &region(), &100),
        Err(Ok(LiquidityError::RegistryCallFailed))
    );
    // Fail closed means no float left the pool.
    assert_eq!(balance(&f, &f.pool_id), 1_000);
}

#[test]
fn reads_are_safe_for_addresses_with_no_history() {
    let f = setup();
    let nobody = Address::generate(&f.env);
    assert_eq!(f.pool.agent_exposure(&nobody, &region()), 0);
    assert_eq!(f.pool.share_balance(&nobody, &region()), 0);
    assert_eq!(f.pool.required_bond_for(&nobody, &region(), &100), 150);
    assert!(f.pool.pool_config().is_some());
}

#[test]
fn stats_track_the_lifecycle() {
    let f = setup();
    let agent = agent_with_bond(&f, 10_000);
    let provider = provider_with_deposit(&f, 1_000);

    f.pool.draw_liquidity(&agent, &region(), &500);
    f.pool.repay_liquidity(&agent, &region(), &500);
    f.pool.withdraw_liquidity(&provider, &region(), &1_000);

    let stats = f.pool.liquidity_stats();
    assert_eq!(stats.regions_opened, 1);
    assert_eq!(stats.total_deposits, 1);
    assert_eq!(stats.total_withdrawals, 1);
    assert_eq!(stats.total_draws, 1);
}

#[test]
fn rotating_the_operator_key_hands_over_control() {
    let f = setup();
    let next = Address::generate(&f.env);
    f.pool.set_admin(&next);
    f.pool.set_collateral_ratio(&20_000);
    assert_eq!(f.pool.pool_config().unwrap().collateral_ratio_bps, 20_000);
}
