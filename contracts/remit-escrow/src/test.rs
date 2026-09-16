//! Escrow test suite.
//!
//! These are integration tests, not unit tests: the real `AgentRegistry` and
//! `ComplianceHook` contracts are deployed alongside the escrow, so the
//! cross-contract calls that decide whether money moves are exercised exactly as
//! they will be on-chain. Mocking them would have tested the mocks.
//!
//! The suite is organised around the ways a transfer can go wrong rather than
//! around the functions: a code that does not match, an agent who is not
//! authorized, a claim that arrives twice, a refund that arrives early.

use soroban_sdk::{
    symbol_short,
    testutils::{Address as _, Ledger as _},
    token::{Client as TokenClient, StellarAssetClient},
    Address, Bytes, BytesN, Env, Symbol,
};

use agent_registry::AgentRegistryClient;
use compliance_hook::ComplianceHookClient;

use remit_interfaces::compliance::TierThresholds;
use remit_interfaces::escrow::{EscrowError, TransferStatus, MAX_FEE_BPS};

use std::println;

use crate::{RemitEscrow, RemitEscrowClient};

const DAY: u64 = 86_400;
/// Above the no-verification band (100), so these transfers exercise the gate.
const AMOUNT: i128 = 1_000;
/// Platform fee used throughout: 2%.
const FEE_BPS: u32 = 200;
const MAX_EXPIRY: u64 = 90 * DAY;

fn region() -> Symbol {
    symbol_short!("NG_LAG")
}

fn corridor() -> Symbol {
    symbol_short!("NGN_LAG")
}

/// The recipient's claim code, standing in for the CSPRNG output the mobile app
/// generates. The escrow only ever sees its hash.
const CLAIM_CODE: [u8; 32] = [7u8; 32];

struct Fixture {
    env: Env,
    escrow: RemitEscrowClient<'static>,
    registry: AgentRegistryClient<'static>,
    hook: ComplianceHookClient<'static>,
    admin: Address,
    attester: Address,
    treasury: Address,
    token: Address,
    escrow_id: Address,
    hook_id: Address,
}

fn hash_of(env: &Env, code: &[u8; 32]) -> BytesN<32> {
    env.crypto().sha256(&Bytes::from_array(env, code)).into()
}

fn now(f: &Fixture) -> u64 {
    f.env.ledger().timestamp()
}

/// The compliance hook's rolling-day bucket, which is `timestamp / 86_400`.
/// Tests must derive it rather than assume day zero, because the suite starts
/// the ledger clock at a realistic timestamp rather than at the epoch.
fn day(f: &Fixture) -> u64 {
    now(f) / DAY
}

fn setup() -> Fixture {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_timestamp(1_000_000);

    let admin = Address::generate(&env);
    let attester = Address::generate(&env);
    let treasury = Address::generate(&env);

    let token = env
        .register_stellar_asset_contract_v2(admin.clone())
        .address();

    // Registry: one region, bonded agents, corridor mapped to that region.
    let registry_id = env.register(agent_registry::AgentRegistry, ());
    let registry = AgentRegistryClient::new(&env, &registry_id);
    registry.initialize(&admin, &token, &treasury);
    registry.add_region(&region(), &500, &0);
    registry.map_corridor(&corridor(), &region());

    // Compliance: 100 free, 1_000 with standard KYC, above with EDD, 5_000/day.
    let hook_id = env.register(compliance_hook::ComplianceHook, ());
    let hook = ComplianceHookClient::new(&env, &hook_id);
    hook.initialize(&admin);
    hook.set_operator(&attester, &true);
    hook.set_tier_thresholds(&TierThresholds {
        corridor_id: corridor(),
        tier1_max: 100,
        tier2_max: 1_000,
        daily_limit: 5_000,
    });

    let escrow_id = env.register(RemitEscrow, ());
    let escrow = RemitEscrowClient::new(&env, &escrow_id);
    escrow.initialize(
        &admin,
        &registry_id,
        &hook_id,
        &treasury,
        &FEE_BPS,
        &MAX_EXPIRY,
    );
    hook.set_escrow(&escrow_id);

    Fixture {
        env,
        escrow,
        registry,
        hook,
        admin,
        attester,
        treasury,
        token,
        escrow_id,
        hook_id,
    }
}

fn fund(f: &Fixture, who: &Address, amount: i128) {
    StellarAssetClient::new(&f.env, &f.token).mint(who, &amount);
}

fn balance(f: &Fixture, who: &Address) -> i128 {
    TokenClient::new(&f.env, &f.token).balance(who)
}

