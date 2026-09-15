//! Test suite for the agent registry.
//!
//! Tests are grouped by the behaviour under scrutiny rather than by function,
//! because the contract's value is in its invariants: an agent that is not
//! allowed to settle must not be able to settle, whichever route it takes to
//! the entry point.
//!
//! Note on symbols: Soroban `Symbol`s only admit `[a-zA-Z0-9_]`, so corridor and
//! region identifiers use underscores rather than the ISO-style dashes.

use soroban_sdk::{
    symbol_short,
    testutils::{Address as _, Ledger as _, MockAuth, MockAuthInvoke},
    token::StellarAssetClient,
    Address, Env, IntoVal, Symbol,
};

use crate::{AgentRegistry, AgentRegistryClient, AgentRegistryError, AgentStatus};

fn region() -> Symbol {
    symbol_short!("NG_LAG")
}

fn corridor() -> Symbol {
    symbol_short!("NGN_LAG")
}

fn other_region() -> Symbol {
    symbol_short!("KE_NBO")
}

struct Fixture {
    env: Env,
    client: AgentRegistryClient<'static>,
    admin: Address,
    treasury: Address,
    token: Address,
}

fn setup() -> Fixture {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let treasury = Address::generate(&env);

    // A real Stellar asset contract stands in for the stablecoin agents bond in,
    // so bond custody is exercised against genuine token balances.
    let token = env
        .register_stellar_asset_contract_v2(admin.clone())
        .address();

    let contract_id = env.register(AgentRegistry, ());
    let client = AgentRegistryClient::new(&env, &contract_id);
    client.initialize(&admin, &token, &treasury);

    Fixture {
        env,
        client,
        admin,
        treasury,
        token,
    }
}

fn fund(f: &Fixture, who: &Address, amount: i128) {
    StellarAssetClient::new(&f.env, &f.token).mint(who, &amount);
}

fn balance(f: &Fixture, who: &Address) -> i128 {
    soroban_sdk::token::Client::new(&f.env, &f.token).balance(who)
}

/// Configure the standard test region and map the test corridor to it.
fn with_region(f: &Fixture, min_bond: i128) {
    f.client.add_region(&region(), &min_bond, &0);
    f.client.map_corridor(&corridor(), &region());
}

/* ------------------------------------------------------------------ */
/* configuration                                                       */
/* ------------------------------------------------------------------ */

#[test]
fn initialize_is_not_repeatable() {
    let f = setup();
    assert_eq!(
        f.client.try_initialize(&f.admin, &f.token, &f.treasury),
        Err(Ok(AgentRegistryError::AlreadyInitialized))
    );
}

#[test]
fn add_region_rejects_duplicates() {
    let f = setup();
    with_region(&f, 100);
    assert_eq!(
        f.client.try_add_region(&region(), &100, &0),
        Err(Ok(AgentRegistryError::RegionAlreadyExists))
    );
    assert_eq!(f.client.list_regions().len(), 1);
}

#[test]
fn add_region_rejects_negative_minimum_bond() {
    let f = setup();
    assert_eq!(
        f.client.try_add_region(&region(), &-1, &0),
        Err(Ok(AgentRegistryError::InvalidAmount))
    );
}

#[test]
fn corridor_mapping_requires_a_known_region() {
    let f = setup();
    assert_eq!(
        f.client.try_map_corridor(&corridor(), &other_region()),
        Err(Ok(AgentRegistryError::UnknownRegion))
    );
}

