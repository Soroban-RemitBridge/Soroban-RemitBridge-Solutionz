//! Test suite for the compliance gate.
//!
//! The tests concentrate on the boundaries where money and regulation meet: the
//! exact amounts at which a tier flips, the moment an attestation expires, and
//! the cumulative structuring case that a purely per-transfer rule would miss.

use soroban_sdk::{
    contract, contractimpl, symbol_short,
    testutils::{Address as _, Ledger as _, MockAuth, MockAuthInvoke},
    Address, BytesN, Env, IntoVal, Symbol,
};

use crate::types::ComplianceStats;
use crate::{
    Attestation, ComplianceError, ComplianceHook, ComplianceHookClient, KycTier, TierThresholds,
    TransferDecision,
};

fn corridor() -> Symbol {
    symbol_short!("NGN_LAG")
}

fn region() -> Symbol {
    symbol_short!("NG_LAG")
}

const DAY: u64 = 86_400;

/// A stand-in for `RemitEscrow` that does nothing but call `commit_transfer`.
///
/// Using a real second contract (rather than mocking auth) is what makes the
/// escrow-only gate testable: the hook sees this contract as its direct
/// invoker, which is exactly the condition the production escrow relies on.
#[contract]
pub struct MockEscrow;

#[contractimpl]
impl MockEscrow {
    pub fn commit(env: Env, hook: Address, sender: Address, amount: i128, corridor_id: Symbol) {
        ComplianceHookClient::new(&env, &hook).commit_transfer(&sender, &amount, &corridor_id);
    }

    pub fn check(env: Env, hook: Address, sender: Address, amount: i128, corridor_id: Symbol) {
        ComplianceHookClient::new(&env, &hook).check_transfer_allowed(&sender, &amount, &corridor_id);
    }
}

struct Fixture {
    env: Env,
    client: ComplianceHookClient<'static>,
    admin: Address,
    attester: Address,
    /// Address of the deployed `ComplianceHook`, needed when a test drives the
    /// gate through the escrow stand-in.
    hook: Address,
    escrow: Address,
}

fn thresholds() -> TierThresholds {
    TierThresholds {
        corridor_id: corridor(),
        tier1_max: 100,
        tier2_max: 1_000,
        daily_limit: 5_000,
    }
}

fn hash(env: &Env, seed: u8) -> BytesN<32> {
    BytesN::from_array(env, &[seed; 32])
}

fn setup() -> Fixture {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let attester = Address::generate(&env);
    let escrow = env.register(MockEscrow, ());

    let contract_id = env.register(ComplianceHook, ());
    let client = ComplianceHookClient::new(&env, &contract_id);
    client.initialize(&admin);
    client.set_operator(&attester, &true);
    client.set_escrow(&escrow);
    client.set_tier_thresholds(&thresholds());

    Fixture {
        env,
        client,
        admin,
        attester,
        hook: contract_id,
        escrow,
    }
}

fn attest(f: &Fixture, subject: &Address, tier: KycTier, ttl_days: u64) {
    let expires_at = f.env.ledger().timestamp() + ttl_days * DAY;
    f.client.publish_attestation(
        &f.attester,
        subject,
        &tier,
        &hash(&f.env, 7),
        &region(),
        &symbol_short!("mock"),
        &expires_at,
    );
}

/* ------------------------------------------------------------------ */
/* configuration                                                       */
/* ------------------------------------------------------------------ */

#[test]
fn initialize_is_not_repeatable() {
    let f = setup();
    assert_eq!(
        f.client.try_initialize(&f.admin),
        Err(Ok(ComplianceError::AlreadyInitialized))
    );
}

#[test]
fn inverted_tier_bands_are_rejected() {
    let f = setup();
    let bad = TierThresholds {
        corridor_id: symbol_short!("BAD"),
        tier1_max: 1_000,
        tier2_max: 100,
        daily_limit: 5_000,
    };
    assert_eq!(
        f.client.try_set_tier_thresholds(&bad),
        Err(Ok(ComplianceError::InvalidThresholds))
    );
}