fn escrow_balance(f: &Fixture) -> i128 {
    balance(f, &f.escrow_id)
}

/// Register, bond and authorize an agent in one step.
fn onboard_agent(f: &Fixture, bond: i128) -> Address {
    let agent = Address::generate(&f.env);
    fund(f, &agent, bond);
    f.registry.register_agent(&agent, &region(), &bond);
    f.registry.authorize_agent(&agent);
    agent
}

/// Give a sender a standard attestation for the corridor.
fn attest_sender(f: &Fixture, sender: &Address) {
    f.hook.publish_attestation(
        &f.attester,
        sender,
        &remit_interfaces::compliance::KycTier::Standard,
        &hash_of(&f.env, &[9u8; 32]),
        &region(),
        &symbol_short!("mock"),
        &(now(f) + 30 * DAY),
    );
}

/// Create a standard, compliant transfer and return its id.
fn create(f: &Fixture, sender: &Address) -> u64 {
    f.escrow.create_transfer(
        sender,
        &AMOUNT,
        &f.token,
        &hash_of(&f.env, &CLAIM_CODE),
        &corridor(),
        &(now(f) + 7 * DAY),
    )
}

/* ------------------------------------------------------------------ */
/* configuration                                                       */
/* ------------------------------------------------------------------ */

#[test]
fn initialize_is_not_repeatable() {
    let f = setup();
    assert_eq!(
        f.escrow.try_initialize(
            &f.admin,
            &f.escrow_id,
            &f.escrow_id,
            &f.treasury,
            &FEE_BPS,
            &MAX_EXPIRY
        ),
        Err(Ok(EscrowError::AlreadyInitialized))
    );
}

#[test]
fn fee_above_the_on_chain_cap_is_rejected() {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let id = env.register(RemitEscrow, ());
    let client = RemitEscrowClient::new(&env, &id);

    assert_eq!(
        client.try_initialize(&admin, &id, &id, &admin, &(MAX_FEE_BPS + 1), &MAX_EXPIRY),
        Err(Ok(EscrowError::InvalidConfig))
    );
}

#[test]
fn fee_updates_are_capped() {
    let f = setup();
    assert_eq!(
        f.escrow.try_set_fee_bps(&(MAX_FEE_BPS + 1)),
        Err(Ok(EscrowError::FeeTooHigh))
    );
    f.escrow.set_fee_bps(&100);
    assert_eq!(f.escrow.escrow_config().unwrap().fee_bps, 100);
}

#[test]
fn zero_expiry_ceiling_is_rejected() {
    let f = setup();
    assert_eq!(
        f.escrow.try_set_max_expiry(&0),
        Err(Ok(EscrowError::InvalidConfig))
    );
}

/* ------------------------------------------------------------------ */
/* creation                                                            */
/* ------------------------------------------------------------------ */

#[test]
fn create_transfer_locks_funds_and_commits_volume() {
    let f = setup();
    let sender = Address::generate(&f.env);
    fund(&f, &sender, 10_000);
    attest_sender(&f, &sender);

    let id = create(&f, &sender);

    assert_eq!(id, 1);
    assert_eq!(balance(&f, &sender), 9_000);
    assert_eq!(escrow_balance(&f), AMOUNT);

    let transfer = f.escrow.get_transfer(&id).unwrap();
    assert_eq!(transfer.status, TransferStatus::Pending);
    assert_eq!(transfer.amount, AMOUNT);
    assert_eq!(transfer.sender, sender);
    assert!(transfer.claimed_by.is_none());

    // The daily bucket moved with the transfer, not after it.
    assert_eq!(f.hook.daily_volume(&sender, &corridor(), &day(&f)), AMOUNT);

    assert_eq!(f.escrow.transfer_count(), 1);
    assert_eq!(f.escrow.list_sender_transfers(&sender).len(), 1);
    assert_eq!(f.escrow.escrow_stats().volume_locked, AMOUNT);
}

#[test]
fn compliance_refusal_happens_before_any_funds_move() {
    let f = setup();
    let sender = Address::generate(&f.env);
    fund(&f, &sender, 10_000);
    // No attestation, and 1_000 is above the no-verification band.
    assert_eq!(
        f.escrow.try_create_transfer(
            &sender,
            &AMOUNT,
            &f.token,
            &hash_of(&f.env, &CLAIM_CODE),
            &corridor(),
            &(now(&f) + 7 * DAY)
        ),
        Err(Ok(EscrowError::ComplianceRefused))
    );

    // The distinguishing property of checking first: the sender's balance was
    // never touched, so there is nothing to unwind.
    assert_eq!(balance(&f, &sender), 10_000);
    assert_eq!(escrow_balance(&f), 0);
    assert_eq!(f.escrow.transfer_count(), 0);
    assert_eq!(f.hook.daily_volume(&sender, &corridor(), &day(&f)), 0);
}

