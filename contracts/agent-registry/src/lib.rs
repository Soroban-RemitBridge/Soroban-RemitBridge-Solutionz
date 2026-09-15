#![no_std]
#![deny(clippy::all)]
#![warn(clippy::pedantic)]
// Soroban's `Env`/`Address` types are passed by value throughout the generated
// client ABI; the pedantic lints that fire on that are not actionable here.
#![allow(clippy::needless_pass_by_value)]
#![allow(clippy::too_many_arguments)]
#![allow(clippy::missing_errors_doc)]
#![allow(clippy::missing_panics_doc)]
#![allow(clippy::module_name_repetitions)]
#![allow(clippy::must_use_candidate)]
#![allow(clippy::doc_markdown)]

//! # RemitBridge — Agent Registry
//!
//! Bonded registry of the cash-out agents that form RemitBridge's "last mile".
//! A small anchor or MTO onboards local shop owners and mobile-money kiosks as
//! agents; each agent posts a bond, and only agents the operator has explicitly
//! authorized can settle a transfer held in `RemitEscrow`.
//!
//! The public interface, the domain types and the error taxonomy live in
//! `remit-interfaces`; this crate is the implementation. That split exists for a
//! concrete reason rather than tidiness — see `interfaces/src/lib.rs`.
//!
//! ## Trust model
//!
//! | Actor | Can do | Cannot do |
//! | --- | --- | --- |
//! | Admin (anchor operator key) | Configure regions and corridor mappings, authorize/suspend/revoke agents, slash bonds | Move an agent's *remaining* bond to itself — slashes are capped at the posted bond and paid to the configured treasury |
//! | Agent | Register, top up, withdraw non-locked bond, settle transfers | Authorize itself, raise its own limits, withdraw bond while authorized |
//! | Anyone | Read any record | Write anything |
//!
//! ## What the bond protects against
//!
//! Cash-out fraud is the dominant last-mile risk: an agent takes a claim code,
//! does not hand over cash, and disappears. Because the escrowed funds are
//! released to the agent's settlement address at claim time, the network's only
//! recourse is the bond. It is sized per region (higher-risk corridors carry a
//! higher `min_bond`) and is slashable only by the operator key, which is why
//! that key's custody is called out in the docs as the highest-value secret in
//! the system.
//!
//! ## What is *not* on-chain
//!
//! No PII. An agent record holds an address, a region `Symbol`, a bond amount
//! and timestamps. Legal name, trade licence, ID documents and KYC artefacts
//! stay in the backend database; only the resulting attestation hash is
//! referenced (via the compliance hook). See `docs/trust-and-compliance.md`.

mod errors;
mod events;
mod registry;
mod storage;
mod types;

#[cfg(test)]
mod test;

pub use crate::errors::AgentRegistryError;
pub use crate::types::{Agent, AgentStatus, RegionConfig, RegistryStats};
pub use remit_interfaces::agent_registry::AgentRegistryInterface;

use soroban_sdk::contract;

/// The on-chain agent registry contract.
///
/// `#[contract]` generates `AgentRegistryClient` from the `#[contractimpl]`
/// block in [`registry`], which is what the escrow's test suite and the
/// deployment script use:
///
/// ```ignore
/// let client = AgentRegistryClient::new(&env, &registry_id);
/// let ok = client.is_authorized_for_corridor(&agent, &corridor_id);
/// ```
#[contract]
pub struct AgentRegistry;
