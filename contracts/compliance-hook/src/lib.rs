#![no_std]

//! # RemitBridge — Compliance Hook (scaffold)
//!
//! Tiered KYC/AML gate consulted by `RemitEscrow` before funds are locked.
//! Implementation is added in the following commits.

use soroban_sdk::contract;

/// Tiered compliance gate. See `docs/trust-and-compliance.md`.
#[contract]
pub struct ComplianceHook;