#[test]
fn unverified_small_transfers_still_work() {
    let f = setup();
    let sender = Address::generate(&f.env);
    fund(&f, &sender, 1_000);

    // 100 is at the no-verification band, so no attestation is needed.
    let id = f.escrow.create_transfer(
        &sender,
        &100,
        &f.token,
        &hash_of(&f.env, &CLAIM_CODE),
        &corridor(),
        &(now(&f) + DAY),
    );
    assert_eq!(f.escrow.get_transfer(&id).unwrap().amount, 100);
}

#[test]
fn daily_limit_is_enforced_across_transfers() {
    let f = setup();
    let sender = Address::generate(&f.env);
    fund(&f, &sender, 100_000);
    attest_sender(&f, &sender);

    // Five transfers of 1_000 consume the 5_000 ceiling exactly; the sixth must
    // not — and note that the ceiling is inclusive, so the fifth is fine.
    for _ in 0..5 {
        create(&f, &sender);
    }
    let outcome = f.escrow.try_create_transfer(
        &sender,
        &AMOUNT,
        &f.token,
        &hash_of(&f.env, &CLAIM_CODE),
        &corridor(),
        &(now(&f) + DAY),
    );
    assert_eq!(outcome, Err(Ok(EscrowError::ComplianceRefused)));
    assert_eq!(escrow_balance(&f), 5 * AMOUNT);
}

#[test]
fn expired_and_overlong_expiries_are_rejected() {
    let f = setup();
    let sender = Address::generate(&f.env);
    fund(&f, &sender, 10_000);

    let past = f.escrow.try_create_transfer(
        &sender,
        &100,
        &f.token,
        &hash_of(&f.env, &CLAIM_CODE),
        &corridor(),
        &now(&f),
    );
    assert_eq!(past, Err(Ok(EscrowError::InvalidExpiry)));

    let too_far = f.escrow.try_create_transfer(
        &sender,
        &100,
        &f.token,
        &hash_of(&f.env, &CLAIM_CODE),
        &corridor(),
        &(now(&f) + MAX_EXPIRY + 1),
    );
    assert_eq!(too_far, Err(Ok(EscrowError::ExpiryTooFar)));
}

#[test]
fn non_positive_amounts_are_rejected() {
    let f = setup();
    let sender = Address::generate(&f.env);
    fund(&f, &sender, 10_000);
    assert_eq!(
        f.escrow.try_create_transfer(
            &sender,
            &0,
            &f.token,
            &hash_of(&f.env, &CLAIM_CODE),
            &corridor(),
            &(now(&f) + DAY)
        ),
        Err(Ok(EscrowError::InvalidAmount))
    );
}

#[test]
fn pause_stops_creation_but_never_traps_existing_transfers() {
    let f = setup();
    let sender = Address::generate(&f.env);
    fund(&f, &sender, 10_000);
    attest_sender(&f, &sender);
    let id = create(&f, &sender);
    let agent = onboard_agent(&f, 1_000);

    f.escrow.set_paused(&true);
    assert_eq!(
        f.escrow.try_create_transfer(
            &sender,
            &100,
            &f.token,
            &hash_of(&f.env, &CLAIM_CODE),
            &corridor(),
            &(now(&f) + DAY)
        ),
        Err(Ok(EscrowError::Paused))
    );

    // The transfer already in flight is unaffected: this is the property that
    // stops a pause from becoming a hostage-taking mechanism.
    let receipt = f
        .escrow
        .claim_transfer(&agent, &id, &BytesN::from_array(&f.env, &CLAIM_CODE));
    assert_eq!(receipt.payout, AMOUNT - 20);
}

/* ------------------------------------------------------------------ */
/* claiming                                                            */
/* ------------------------------------------------------------------ */