#[test]
fn admin_only_functions_reject_a_non_admin_signer() {
    let env = Env::default();
    let admin = Address::generate(&env);
    let attacker = Address::generate(&env);
    let token = env
        .register_stellar_asset_contract_v2(admin.clone())
        .address();
    let contract_id = env.register(AgentRegistry, ());
    let client = AgentRegistryClient::new(&env, &contract_id);

    env.mock_auths(&[MockAuth {
        address: &admin,
        invoke: &MockAuthInvoke {
            contract: &contract_id,
            fn_name: "initialize",
            args: (&admin, &token, &admin).into_val(&env),
            sub_invokes: &[],
        },
    }]);
    client.initialize(&admin, &token, &admin);

    // The attacker signs the call, but the contract only accepts the admin's
    // signature, so the authorization tree fails to satisfy `require_auth`.
    env.mock_auths(&[MockAuth {
        address: &attacker,
        invoke: &MockAuthInvoke {
            contract: &contract_id,
            fn_name: "add_region",
            args: (&region(), &1_00i128, &0u32).into_val(&env),
            sub_invokes: &[],
        },
    }]);
    assert!(client.try_add_region(&region(), &100, &0).is_err());
    assert!(client.get_region(&region()).is_none());
}

/* ------------------------------------------------------------------ */
/* registration                                                        */
/* ------------------------------------------------------------------ */

#[test]
fn register_agent_moves_bond_and_starts_pending() {
    let f = setup();
    with_region(&f, 100);

    let agent = Address::generate(&f.env);
    fund(&f, &agent, 1_000);

    let record = f.client.register_agent(&agent, &region(), &500);

    assert_eq!(record.bond, 500);
    assert_eq!(record.status, AgentStatus::Pending);
    assert_eq!(record.slash_count, 0);
    // Bond is custodied by the contract, not left with the agent.
    assert_eq!(balance(&f, &agent), 500);
    assert_eq!(f.client.get_bond(&agent), 500);
    assert_eq!(f.client.region_agent_count(&region()), 1);

    let stats = f.client.registry_stats();
    assert_eq!(stats.total_agents, 1);
    assert_eq!(stats.total_bonded, 500);
}

#[test]
fn register_below_minimum_bond_is_rejected() {
    let f = setup();
    with_region(&f, 1_000);

    let agent = Address::generate(&f.env);
    fund(&f, &agent, 1_000);

    assert_eq!(
        f.client.try_register_agent(&agent, &region(), &999),
        Err(Ok(AgentRegistryError::BondBelowMinimum))
    );
    assert_eq!(f.client.get_bond(&agent), 0);
}

#[test]
fn register_in_unknown_region_is_rejected() {
    let f = setup();
    let agent = Address::generate(&f.env);
    fund(&f, &agent, 100);
    assert_eq!(
        f.client.try_register_agent(&agent, &region(), &100),
        Err(Ok(AgentRegistryError::UnknownRegion))
    );
}

#[test]
fn register_rejects_non_positive_bonds() {
    let f = setup();
    with_region(&f, 10);
    let agent = Address::generate(&f.env);
    assert_eq!(
        f.client.try_register_agent(&agent, &region(), &0),
        Err(Ok(AgentRegistryError::InvalidAmount))
    );
}

#[test]
fn register_twice_before_revocation_is_rejected() {
    let f = setup();
    with_region(&f, 10);
    let agent = Address::generate(&f.env);
    fund(&f, &agent, 1_000);

    f.client.register_agent(&agent, &region(), &100);
    assert_eq!(
        f.client.try_register_agent(&agent, &region(), &100),
        Err(Ok(AgentRegistryError::AgentAlreadyRegistered))
    );
}

#[test]
fn revoked_agent_may_reregister_with_a_fresh_bond() {
    let f = setup();
    with_region(&f, 100);
    let agent = Address::generate(&f.env);
    fund(&f, &agent, 1_000);

    f.client.register_agent(&agent, &region(), &100);
    f.client.authorize_agent(&agent);
    f.client.revoke_agent(&agent, &symbol_short!("fraud"));

    let record = f.client.register_agent(&agent, &region(), &200);
    assert_eq!(record.status, AgentStatus::Pending);
    // Old collateral never carries over: only the fresh bond counts.
    assert_eq!(record.bond, 200);
}

/* ------------------------------------------------------------------ */
/* authorization                                                       */
/* ------------------------------------------------------------------ */

