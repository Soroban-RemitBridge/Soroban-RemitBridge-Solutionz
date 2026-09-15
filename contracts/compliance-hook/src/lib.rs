#![no_std]
#![deny(clippy::all)]
#![warn(clippy::pedantic)]
#![allow(clippy::needless_pass_by_value)]
#![allow(clippy::too_many_arguments)]
#![allow(clippy::missing_errors_doc)]
#![allow(clippy::missing_panics_doc)]
#![allow(clippy::module_name_repetitions)]
#![allow(clippy::must_use_candidate)]
#![allow(clippy::doc_markdown)]
#![allow(clippy::cast_possible_truncation)]

//! # RemitBridge — Compliance Hook
//!
//! The tiered KYC/AML gate that `RemitEscrow` consults *before* it locks any
//! sender funds. Splitting this out of the escrow is the whole point: the
//! value-moving contract stays small and auditable, and compliance rules that
//! change far more often (per corridor, per regulator) can be reconfigured —
//! or, in a future version, swapped for a different contract at the escrow's
//! `set_compliance_hook` — without touching custody logic.
//!
//! The public interface, types and errors live in `remit-interfaces`; this crate
//! is the implementation.
//!
//! ## Data minimisation is the design, not a feature
//!
//! The chain never sees a name, a document number or a screening result. What it
//! sees is:
//!
//! * `sha256` of the backend's signed verification payload (`Attestation::attestation_hash`)
//! * an ordinal tier, so the contract can compare it against a threshold
//! * an expiry, so verification is periodically refreshed
//! * a provider tag, so a provider migration is visible in the event history
//!
//! Everything else stays in Postgres. `docs/trust-and-compliance.md` covers the
//! retention and access-control argument, and the API in
//! `backend/src/kyc-orchestration` is the only supported way to write here.
//!
//! ## Tier bands
//!
//! Per corridor, `tier1_max` and `tier2_max` partition transfer amounts:
//!
//! | Amount | Required tier |
//! | --- | --- |
//! | `<= tier1_max` | none |
//! | `<= tier2_max` | `Standard` |
//! | `> tier2_max` | `Enhanced` |
//!
//! A separate `daily_limit` is enforced cumulatively per sender, because the
//! classic structuring attack — many small transfers just under the reporting
//! threshold — is invisible to a per-transfer rule.
//!
//! ## Trust model
//!
//! | Actor | Can do | Cannot do |
//! | --- | --- | --- |
//! | Admin (operator key) | Set tier thresholds, grant/revoke attester keys, register the escrow, pause everything | Read the underlying KYC record |
//! | Attester (backend key) | Publish and revoke attestations for a subject | Change tiers, pause, or read other subjects' records |
//! | Escrow contract | Commit a sender's volume after a successful check | Publish attestations |
//! | Anyone | Call `check_transfer_allowed` / `explain_transfer` (read-only, no state) | Write anything |

mod errors;
mod events;
mod hook;
mod storage;
mod types;

#[cfg(test)]
mod test;

pub use crate::errors::ComplianceError;
pub use crate::types::{Attestation, ComplianceStats, KycTier, TierThresholds, TransferDecision};
pub use remit_interfaces::compliance::ComplianceHookInterface;

use soroban_sdk::contract;

/// The on-chain compliance gate.
#[contract]
pub struct ComplianceHook;