#[test]
fn authorized_agent_with_the_right_code_settles_the_transfer() {
    let f = setup();
    let sender = Address::generate(&f.env);
    fund(&f, &sender, 10_000);
    attest_sender(&f, &sender);
    let agent = onboard_agent(&f, 1_000);
    let id = create(&f, &sender);

    let receipt = f
        .escrow
        .claim_transfer(&agent, &id, &BytesN::from_array(&f.env, &CLAIM_CODE));

    assert_eq!(receipt.gross, AMOUNT);
    assert_eq!(receipt.fee, 20);
    assert_eq!(receipt.payout, AMOUNT - 20);
    // The agent bonded 1_000 (now held by the registry) and received the 980
    // net payout, so its free balance is exactly the payout.
    assert_eq!(balance(&f, &agent), 980);
    assert_eq!(balance(&f, &f.treasury), 20);
    assert_eq!(escrow_balance(&f), 0);

    let transfer = f.escrow.get_transfer(&id).unwrap();
    assert_eq!(transfer.status, TransferStatus::Claimed);
    assert_eq!(transfer.claimed_by, Some(agent));

    let stats = f.escrow.escrow_stats();
    assert_eq!(stats.claimed, 1);
    assert_eq!(stats.fees_collected, 20);
    assert_eq!(stats.volume_locked, 0);
}

#[test]
fn a_wrong_reveal_leaves_the_funds_untouched() {
    let f = setup();
    let sender = Address::generate(&f.env);
    fund(&f, &sender, 10_000);
    attest_sender(&f, &sender);
    let agent = onboard_agent(&f, 1_000);
    let id = create(&f, &sender);

    let outcome = f
        .escrow
        .try_claim_transfer(&agent, &id, &BytesN::from_array(&f.env, &[8u8; 32]));
    assert_eq!(outcome, Err(Ok(EscrowError::InvalidClaimCode)));

    assert_eq!(escrow_balance(&f), AMOUNT);
    assert_eq!(
        f.escrow.get_transfer(&id).unwrap().status,
        TransferStatus::Pending
    );
    assert_eq!(balance(&f, &f.treasury), 0);
}

#[test]
fn an_unbonded_agent_cannot_claim_even_with_the_right_code() {
    let f = setup();
    let sender = Address::generate(&f.env);
    fund(&f, &sender, 10_000);
    attest_sender(&f, &sender);
    let id = create(&f, &sender);

    let stranger = Address::generate(&f.env);
    let outcome =
        f.escrow
            .try_claim_transfer(&stranger, &id, &BytesN::from_array(&f.env, &CLAIM_CODE));
    assert_eq!(outcome, Err(Ok(EscrowError::AgentNotAuthorized)));
    assert_eq!(escrow_balance(&f), AMOUNT);
}

#[test]
fn a_pending_but_unapproved_agent_cannot_claim() {
    let f = setup();
    let sender = Address::generate(&f.env);
    fund(&f, &sender, 10_000);
    attest_sender(&f, &sender);

    // Bonded, but never authorized by the operator.
    let agent = Address::generate(&f.env);
    fund(&f, &agent, 1_000);
    f.registry.register_agent(&agent, &region(), &1_000);

    let id = create(&f, &sender);
    let outcome =
        f.escrow
            .try_claim_transfer(&agent, &id, &BytesN::from_array(&f.env, &CLAIM_CODE));
    assert_eq!(outcome, Err(Ok(EscrowError::AgentNotAuthorized)));
}

#[test]
fn revoking_an_agent_mid_flight_blocks_the_claim() {
    let f = setup();
    let sender = Address::generate(&f.env);
    fund(&f, &sender, 10_000);
    attest_sender(&f, &sender);
    let agent = onboard_agent(&f, 1_000);
    let id = create(&f, &sender);

    f.registry.revoke_agent(&agent, &symbol_short!("fraud"));

    let outcome =
        f.escrow
            .try_claim_transfer(&agent, &id, &BytesN::from_array(&f.env, &CLAIM_CODE));
    assert_eq!(outcome, Err(Ok(EscrowError::AgentNotAuthorized)));
}

#[test]
fn claiming_twice_pays_once() {
    let f = setup();
    let sender = Address::generate(&f.env);
    fund(&f, &sender, 10_000);
    attest_sender(&f, &sender);
    let agent = onboard_agent(&f, 1_000);
    let id = create(&f, &sender);

    f.escrow
        .claim_transfer(&agent, &id, &BytesN::from_array(&f.env, &CLAIM_CODE));
    let before = balance(&f, &agent);

    let second = f
        .escrow
        .try_claim_transfer(&agent, &id, &BytesN::from_array(&f.env, &CLAIM_CODE));
    assert_eq!(second, Err(Ok(EscrowError::TransferNotPending)));
    assert_eq!(balance(&f, &agent), before);
    assert_eq!(f.escrow.escrow_stats().claimed, 1);
}