#[test]
fn daily_limit_below_the_top_tier_is_rejected() {
    let f = setup();
    // A corridor where a single top-tier transfer could never be sent is not
    // "strict", it is unusable — reject it at configuration time.
    let bad = TierThresholds {
        corridor_id: symbol_short!("BAD"),
        tier1_max: 100,
        tier2_max: 10_000,
        daily_limit: 5_000,
    };
    assert_eq!(
        f.client.try_set_tier_thresholds(&bad),
        Err(Ok(ComplianceError::InvalidThresholds))
    );
}

#[test]
fn unknown_corridor_is_rejected_by_the_gate() {
    let f = setup();
    let sender = Address::generate(&f.env);
    assert_eq!(
        f.client
            .try_check_transfer_allowed(&sender, &10, &symbol_short!("NOPE")),
        Err(Ok(ComplianceError::UnknownCorridor))
    );
}

#[test]
fn pause_blocks_every_transfer_in_every_corridor() {
    let f = setup();
    let sender = Address::generate(&f.env);
    f.client.set_paused(&true);

    assert_eq!(
        f.client.try_check_transfer_allowed(&sender, &10, &corridor()),
        Err(Ok(ComplianceError::TransfersPaused))
    );
    // Reads keep working so the console can explain the outage.
    assert!(f.client.get_tier_thresholds(&corridor()).is_some());

    f.client.set_paused(&false);
    assert!(f
        .client
        .check_transfer_allowed(&sender, &10, &corridor()));
}

#[test]
fn only_listed_attesters_may_publish() {
    let f = setup();
    let stranger = Address::generate(&f.env);
    let subject = Address::generate(&f.env);
    let expires_at = f.env.ledger().timestamp() + DAY;

    assert_eq!(
        f.client.try_publish_attestation(
            &stranger,
            &subject,
            &KycTier::Standard,
            &hash(&f.env, 1),
            &region(),
            &symbol_short!("mock"),
            &expires_at,
        ),
        Err(Ok(ComplianceError::NotAnAttester))
    );
}

#[test]
fn expired_or_past_expiry_attestations_are_rejected_at_write_time() {
    let f = setup();
    let subject = Address::generate(&f.env);
    f.env.ledger().set_timestamp(DAY);
    assert_eq!(
        f.client.try_publish_attestation(
            &f.attester,
            &subject,
            &KycTier::Standard,
            &hash(&f.env, 1),
            &region(),
            &symbol_short!("mock"),
            &DAY,
        ),
        Err(Ok(ComplianceError::InvalidExpiry))
    );
}

/* ------------------------------------------------------------------ */
/* tier boundaries                                                     */
/* ------------------------------------------------------------------ */

#[test]
fn tier_bands_flip_exactly_at_the_configured_amounts() {
    let t = thresholds();
    assert_eq!(t.required_tier(1), KycTier::None);
    assert_eq!(t.required_tier(100), KycTier::None);
    assert_eq!(t.required_tier(101), KycTier::Standard);
    assert_eq!(t.required_tier(1_000), KycTier::Standard);
    assert_eq!(t.required_tier(1_001), KycTier::Enhanced);
}

#[test]
fn small_transfers_pass_with_no_verification_at_all() {
    let f = setup();
    let sender = Address::generate(&f.env);

    assert!(f.client.check_transfer_allowed(&sender, &100, &corridor()));

    let decision = f.client.explain_transfer(&sender, &100, &corridor());
    assert!(decision.allowed);
    assert_eq!(decision.required_tier, KycTier::None);
    assert_eq!(decision.reason, symbol_short!("ok"));
    assert_eq!(decision.remaining_daily, 4_900);
}

#[test]
fn mid_tier_transfer_without_attestation_is_refused() {
    let f = setup();
    let sender = Address::generate(&f.env);
    assert_eq!(
        f.client.try_check_transfer_allowed(&sender, &101, &corridor()),
        Err(Ok(ComplianceError::AttestationMissing))
    );

    let decision = f.client.explain_transfer(&sender, &101, &corridor());
    assert!(!decision.allowed);
    assert_eq!(decision.required_tier, KycTier::Standard);
    assert_eq!(decision.held_tier, KycTier::None);
    assert_eq!(decision.reason, symbol_short!("kyc_need"));
}

