//! Compliance hook interface: tiering types, error taxonomy and the generated
//! client.

use soroban_sdk::{contractclient, contracterror, contracttype, Address, BytesN, Env, Symbol, Vec};

/* ------------------------------------------------------------------ */
/* types                                                               */
/* ------------------------------------------------------------------ */

/// Verification depth a sender has reached.
///
/// Tiers are ordered, and the ordering is expressed through [`KycTier::rank`]
/// rather than a derived `Ord` so the on-chain `u32` tag and the business
/// ordering can never drift apart.
#[contracttype]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum KycTier {
    /// No attestation required. Small transfers only.
    None,
    /// Government-ID-grade verification held by the backend.
    Standard,
    /// Standard plus enhanced due diligence (source of funds, screening).
    Enhanced,
}

impl KycTier {
    pub fn rank(self) -> u32 {
        match self {
            KycTier::None => 0,
            KycTier::Standard => 1,
            KycTier::Enhanced => 2,
        }
    }

    /// Whether an attestation at `self` clears a `required` tier.
    pub fn satisfies(self, required: KycTier) -> bool {
        self.rank() >= required.rank()
    }

    pub fn from_rank(rank: u32) -> KycTier {
        match rank {
            0 => KycTier::None,
            1 => KycTier::Standard,
            _ => KycTier::Enhanced,
        }
    }
}

/// Per-corridor tiering rules, set by the anchor operator.
///
/// The bands are expressed on the *transfer* amount, not on cumulative volume,
/// because the sender-facing UX ("this transfer needs ID") is per-transfer. The
/// cumulative control is [`TierThresholds::daily_limit`].
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TierThresholds {
    pub corridor_id: Symbol,
    /// Amount at or below which no attestation is required.
    pub tier1_max: i128,
    /// Amount at or below which a `Standard` attestation suffices; above it,
    /// `Enhanced` is required.
    pub tier2_max: i128,
    /// Rolling daily ceiling per sender, in the corridor's settlement asset.
    /// Enforced across transfers, unlike the per-transfer tier bands above.
    pub daily_limit: i128,
}

impl TierThresholds {
    /// Tier a transfer of `amount` requires in this corridor.
    pub fn required_tier(&self, amount: i128) -> KycTier {
        if amount <= self.tier1_max {
            KycTier::None
        } else if amount <= self.tier2_max {
            KycTier::Standard
        } else {
            KycTier::Enhanced
        }
    }

    /// Structural validation, enforced on every write.
    ///
    /// Rejects the configurations that would silently weaken the gate: negative
    /// bands, an inverted `tier1_max`/`tier2_max` pair, and a daily limit that
    /// cannot accommodate even one top-tier transfer (which would make the
    /// corridor impossible to use rather than merely strict).
    pub fn is_valid(&self) -> bool {
        self.tier1_max >= 0
            && self.tier2_max >= self.tier1_max
            && self.daily_limit > 0
            && self.daily_limit >= self.tier2_max
    }
}

/// A verification result, held on-chain **by hash only**.
///
/// The document that proves who the sender is — passport scan, proof-of-address,
/// screening output — never touches the ledger. This record stores a hash of the
/// backend's signed verdict plus the metadata needed to reason about it: which
/// tier, which provider, when it expires. Any auditor who needs the underlying
/// record is routed to the backend, where access control and retention rules
/// apply.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Attestation {
    pub subject: Address,
    pub tier: KycTier,
    /// `sha256` of the backend's signed attestation payload.
    pub attestation_hash: BytesN<32>,
    /// Region the verification was performed for.
    pub region_id: Symbol,
    /// Which provider issued it (`mock`, `sumsub`, `onfido`, ...) so a provider
    /// migration is visible in the event history rather than silent.
    pub provider_id: Symbol,
    pub issued_at: u64,
    pub expires_at: u64,
    pub revoked: bool,
}

impl Attestation {
    pub fn is_live(&self, now: u64) -> bool {
        !self.revoked && self.expires_at > now
    }
}

/// Result of `ComplianceHook::explain_transfer`.
///
/// Exists so the sender app and the admin console can render "why" a transfer
/// needs more verification without re-implementing the tiering rules off-chain
/// and drifting from the contract.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TransferDecision {
    pub allowed: bool,
    pub required_tier: KycTier,
    pub held_tier: KycTier,
    /// Machine-readable reason tag; see the compliance hook's `reason_tag`.
    pub reason: Symbol,
    /// Remaining daily headroom after this transfer, or `0` when refused.
    pub remaining_daily: i128,
}

/// Aggregate counters for the operator compliance dashboard.
#[contracttype]
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct ComplianceStats {
    pub attestations_issued: u32,
    pub attestations_revoked: u32,
    pub transfers_committed: u32,
    pub enhanced_tier_transfers: u32,
}

/* ------------------------------------------------------------------ */
/* errors                                                              */
/* ------------------------------------------------------------------ */