#[test]
fn a_sender_cannot_claim_their_own_transfer() {
    let f = setup();
    let sender = Address::generate(&f.env);
    fund(&f, &sender, 10_000);
    attest_sender(&f, &sender);

    // Give the sender an agent bond too, so the *only* thing standing between
    // them and claiming is the self-dealing rule.
    f.registry.register_agent(&sender, &region(), &1_000);
    f.registry.authorize_agent(&sender);

    let id = create(&f, &sender);
    let outcome =
        f.escrow
            .try_claim_transfer(&sender, &id, &BytesN::from_array(&f.env, &CLAIM_CODE));
    assert_eq!(outcome, Err(Ok(EscrowError::SenderCannotClaim)));
}

#[test]
fn claiming_after_expiry_is_refused_in_favour_of_a_refund() {
    let f = setup();
    let sender = Address::generate(&f.env);
    fund(&f, &sender, 10_000);
    attest_sender(&f, &sender);
    let agent = onboard_agent(&f, 1_000);
    let id = create(&f, &sender);

    f.env.ledger().set_timestamp(now(&f) + 8 * DAY);

    let outcome =
        f.escrow
            .try_claim_transfer(&agent, &id, &BytesN::from_array(&f.env, &CLAIM_CODE));
    assert_eq!(outcome, Err(Ok(EscrowError::TransferExpired)));
    assert_eq!(escrow_balance(&f), AMOUNT);
}

#[test]
fn an_unreachable_registry_fails_the_claim_closed() {
    let f = setup();
    let sender = Address::generate(&f.env);
    fund(&f, &sender, 10_000);
    attest_sender(&f, &sender);
    let agent = onboard_agent(&f, 1_000);
    let id = create(&f, &sender);

    // Point the escrow at an address with no contract behind it.
    f.escrow.set_agent_registry(&Address::generate(&f.env));

    let outcome =
        f.escrow
            .try_claim_transfer(&agent, &id, &BytesN::from_array(&f.env, &CLAIM_CODE));
    assert_eq!(outcome, Err(Ok(EscrowError::RegistryCallFailed)));
    // The point of failing closed: no funds left escrow.
    assert_eq!(escrow_balance(&f), AMOUNT);
}

#[test]
fn the_fee_rounds_down_in_the_senders_favour() {
    let f = setup();
    let sender = Address::generate(&f.env);
    fund(&f, &sender, 10_000);
    attest_sender(&f, &sender);

    // 3 bps of 333 = 0.0999 → 0, not 1.
    f.escrow.set_fee_bps(&3);
    let id = f.escrow.create_transfer(
        &sender,
        &333,
        &f.token,
        &hash_of(&f.env, &CLAIM_CODE),
        &corridor(),
        &(now(&f) + DAY),
    );

    let quote = f.escrow.quote_claim(&id);
    assert_eq!(quote.gross, 333);
    assert_eq!(quote.fee, 0);
    assert_eq!(quote.payout, 333);
}

#[test]
fn quote_claim_matches_the_actual_settlement() {
    let f = setup();
    let sender = Address::generate(&f.env);
    fund(&f, &sender, 10_000);
    attest_sender(&f, &sender);
    let agent = onboard_agent(&f, 1_000);
    let id = create(&f, &sender);

    let quote = f.escrow.quote_claim(&id);
    let receipt = f
        .escrow
        .claim_transfer(&agent, &id, &BytesN::from_array(&f.env, &CLAIM_CODE));

    assert_eq!(quote.gross, receipt.gross);
    assert_eq!(quote.fee, receipt.fee);
    assert_eq!(quote.payout, receipt.payout);
}

/* ------------------------------------------------------------------ */
/* cancellation and refunds                                            */
/* ------------------------------------------------------------------ */

#[test]
fn sender_can_cancel_before_any_claim() {
    let f = setup();
    let sender = Address::generate(&f.env);
    fund(&f, &sender, 10_000);
    attest_sender(&f, &sender);
    let id = create(&f, &sender);

    f.escrow.cancel_transfer(&sender, &id);

    assert_eq!(balance(&f, &sender), 10_000);
    assert_eq!(escrow_balance(&f), 0);
    let transfer = f.escrow.get_transfer(&id).unwrap();
    assert_eq!(transfer.status, TransferStatus::Cancelled);
    assert_eq!(f.escrow.escrow_stats().cancelled, 1);
}

#[test]
fn only_the_sender_can_cancel() {
    let f = setup();
    let sender = Address::generate(&f.env);
    fund(&f, &sender, 10_000);
    attest_sender(&f, &sender);
    let agent = onboard_agent(&f, 1_000);
    let id = create(&f, &sender);

    let outcome = f.escrow.try_cancel_transfer(&agent, &id);
    assert_eq!(outcome, Err(Ok(EscrowError::Unauthorized)));
    assert_eq!(escrow_balance(&f), AMOUNT);
}