#[test]
fn standard_attestation_unlocks_the_mid_band_only() {
    let f = setup();
    let sender = Address::generate(&f.env);
    attest(&f, &sender, KycTier::Standard, 30);

    assert!(f
        .client
        .check_transfer_allowed(&sender, &500, &corridor()));

    assert_eq!(
        f.client.try_check_transfer_allowed(&sender, &1_001, &corridor()),
        Err(Ok(ComplianceError::TierTooLow))
    );
    let decision = f.client.explain_transfer(&sender, &1_001, &corridor());
    assert_eq!(decision.required_tier, KycTier::Enhanced);
    assert_eq!(decision.held_tier, KycTier::Standard);
    assert_eq!(decision.reason, symbol_short!("tier_low"));
}

#[test]
fn enhanced_attestation_unlocks_the_top_band() {
    let f = setup();
    let sender = Address::generate(&f.env);
    attest(&f, &sender, KycTier::Enhanced, 30);
    assert!(f
        .client
        .check_transfer_allowed(&sender, &1_001, &corridor()));
}

#[test]
fn attestation_expiry_closes_the_gate() {
    let f = setup();
    let sender = Address::generate(&f.env);
    attest(&f, &sender, KycTier::Standard, 1);
    assert!(f.client.check_transfer_allowed(&sender, &500, &corridor()));

    // Step past the validity window.
    f.env.ledger().set_timestamp(2 * DAY);
    assert_eq!(
        f.client.try_check_transfer_allowed(&sender, &500, &corridor()),
        Err(Ok(ComplianceError::AttestationExpired))
    );
}

#[test]
fn a_revoked_attestation_blocks_even_an_otherwise_unverified_transfer() {
    let f = setup();
    let sender = Address::generate(&f.env);
    attest(&f, &sender, KycTier::Enhanced, 30);
    assert!(f.client.check_transfer_allowed(&sender, &100, &corridor()));

    f.client
        .revoke_attestation(&f.attester, &sender, &symbol_short!("sanction"));

    // Even the no-verification band is closed: a revocation is a sanctions or
    // fraud signal, not a downgrade to "unverified".
    assert_eq!(
        f.client.try_check_transfer_allowed(&sender, &100, &corridor()),
        Err(Ok(ComplianceError::AttestationRevoked))
    );
}

#[test]
fn an_expired_attestation_does_not_block_the_unverified_band() {
    let f = setup();
    let sender = Address::generate(&f.env);
    attest(&f, &sender, KycTier::Standard, 1);
    f.env.ledger().set_timestamp(2 * DAY);

    // Small transfers stay available to a lapsed sender — the alternative would
    // lock people out of the corridor entirely while they re-verify.
    assert!(f.client.check_transfer_allowed(&sender, &100, &corridor()));
}

#[test]
fn revocation_is_idempotent_and_counted_once() {
    let f = setup();
    let sender = Address::generate(&f.env);
    attest(&f, &sender, KycTier::Standard, 30);

    f.client
        .revoke_attestation(&f.attester, &sender, &symbol_short!("sanction"));
    f.client
        .revoke_attestation(&f.attester, &sender, &symbol_short!("sanction"));

    assert_eq!(
        f.client.compliance_stats(),
        ComplianceStats {
            attestations_issued: 1,
            attestations_revoked: 1,
            transfers_committed: 0,
            enhanced_tier_transfers: 0,
        }
    );
}

#[test]
fn revocation_requires_an_existing_attestation() {
    let f = setup();
    let stranger = Address::generate(&f.env);
    assert_eq!(
        f.client
            .try_revoke_attestation(&f.attester, &stranger, &symbol_short!("sanction")),
        Err(Ok(ComplianceError::AttestationMissing))
    );
}

/* ------------------------------------------------------------------ */
/* rolling daily volume                                                */
/* ------------------------------------------------------------------ */

