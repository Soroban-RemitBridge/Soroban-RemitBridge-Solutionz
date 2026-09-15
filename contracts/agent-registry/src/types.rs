//! Registry domain types.
//!
//! The definitions live in `remit-interfaces` so that `RemitEscrow` and
//! `LiquidityPool` can read them without linking this contract's Wasm exports.
//! They are re-exported here under the crate-local path the rest of this crate
//! already uses (`crate::types::Agent`), which keeps the move invisible to the
//! implementation and to the test suite.

pub use remit_interfaces::agent_registry::{Agent, AgentStatus, RegionConfig, RegistryStats};
