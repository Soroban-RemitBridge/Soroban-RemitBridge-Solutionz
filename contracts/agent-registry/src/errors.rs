//! Registry error taxonomy.
//!
//! Defined in `remit-interfaces` because these variants are part of the
//! contract's public ABI: the escrow, the indexer and the API all decode them.

pub use remit_interfaces::agent_registry::AgentRegistryError;