#[test]
fn commit_requires_a_registered_escrow() {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let contract_id = env.register(ComplianceHook, ());
    let client = ComplianceHookClient::new(&env, &contract_id);
    client.initialize(&admin);

    let sender = Address::generate(&env);
    assert_eq!(
        client.try_commit_transfer(&sender, &10, &corridor()),
        Err(Ok(ComplianceError::EscrowNotSet))
    );
}

#[test]
fn commits_accumulate_into_the_daily_bucket() {
    let f = setup();
    let sender = Address::generate(&f.env);
    f.env.ledger().set_timestamp(DAY);

    f.client.commit_transfer(&sender, &100, &corridor());
    let total = f.client.commit_transfer(&sender, &250, &corridor());

    assert_eq!(total, 350);
    assert_eq!(f.client.daily_volume(&sender, &corridor(), &1), 350);
    assert_eq!(f.client.compliance_stats().transfers_committed, 2);

    // The next day starts with a clean bucket.
    assert_eq!(f.client.daily_volume(&sender, &corridor(), &2), 0);
}

#[test]
fn commits_are_isolated_per_sender_and_per_corridor() {
    let f = setup();
    let a = Address::generate(&f.env);
    let b = Address::generate(&f.env);
    f.client.commit_transfer(&a, &100, &corridor());

    assert_eq!(f.client.daily_volume(&a, &corridor(), &0), 100);
    assert_eq!(f.client.daily_volume(&b, &corridor(), &0), 0);
}

#[test]
fn structuring_many_small_transfers_still_hits_the_daily_ceiling() {
    let f = setup();
    let sender = Address::generate(&f.env);

    // 50 × 100 = 5_000, every one of them individually below the
    // no-verification band, and collectively exactly the daily ceiling.
    for _ in 0..50 {
        assert!(f.client.check_transfer_allowed(&sender, &100, &corridor()));
        f.client.commit_transfer(&sender, &100, &corridor());
    }

    assert_eq!(f.client.daily_volume(&sender, &corridor(), &0), 5_000);
    assert_eq!(
        f.client.try_check_transfer_allowed(&sender, &100, &corridor()),
        Err(Ok(ComplianceError::DailyLimitExceeded))
    );
    // The write path enforces the ceiling too, not just the read path.
    assert_eq!(
        f.client.try_commit_transfer(&sender, &100, &corridor()),
        Err(Ok(ComplianceError::DailyLimitExceeded))
    );
}

#[test]
fn non_positive_amounts_are_refused() {
    let f = setup();
    let sender = Address::generate(&f.env);
    assert_eq!(
        f.client.try_check_transfer_allowed(&sender, &0, &corridor()),
        Err(Ok(ComplianceError::InvalidAmount))
    );
    assert_eq!(
        f.client.try_check_transfer_allowed(&sender, &-1, &corridor()),
        Err(Ok(ComplianceError::InvalidAmount))
    );
}

/* ------------------------------------------------------------------ */
/* escrow-only commit path                                             */
/* ------------------------------------------------------------------ */

#[test]
fn the_escrow_contract_can_commit_volume_for_a_sender() {
    let f = setup();
    let sender = Address::generate(&f.env);

    // The escrow contract is the caller, so the hook sees it as its direct
    // invoker and accepts the commit.
    MockEscrowClient::new(&f.env, &f.escrow).commit(&f.hook, &sender, &100, &corridor());
    assert_eq!(f.client.daily_volume(&sender, &corridor(), &0), 100);
}