#[test]
fn a_claimed_transfer_can_no_longer_be_cancelled() {
    let f = setup();
    let sender = Address::generate(&f.env);
    fund(&f, &sender, 10_000);
    attest_sender(&f, &sender);
    let agent = onboard_agent(&f, 1_000);
    let id = create(&f, &sender);

    f.escrow
        .claim_transfer(&agent, &id, &BytesN::from_array(&f.env, &CLAIM_CODE));

    let outcome = f.escrow.try_cancel_transfer(&sender, &id);
    assert_eq!(outcome, Err(Ok(EscrowError::TransferNotPending)));
}

#[test]
fn anyone_can_refund_an_expired_transfer_but_only_to_the_sender() {
    let f = setup();
    let sender = Address::generate(&f.env);
    fund(&f, &sender, 10_000);
    attest_sender(&f, &sender);
    let id = create(&f, &sender);
    let before = balance(&f, &sender);

    // Too early.
    let early = f.escrow.try_refund_expired(&id);
    assert_eq!(early, Err(Ok(EscrowError::TransferNotExpired)));

    f.env.ledger().set_timestamp(now(&f) + 8 * DAY);

    // A passer-by triggers the refund; the sender may be long gone.
    let helper = Address::generate(&f.env);
    f.escrow.refund_expired(&id);

    assert_eq!(balance(&f, &sender), before + AMOUNT);
    assert_eq!(balance(&f, &helper), 0);
    assert_eq!(
        f.escrow.get_transfer(&id).unwrap().status,
        TransferStatus::Refunded
    );
    assert_eq!(f.escrow.escrow_stats().refunded, 1);
}

#[test]
fn a_refunded_transfer_cannot_then_be_claimed() {
    let f = setup();
    let sender = Address::generate(&f.env);
    fund(&f, &sender, 10_000);
    attest_sender(&f, &sender);
    let agent = onboard_agent(&f, 1_000);
    let id = create(&f, &sender);

    f.env.ledger().set_timestamp(now(&f) + 8 * DAY);
    f.escrow.refund_expired(&id);

    // The code is now worthless, which is exactly the incentive for a recipient
    // to cash out promptly.
    let outcome =
        f.escrow
            .try_claim_transfer(&agent, &id, &BytesN::from_array(&f.env, &CLAIM_CODE));
    assert_eq!(outcome, Err(Ok(EscrowError::TransferNotPending)));
}

#[test]
fn refunds_and_claims_race_cleanly_and_only_one_wins() {
    let f = setup();
    let sender = Address::generate(&f.env);
    fund(&f, &sender, 10_000);
    attest_sender(&f, &sender);
    let agent = onboard_agent(&f, 1_000);
    let id = create(&f, &sender);

    // The claim lands first, still inside the validity window.
    f.escrow
        .claim_transfer(&agent, &id, &BytesN::from_array(&f.env, &CLAIM_CODE));
    let agent_balance = balance(&f, &agent);

    // Later, past expiry, the refund is attempted and must fail.
    f.env.ledger().set_timestamp(now(&f) + 8 * DAY);
    assert_eq!(
        f.escrow.try_refund_expired(&id),
        Err(Ok(EscrowError::TransferNotPending))
    );

    let stats = f.escrow.escrow_stats();
    assert_eq!(stats.claimed, 1);
    assert_eq!(stats.refunded, 0);
    assert_eq!(balance(&f, &agent), agent_balance);
    assert_eq!(escrow_balance(&f), 0);
}

/* ------------------------------------------------------------------ */
/* reads and administration                                            */
/* ------------------------------------------------------------------ */

#[test]
fn unknown_transfers_read_safely_and_error_clearly() {
    let f = setup();
    assert!(f.escrow.get_transfer(&999).is_none());
    assert_eq!(f.escrow.transfer_count(), 0);
    assert_eq!(
        f.escrow.try_quote_claim(&999),
        Err(Ok(EscrowError::TransferNotFound))
    );
    assert_eq!(
        f.escrow
            .try_cancel_transfer(&Address::generate(&f.env), &999),
        Err(Ok(EscrowError::TransferNotFound))
    );
}

