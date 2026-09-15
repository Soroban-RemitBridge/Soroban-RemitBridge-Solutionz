//! Compliance domain types.
//!
//! Defined in `remit-interfaces` so the escrow, the backend and the admin
//! console decode exactly the same structs the contract writes.

pub use remit_interfaces::compliance::{
    Attestation, ComplianceStats, KycTier, TierThresholds, TransferDecision,
};
