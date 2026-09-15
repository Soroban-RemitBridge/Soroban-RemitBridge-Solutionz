#![no_std]

//! # RemitBridge — Remit Escrow (scaffold)
//!
//! Commit-reveal escrow holding sender funds until an authorized agent claims
//! them. Implementation is added in the following commits.

use soroban_sdk::contract;

/// Commit-reveal transfer escrow.
#[contract]
pub struct RemitEscrow;