#[test]
fn pending_agent_is_not_authorized_until_approved() {
    let f = setup();
    with_region(&f, 10);
    let agent = Address::generate(&f.env);
    fund(&f, &agent, 100);

    f.client.register_agent(&agent, &region(), &100);
    assert!(!f.client.is_authorized(&agent, &region()));
    assert!(!f.client.is_authorized_for_corridor(&agent, &corridor()));

    f.client.authorize_agent(&agent);
    assert!(f.client.is_authorized(&agent, &region()));
    assert!(f.client.is_authorized_for_corridor(&agent, &corridor()));
    assert_eq!(f.client.registry_stats().authorized_agents, 1);
}

#[test]
fn authorization_is_scoped_to_the_agents_own_region() {
    let f = setup();
    with_region(&f, 10);
    f.client.add_region(&other_region(), &10, &0);

    let agent = Address::generate(&f.env);
    fund(&f, &agent, 100);
    f.client.register_agent(&agent, &region(), &100);
    f.client.authorize_agent(&agent);

    assert!(f.client.is_authorized(&agent, &region()));
    assert!(!f.client.is_authorized(&agent, &other_region()));
}

#[test]
fn region_cap_limits_authorized_agents() {
    let f = setup();
    let capped = symbol_short!("CAPPED");
    f.client.add_region(&capped, &10, &1);

    let a = Address::generate(&f.env);
    let b = Address::generate(&f.env);
    fund(&f, &a, 100);
    fund(&f, &b, 100);
    f.client.register_agent(&a, &capped, &100);
    f.client.register_agent(&b, &capped, &100);

    f.client.authorize_agent(&a);
    assert_eq!(
        f.client.try_authorize_agent(&b),
        Err(Ok(AgentRegistryError::RegionFull))
    );
}

#[test]
fn deactivating_a_region_stops_settlement_without_changing_status() {
    let f = setup();
    with_region(&f, 10);
    let agent = Address::generate(&f.env);
    fund(&f, &agent, 100);
    f.client.register_agent(&agent, &region(), &100);
    f.client.authorize_agent(&agent);
    assert!(f.client.is_authorized(&agent, &region()));

    f.client.set_region_active(&region(), &false);
    assert!(!f.client.is_authorized(&agent, &region()));
    // Status is untouched: reactivating the region restores settlement for
    // every agent at once, without re-running onboarding.
    assert_eq!(
        f.client.get_agent(&agent).unwrap().status,
        AgentStatus::Authorized
    );

    f.client.set_region_active(&region(), &true);
    assert!(f.client.is_authorized(&agent, &region()));
}

/* ------------------------------------------------------------------ */
/* bond custody                                                        */
/* ------------------------------------------------------------------ */

#[test]
fn authorized_agent_cannot_withdraw_its_bond() {
    let f = setup();
    with_region(&f, 10);
    let agent = Address::generate(&f.env);
    fund(&f, &agent, 100);
    f.client.register_agent(&agent, &region(), &100);
    f.client.authorize_agent(&agent);

    assert_eq!(
        f.client.try_withdraw_bond(&agent, &100),
        Err(Ok(AgentRegistryError::BondLockedWhileAuthorized))
    );
}

#[test]
fn revoked_agent_can_reclaim_its_remaining_bond() {
    let f = setup();
    with_region(&f, 10);
    let agent = Address::generate(&f.env);
    fund(&f, &agent, 100);
    f.client.register_agent(&agent, &region(), &100);
    f.client.authorize_agent(&agent);
    f.client.revoke_agent(&agent, &symbol_short!("no_show"));

    let remaining = f.client.withdraw_bond(&agent, &100);
    assert_eq!(remaining, 0);
    assert_eq!(balance(&f, &agent), 100);
}

#[test]
fn withdraw_bond_beyond_the_bond_is_rejected() {
    let f = setup();
    with_region(&f, 10);
    let agent = Address::generate(&f.env);
    fund(&f, &agent, 100);
    f.client.register_agent(&agent, &region(), &100);

    assert_eq!(
        f.client.try_withdraw_bond(&agent, &101),
        Err(Ok(AgentRegistryError::InsufficientBond))
    );
}