#[test]
fn a_stranger_cannot_commit_volume_against_a_senders_limit() {
    // No blanket auth mocking here: this test is specifically about the
    // authorization tree, and `mock_all_auths` would make it vacuous.
    let env = Env::default();
    let admin = Address::generate(&env);
    let escrow = env.register(MockEscrow, ());
    let contract_id = env.register(ComplianceHook, ());
    let client = ComplianceHookClient::new(&env, &contract_id);

    env.mock_auths(&[MockAuth {
        address: &admin,
        invoke: &MockAuthInvoke {
            contract: &contract_id,
            fn_name: "initialize",
            args: (&admin,).into_val(&env),
            sub_invokes: &[],
        },
    }]);
    client.initialize(&admin);

    env.mock_auths(&[MockAuth {
        address: &admin,
        invoke: &MockAuthInvoke {
            contract: &contract_id,
            fn_name: "set_escrow",
            args: (&escrow,).into_val(&env),
            sub_invokes: &[],
        },
    }]);
    client.set_escrow(&escrow);

    env.mock_auths(&[MockAuth {
        address: &admin,
        invoke: &MockAuthInvoke {
            contract: &contract_id,
            fn_name: "set_tier_thresholds",
            args: (thresholds(),).into_val(&env),
            sub_invokes: &[],
        },
    }]);
    client.set_tier_thresholds(&thresholds());

    // A direct call by anyone other than the registered escrow cannot satisfy
    // `escrow.require_auth()`.
    let stranger = Address::generate(&env);
    assert!(client.try_commit_transfer(&stranger, &100, &corridor()).is_err());
    assert_eq!(client.daily_volume(&stranger, &corridor(), &0), 0);
}

/* ------------------------------------------------------------------ */
/* reads                                                               */
/* ------------------------------------------------------------------ */

#[test]
fn attestations_round_trip_without_leaking_pii() {
    let f = setup();
    let subject = Address::generate(&f.env);
    attest(&f, &subject, KycTier::Enhanced, 90);

    let record: Attestation = f.client.get_attestation(&subject).unwrap();
    assert_eq!(record.tier, KycTier::Enhanced);
    assert_eq!(record.provider_id, symbol_short!("mock"));
    assert_eq!(record.attestation_hash, hash(&f.env, 7));
    assert!(!record.revoked);
    assert!(record.expires_at > record.issued_at);
}

#[test]
fn refreshed_attestations_do_not_inflate_the_issued_counter() {
    let f = setup();
    let subject = Address::generate(&f.env);
    attest(&f, &subject, KycTier::Standard, 30);
    attest(&f, &subject, KycTier::Enhanced, 30);

    assert_eq!(f.client.compliance_stats().attestations_issued, 1);
    assert_eq!(
        f.client.get_attestation(&subject).unwrap().tier,
        KycTier::Enhanced
    );
}

#[test]
fn explain_transfer_never_errors_for_an_unknown_corridor() {
    let f = setup();
    let sender = Address::generate(&f.env);
    let decision: TransferDecision =
        f.client.explain_transfer(&sender, &10, &symbol_short!("NOPE"));
    assert!(!decision.allowed);
    assert_eq!(decision.reason, symbol_short!("no_corr"));
}

#[test]
fn corridors_are_listed_after_configuration() {
    let f = setup();
    let list = f.client.list_corridors();
    assert_eq!(list.len(), 1);
    assert_eq!(list.get(0).unwrap(), corridor());
}

/* ------------------------------------------------------------------ */
/* authority                                                           */
/* ------------------------------------------------------------------ */

