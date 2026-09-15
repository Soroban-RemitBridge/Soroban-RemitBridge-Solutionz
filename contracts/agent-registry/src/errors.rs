use soroban_sdk::contracterror;

/// Every failure mode of [`crate::AgentRegistry`].
///
/// The contract never panics for a predictable business failure: each variant
/// is returned as a typed `Result` error so the calling contract
/// (`RemitEscrow`) and off-chain indexers can branch on the exact cause instead
/// of parsing panic strings.
#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum AgentRegistryError {
    /// A read/write happened before `initialize`.
    NotInitialized = 1,
    /// `initialize` was called twice.
    AlreadyInitialized = 2,
    /// Caller is not the configured admin (anchor operator).
    Unauthorized = 3,
    /// Amount was zero or negative.
    InvalidAmount = 4,
    /// Region has not been configured by the operator.
    UnknownRegion = 5,
    /// Region exists but is switched off.
    RegionInactive = 6,
    /// Region already holds `max_agents` authorized agents.
    RegionFull = 7,
    /// Bond posted is below the region minimum.
    BondBelowMinimum = 8,
    /// Agent already has a record in the registry.
    AgentAlreadyRegistered = 9,
    /// No record exists for the given agent.
    AgentNotRegistered = 10,
    /// Agent's bond is too small for the requested operation.
    InsufficientBond = 11,
    /// Bond withdrawal attempted while the agent can still settle transfers.
    BondLockedWhileAuthorized = 12,
    /// Requested lifecycle transition is not permitted.
    InvalidStatusTransition = 13,
    /// Bond was posted in a different token than the configured bond token.
    BondTokenMismatch = 14,
    /// Region already exists.
    RegionAlreadyExists = 15,
    /// Slash amount exceeds the agent's remaining bond.
    SlashExceedsBond = 16,
    /// Corridor has no region mapped to it.
    UnknownCorridor = 17,
    /// Admin address may not be the zero/invalid address.
    InvalidAdmin = 18,
}