#[test]
fn sender_index_accumulates_every_transfer() {
    let f = setup();
    let sender = Address::generate(&f.env);
    fund(&f, &sender, 10_000);
    attest_sender(&f, &sender);

    create(&f, &sender);
    create(&f, &sender);
    create(&f, &sender);

    let ids = f.escrow.list_sender_transfers(&sender);
    assert_eq!(ids.len(), 3);
    assert_eq!(ids.get(0).unwrap(), 1);
    assert_eq!(ids.get(2).unwrap(), 3);
    assert_eq!(f.escrow.transfer_count(), 3);
    assert_eq!(f.escrow.escrow_stats().created, 3);
}

#[test]
fn rewiring_the_compliance_hook_is_an_incident_response_tool() {
    let f = setup();
    let sender = Address::generate(&f.env);
    fund(&f, &sender, 10_000);
    attest_sender(&f, &sender);

    // A second gate where tier1 is far lower, so the same transfer is refused.
    let strict_id = f.env.register(compliance_hook::ComplianceHook, ());
    let strict = ComplianceHookClient::new(&f.env, &strict_id);
    strict.initialize(&f.admin);
    strict.set_tier_thresholds(&TierThresholds {
        corridor_id: corridor(),
        tier1_max: 10,
        tier2_max: 100,
        daily_limit: 500,
    });
    strict.set_escrow(&f.escrow_id);

    f.escrow.set_compliance_hook(&strict_id);
    assert_eq!(
        f.escrow.try_create_transfer(
            &sender,
            &AMOUNT,
            &f.token,
            &hash_of(&f.env, &CLAIM_CODE),
            &corridor(),
            &(now(&f) + DAY)
        ),
        Err(Ok(EscrowError::ComplianceRefused))
    );

    // Point back at the original hook and the corridor works again.
    f.escrow.set_compliance_hook(&f.hook_id);
    let id = create(&f, &sender);
    assert_eq!(f.escrow.get_transfer(&id).unwrap().amount, AMOUNT);
}

#[test]
fn an_unreachable_compliance_hook_is_reported_as_an_incident_not_a_refusal() {
    let f = setup();
    let sender = Address::generate(&f.env);
    fund(&f, &sender, 10_000);
    attest_sender(&f, &sender);

    f.escrow.set_compliance_hook(&Address::generate(&f.env));

    // Distinct from `ComplianceRefused`: the sender has nothing to fix here.
    let outcome = f.escrow.try_create_transfer(
        &sender,
        &AMOUNT,
        &f.token,
        &hash_of(&f.env, &CLAIM_CODE),
        &corridor(),
        &(now(&f) + DAY),
    );
    assert_eq!(outcome, Err(Ok(EscrowError::ComplianceCallFailed)));
    assert_eq!(balance(&f, &sender), 10_000);
}

#[test]
fn rotation_hands_over_the_operator_key() {
    let f = setup();
    let next = Address::generate(&f.env);
    f.escrow.set_admin(&next);
    f.escrow.set_fee_bps(&50);
    assert_eq!(f.escrow.escrow_config().unwrap().fee_bps, 50);
}

/* ------------------------------------------------------------------ */
/* cost report                                                         */
/* ------------------------------------------------------------------ */

/// Modelled resources of the *last* top-level invocation, as one table row.
///
/// A macro rather than a helper function on purpose: the resource and fee types
/// live in `soroban-env-host`, which a contract crate does not depend on, and
/// naming them in a signature would mean adding a dependency just to print
/// numbers. Field access needs no import.
macro_rules! cost_row {
    ($entry:expr, $env:expr) => {{
        let resources = $env.cost_estimate().resources();
        let fee = $env.cost_estimate().fee();
        // Rent is reported separately because it is a function of *time* — how
        // many ledgers an entry was extended by, and when — rather than of the
        // code path. Folding it into one total makes two rows that do the same
        // amount of work look different, so the comparable number is the fee
        // excluding rent.
        let work = fee.instructions
            + fee.read_entries
            + fee.write_entries
            + fee.read_bytes
            + fee.write_bytes
            + fee.contract_events;
        let rent = fee.persistent_entry_rent + fee.temporary_entry_rent;
        println!(
            "| {:<18} | {:>9} | {:>8} | {:>6} | {:>7} | {:>8} | {:>7} | {:>8} | {:>9} |",
            $entry,
            resources.instructions,
            resources.mem_bytes,
            resources.read_entries,
            resources.write_entries,
            resources.read_bytes + resources.write_bytes,
            resources.contract_events_size_bytes,
            work,
            rent,
        );
    }};
}