#[test]
fn slash_moves_funds_to_treasury_and_is_capped_at_the_bond() {
    let f = setup();
    with_region(&f, 10);
    let agent = Address::generate(&f.env);
    fund(&f, &agent, 1_000);
    f.client.register_agent(&agent, &region(), &500);

    assert_eq!(
        f.client
            .try_slash_agent(&agent, &501, &symbol_short!("fraud")),
        Err(Ok(AgentRegistryError::SlashExceedsBond))
    );

    let recovered = f.client.slash_agent(&agent, &200, &symbol_short!("fraud"));
    assert_eq!(recovered, 200);
    assert_eq!(f.client.get_bond(&agent), 300);
    assert_eq!(balance(&f, &f.treasury), 200);
    assert_eq!(f.client.registry_stats().total_slashed, 200);
}

#[test]
fn slash_below_region_minimum_auto_suspends_the_agent() {
    let f = setup();
    with_region(&f, 100);
    let agent = Address::generate(&f.env);
    fund(&f, &agent, 1_000);
    f.client.register_agent(&agent, &region(), &500);
    f.client.authorize_agent(&agent);
    assert!(f.client.is_authorized(&agent, &region()));

    // Leaves 50 bonded, below the region's 100 minimum.
    f.client.slash_agent(&agent, &450, &symbol_short!("fraud"));

    let record = f.client.get_agent(&agent).unwrap();
    assert_eq!(record.status, AgentStatus::Suspended);
    assert!(!f.client.is_authorized(&agent, &region()));
    assert_eq!(f.client.registry_stats().authorized_agents, 0);
}

#[test]
fn suspend_and_reactivate_keep_the_authorized_counter_balanced() {
    let f = setup();
    with_region(&f, 10);
    let agent = Address::generate(&f.env);
    fund(&f, &agent, 100);
    f.client.register_agent(&agent, &region(), &100);
    f.client.authorize_agent(&agent);

    f.client.suspend_agent(&agent, &symbol_short!("review"));
    assert!(!f.client.is_authorized(&agent, &region()));
    assert_eq!(f.client.registry_stats().authorized_agents, 0);

    f.client.authorize_agent(&agent);
    assert!(f.client.is_authorized(&agent, &region()));
    assert_eq!(f.client.registry_stats().authorized_agents, 1);
}

#[test]
fn revoke_is_terminal() {
    let f = setup();
    with_region(&f, 10);
    let agent = Address::generate(&f.env);
    fund(&f, &agent, 100);
    f.client.register_agent(&agent, &region(), &100);

    f.client.revoke_agent(&agent, &symbol_short!("fraud"));
    assert_eq!(
        f.client.try_revoke_agent(&agent, &symbol_short!("fraud")),
        Err(Ok(AgentRegistryError::InvalidStatusTransition))
    );
    assert_eq!(
        f.client.try_authorize_agent(&agent),
        Err(Ok(AgentRegistryError::InvalidStatusTransition))
    );
}

#[test]
fn top_up_preserves_registration_time_and_advances_update_time() {
    let f = setup();
    with_region(&f, 10);
    let agent = Address::generate(&f.env);
    fund(&f, &agent, 1_000);

    f.env.ledger().set_timestamp(1_000);
    f.client.register_agent(&agent, &region(), &100);
    let first = f.client.get_agent(&agent).unwrap();

    f.env.ledger().set_timestamp(2_000);
    let bond = f.client.top_up_bond(&agent, &50);

    let second = f.client.get_agent(&agent).unwrap();
    assert_eq!(bond, 150);
    assert_eq!(second.registered_at, first.registered_at);
    assert!(second.updated_at > first.updated_at);
}

#[test]
fn unknown_agent_reads_are_safe() {
    let f = setup();
    let nobody = Address::generate(&f.env);
    assert_eq!(f.client.get_bond(&nobody), 0);
    assert!(f.client.get_agent(&nobody).is_none());
    assert!(!f.client.is_authorized(&nobody, &region()));
    assert!(!f.client.is_authorized_for_corridor(&nobody, &corridor()));
}
