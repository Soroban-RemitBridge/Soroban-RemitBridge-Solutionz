#![no_std]
#![deny(clippy::all)]
#![warn(clippy::pedantic)]
#![allow(clippy::needless_pass_by_value)]
#![allow(clippy::too_many_arguments)]
#![allow(clippy::missing_errors_doc)]
#![allow(clippy::must_use_candidate)]
#![allow(clippy::module_name_repetitions)]
#![allow(clippy::doc_markdown)]

//! Shared contract surface for RemitBridge.
//!
//! ## Why this crate exists
//!
//! The obvious way to share a contract's types with another contract is to
//! depend on that contract's crate. It is also wrong, and quietly so: a Soroban
//! contract crate is a `cdylib`, and linking one into another pulls its exported
//! entry points into the consuming Wasm.
//!
//! That was caught here by inspecting the built artifact rather than by reading
//! the code — `WebAssembly.Module.exports()` on `remit_escrow.wasm` listed
//! `slash_agent`, `register_agent` and the rest of `AgentRegistry`'s ABI. Had it
//! shipped, the deployed escrow address would have accepted `slash_agent` calls.
//!
//! So interfaces live here instead: plain `rlib`, no `#[contract]`, no
//! `#[contractimpl]`, no exports. Each contract crate depends on this one and
//! nothing else, which also makes the dependency graph reflect the design — the
//! escrow genuinely has no business linking the registry's implementation.

pub mod agent_registry;
pub mod compliance;
pub mod escrow;
pub mod liquidity;