/// Failure modes of the compliance gate.
///
/// Every refusal carries a distinct variant because the sender-facing app turns
/// them into different journeys: `AttestationMissing` opens the verification
/// flow, `DailyLimitExceeded` suggests splitting the transfer, `TierTooLow`
/// routes to enhanced due diligence, and `TransfersPaused` is a corridor-wide
/// outage the sender cannot fix.
#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum ComplianceError {
    NotInitialized = 1,
    AlreadyInitialized = 2,
    /// Caller is not the anchor operator key.
    Unauthorized = 3,
    /// Caller is not an address the operator has granted attestation rights to.
    NotAnAttester = 4,
    /// Caller is not the registered escrow contract.
    NotEscrow = 5,
    /// Amount was zero or negative.
    InvalidAmount = 6,
    /// Corridor has no tier configuration.
    UnknownCorridor = 7,
    /// Thresholds failed structural validation.
    InvalidThresholds = 8,
    /// Compliance enforcement is paused for the whole contract.
    TransfersPaused = 9,
    /// No attestation exists for this sender.
    AttestationMissing = 10,
    /// Attestation exists but its validity window has closed.
    AttestationExpired = 11,
    /// Attestation was explicitly revoked (sanctions hit, suspected fraud).
    AttestationRevoked = 12,
    /// Sender's verified tier is below what the amount requires.
    TierTooLow = 13,
    /// Committing the transfer would breach the sender's rolling daily limit.
    DailyLimitExceeded = 14,
    /// Attestation expiry must be in the future.
    InvalidExpiry = 15,
    /// Arithmetic overflowed `i128`.
    Overflow = 16,
    /// No escrow contract has been registered yet.
    EscrowNotSet = 17,
}

/* ------------------------------------------------------------------ */
/* interface                                                           */
/* ------------------------------------------------------------------ */

/// Public interface of the compliance hook.
///
/// `#[contractclient]` generates `ComplianceHookClient`, which is what
/// `RemitEscrow` calls. Because the escrow depends on this shared crate rather
/// than on the hook's implementation crate, the escrow's Wasm never links the
/// hook's entry points.
#[contractclient(name = "ComplianceHookClient")]
pub trait ComplianceHookInterface {
    /* ---------------- admin ---------------- */

    /// One-time setup with the anchor operator key.
    fn initialize(env: Env, admin: Address) -> Result<(), ComplianceError>;

    /// Grant or revoke a backend key's right to publish attestations.
    ///
    /// This is deliberately separate from the admin key: the compliance service
    /// runs hot and is the most exposed component, so it must not be able to
    /// reconfigure thresholds or unpause the network.
    fn set_operator(env: Env, operator: Address, allowed: bool) -> Result<(), ComplianceError>;

    /// Register (or rotate) the single escrow contract allowed to commit volume.
    fn set_escrow(env: Env, escrow: Address) -> Result<(), ComplianceError>;

    /// Emergency stop for *all* corridors. Reads still work so the console can
    /// explain the outage.
    fn set_paused(env: Env, paused: bool) -> Result<(), ComplianceError>;

    /// Create or replace a corridor's tier bands.
    fn set_tier_thresholds(env: Env, thresholds: TierThresholds) -> Result<(), ComplianceError>;

    fn get_tier_thresholds(env: Env, corridor_id: Symbol) -> Option<TierThresholds>;

    fn list_corridors(env: Env) -> Vec<Symbol>;

    /* ---------------- attestations ---------------- */

    /// Publish a verification result for `subject`.
    ///
    /// `attester` is passed explicitly (rather than inferred) so the contract can
    /// check it against the operator allowlist *and* call `require_auth` on it,
    /// making the authorization tree self-documenting in the transaction.
    fn publish_attestation(
        env: Env,
        attester: Address,
        subject: Address,
        tier: KycTier,
        attestation_hash: BytesN<32>,
        region_id: Symbol,
        provider_id: Symbol,
        expires_at: u64,
    ) -> Result<(), ComplianceError>;

    /// Revoke a subject's attestation (sanctions hit, chargeback, fraud).
    fn revoke_attestation(
        env: Env,
        attester: Address,
        subject: Address,
        reason: Symbol,
    ) -> Result<(), ComplianceError>;

    fn get_attestation(env: Env, subject: Address) -> Option<Attestation>;

    /* ---------------- the gate ---------------- */

    /// Whether a transfer of `amount` from `sender` may proceed in `corridor_id`.
    ///
    /// Pure: performs no writes, so it is safe to call from a read-only
    /// simulation, from the sender app to preflight an amount, and from the
    /// escrow before it locks funds.
    ///
    /// Returns `Ok(true)` when allowed, and a typed error identifying exactly
    /// which rule refused it otherwise. `Ok(false)` is reserved for a future
    /// "allowed pending manual review" outcome and is not produced in v1.
    fn check_transfer_allowed(
        env: Env,
        sender: Address,
        amount: i128,
        corridor_id: Symbol,
    ) -> Result<bool, ComplianceError>;

    /// Non-failing companion to [`Self::check_transfer_allowed`] for UIs.
    fn explain_transfer(
        env: Env,
        sender: Address,
        amount: i128,
        corridor_id: Symbol,
    ) -> TransferDecision;

    /// Commit a checked transfer's amount to the sender's rolling daily bucket.
    ///
    /// Split from the check so the escrow can perform reserve → commit inside one
    /// atomic transaction: the check decides, the commit records, and a failure
    /// in either reverts the whole transfer.
    fn commit_transfer(
        env: Env,
        sender: Address,
        amount: i128,
        corridor_id: Symbol,
    ) -> Result<i128, ComplianceError>;

    fn daily_volume(env: Env, sender: Address, corridor_id: Symbol, day: u64) -> i128;

    fn compliance_stats(env: Env) -> ComplianceStats;
}