/// Cost report for the entry points that move money.
///
/// This is a **measurement, not an assertion**. Pinning instruction counts as
/// literals would turn every dependency bump into a red build without saying
/// whether anything got worse, so the numbers are printed for a reviewer to
/// compare across a change — the point is that a fee claim can be checked rather
/// than believed.
///
/// Each scenario asserts its own effect before reporting, so a row cannot be a
/// measurement of a call that quietly failed and cost nothing.
///
/// Two things this does not model, and which a real transaction pays anyway:
/// Wasm instantiation and execution (the harness invokes a native test contract,
/// not the uploaded Wasm), and transaction-size fees. Both are constant per
/// entry point, so they shift every row equally.
#[test]
fn cost_report_hot_paths() {
    println!();
    println!("| Entry point        | insns     | mem B    | r-ents | w-ents  | ldg B   | evt B   | fee*    | rent     |");
    println!("| ------------------ | --------- | -------- | ------ | ------- | ------- | ------- | ------- | -------- |");
    println!("(*fee excluding rent, in stroops: instructions + entries + bytes + events)");

    // Note the ordering rule this report depends on: the host meters the
    // *outermost* invocation only, so a row must be read immediately after the
    // call it describes. Any intervening contract call — including a token
    // `balance` read in an assertion — becomes the metered invocation instead,
    // and the row silently describes that call. Hence: measure, then assert.

    // 1. create_transfer: compliance gate + volume commit + token pull + writes.
    {
        let f = setup();
        let sender = Address::generate(&f.env);
        fund(&f, &sender, 10_000);
        attest_sender(&f, &sender);
        let id = create(&f, &sender);
        cost_row!("create_transfer", f.env);
        assert_eq!(
            f.escrow.get_transfer(&id).unwrap().status,
            TransferStatus::Pending
        );
    }

    // 2. claim_transfer: sha256 + registry call + two token transfers + write.
    {
        let f = setup();
        let sender = Address::generate(&f.env);
        fund(&f, &sender, 10_000);
        attest_sender(&f, &sender);
        let agent = onboard_agent(&f, 5_000);
        let id = create(&f, &sender);
        f.escrow
            .claim_transfer(&agent, &id, &BytesN::from_array(&f.env, &CLAIM_CODE));
        cost_row!("claim_transfer", f.env);
        let fee = AMOUNT * i128::from(FEE_BPS) / 10_000;
        // The agent's bond is held by the registry, so what it holds now is the
        // payout alone. The fee must have gone to the treasury, not stayed here.
        assert_eq!(balance(&f, &agent), AMOUNT - fee);
        assert_eq!(balance(&f, &f.treasury), fee);
    }

    // 3. refund_expired: permissionless, one token transfer, one write.
    {
        let f = setup();
        let sender = Address::generate(&f.env);
        fund(&f, &sender, 10_000);
        attest_sender(&f, &sender);
        let id = create(&f, &sender);
        f.env.ledger().set_timestamp(now(&f) + 8 * DAY);
        f.escrow.refund_expired(&id);
        cost_row!("refund_expired", f.env);
        assert_eq!(balance(&f, &sender), 10_000);
    }

    // 4. cancel_transfer: sender-authenticated, one token transfer, one write.
    {
        let f = setup();
        let sender = Address::generate(&f.env);
        fund(&f, &sender, 10_000);
        attest_sender(&f, &sender);
        let id = create(&f, &sender);
        f.escrow.cancel_transfer(&sender, &id);
        cost_row!("cancel_transfer", f.env);
        assert_eq!(balance(&f, &sender), 10_000);
    }

    // 5. The read every claim starts from: instance config plus one record, and
    // no writes at all.
    {
        let f = setup();
        let sender = Address::generate(&f.env);
        fund(&f, &sender, 10_000);
        attest_sender(&f, &sender);
        let id = create(&f, &sender);
        let transfer = f.escrow.get_transfer(&id);
        cost_row!("get_transfer", f.env);
        assert!(transfer.is_some());
    }

    // 6. quote_claim: what the agent app calls before it counts out cash.
    {
        let f = setup();
        let sender = Address::generate(&f.env);
        fund(&f, &sender, 10_000);
        attest_sender(&f, &sender);
        let id = create(&f, &sender);
        let quote = f.escrow.quote_claim(&id);
        cost_row!("quote_claim", f.env);
        assert_eq!(quote.payout, AMOUNT - AMOUNT * i128::from(FEE_BPS) / 10_000);
    }

    // 7. A row with nothing else on the call stack, as a reference point for
    // what the floor looks like.
    {
        let f = setup();
        let _ = f.escrow.transfer_count();
        cost_row!("transfer_count", f.env);
    }
    println!();
}
