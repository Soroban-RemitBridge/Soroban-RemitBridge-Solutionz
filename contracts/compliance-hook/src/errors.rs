//! Compliance error taxonomy.
//!
//! Defined in `remit-interfaces`: the escrow maps these onto its own error space
//! when the gate refuses a transfer, and the API surfaces the mapping to senders.

pub use remit_interfaces::compliance::ComplianceError;