/// The hook owns the pause switch, every corridor's tier bands and the attester
/// allowlist. The separate-attester-key design rests entirely on all three being
/// admin-only: if a hot attester key could reach any of them, then compromising
/// the most externally exposed process in the system -- the one that accepts
/// document uploads and third-party webhooks -- would also hand over the gate.
///
/// No blanket auth mocking here, deliberately. `mock_all_auths` would make this
/// test vacuous, because the whole question is whether the authorization tree
/// can be satisfied by the wrong signer.
#[test]
fn only_the_admin_can_reconfigure_the_gate() {
    let env = Env::default();
    let admin = Address::generate(&env);
    let attester = Address::generate(&env);
    let attacker = Address::generate(&env);
    let escrow = env.register(MockEscrow, ());

    let contract_id = env.register(ComplianceHook, ());
    let client = ComplianceHookClient::new(&env, &contract_id);

    env.mock_auths(&[MockAuth {
        address: &admin,
        invoke: &MockAuthInvoke {
            contract: &contract_id,
            fn_name: "initialize",
            args: (&admin,).into_val(&env),
            sub_invokes: &[],
        },
    }]);
    client.initialize(&admin);

    // Each call is signed by the attacker. The contract calls `require_auth` on
    // the stored admin address instead, so the invocation's own signature is
    // irrelevant and `require_auth` cannot be satisfied.
    env.mock_auths(&[MockAuth {
        address: &attacker,
        invoke: &MockAuthInvoke {
            contract: &contract_id,
            fn_name: "set_operator",
            args: (&attester, &true).into_val(&env),
            sub_invokes: &[],
        },
    }]);
    assert!(client.try_set_operator(&attester, &true).is_err());

    env.mock_auths(&[MockAuth {
        address: &attacker,
        invoke: &MockAuthInvoke {
            contract: &contract_id,
            fn_name: "set_tier_thresholds",
            args: (thresholds(),).into_val(&env),
            sub_invokes: &[],
        },
    }]);
    assert!(client.try_set_tier_thresholds(&thresholds()).is_err());

    env.mock_auths(&[MockAuth {
        address: &attacker,
        invoke: &MockAuthInvoke {
            contract: &contract_id,
            fn_name: "set_escrow",
            args: (&escrow,).into_val(&env),
            sub_invokes: &[],
        },
    }]);
    assert!(client.try_set_escrow(&escrow).is_err());

    env.mock_auths(&[MockAuth {
        address: &attacker,
        invoke: &MockAuthInvoke {
            contract: &contract_id,
            fn_name: "set_paused",
            args: (&true,).into_val(&env),
            sub_invokes: &[],
        },
    }]);
    assert!(client.try_set_paused(&true).is_err());

    // None of it took effect. Assertions on state, not just on the return
    // values: a refusal that still wrote something is the failure mode that
    // matters here.
    assert_eq!(client.list_corridors().len(), 0);
    assert!(client.get_attestation(&attester).is_none());

    // And the attacker gained no publishing rights by trying. Asserted as "no
    // record was written" rather than as one specific error: whether the call
    // fails on the allowlist or on the missing signature is an implementation
    // detail, but a written attestation would not be.
    let expires_at = env.ledger().timestamp() + 30 * DAY;
    assert!(client
        .try_publish_attestation(
            &attacker,
            &attester,
            &KycTier::Standard,
            &hash(&env, 3),
            &region(),
            &symbol_short!("mock"),
            &expires_at,
        )
        .is_err());
    assert!(client.get_attestation(&attester).is_none());
}

/// Revoking the hot key has to be a real cut-off, in both directions of its
/// authority. The failure mode this guards against is an allowlist that is
/// consulted on publish but not on revoke, which would leave a compromised key
/// able to withdraw evidence of its own misuse.
#[test]
fn revoking_an_attester_closes_both_writes() {
    let f = setup();
    let subject = Address::generate(&f.env);
    attest(&f, &subject, KycTier::Standard, 30);

    f.client.set_operator(&f.attester, &false);

    let expires_at = f.env.ledger().timestamp() + 30 * DAY;
    assert_eq!(
        f.client.try_publish_attestation(
            &f.attester,
            &subject,
            &KycTier::Enhanced,
            &hash(&f.env, 9),
            &region(),
            &symbol_short!("mock"),
            &expires_at,
        ),
        Err(Ok(ComplianceError::NotAnAttester))
    );
    assert_eq!(
        f.client
            .try_revoke_attestation(&f.attester, &subject, &symbol_short!("fraud")),
        Err(Ok(ComplianceError::NotAnAttester))
    );

    // The verdict it published while authorized survives, unrevoked. Losing the
    // key is not itself a sanctions decision, so it must not silently invalidate
    // a verdict the operator accepted -- or silently revoke one it did not.
    assert!(!f.client.get_attestation(&subject).unwrap().revoked);

    // Re-granting restores exactly the authority that was taken away. The grant
    // is one flag, not a re-registration, so the existing record is untouched.
    f.client.set_operator(&f.attester, &true);
    assert!(f
        .client
        .try_revoke_attestation(&f.attester, &subject, &symbol_short!("fraud"))
        .is_ok());
    assert!(f.client.get_attestation(&subject).unwrap().revoked);
}
