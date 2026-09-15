use soroban_sdk::{contracttype, Address, BytesN, Symbol};

/// Verification depth a sender has reached.
///
/// Tiers are ordered, and the ordering is expressed through [`KycTier::rank`]
/// rather than a derived `Ord` so the on-chain representation (a `u32` tag) and
/// the business ordering can never drift apart.
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

/// Result of [`crate::ComplianceHookInterface::explain_transfer`].
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
    /// Machine-readable reason tag; see [`crate::ComplianceError`] variants.
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
