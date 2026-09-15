use soroban_sdk::contracterror;

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
