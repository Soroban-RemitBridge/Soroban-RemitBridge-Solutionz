use soroban_sdk::{contracttype, Address, Symbol};

/// Lifecycle state of a cash-out agent.
///
/// Only [`AgentStatus::Authorized`] agents are allowed to claim escrowed
/// transfers. The registry deliberately separates "has posted a bond"
/// (`Pending`) from "is allowed to move money" (`Authorized`) so that a bond
/// alone never grants the right to settle a transfer.
#[contracttype]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum AgentStatus {
    /// Bond posted on-chain, awaiting anchor-operator approval.
    Pending,
    /// Approved: may claim and settle transfers in its assigned region.
    Authorized,
    /// Temporarily blocked while an incident is investigated.
    Suspended,
    /// Permanently removed. The remaining bond stays claimable by the agent.
    Revoked,
}

impl AgentStatus {
    /// Whether an agent in this state may settle transfers.
    pub fn can_settle(self) -> bool {
        matches!(self, AgentStatus::Authorized)
    }

    /// Whether the agent may withdraw its remaining bond.
    pub fn bond_is_withdrawable(self) -> bool {
        !matches!(self, AgentStatus::Authorized)
    }
}

/// An agent's on-chain record.
///
/// **No PII lives here.** `address` is the agent's Stellar account (or the
/// settlement address an operator controls), and everything else is either a
/// numeric bond, an operator-chosen region tag, or a timestamp. Business name,
/// licence numbers and KYC documents are held off-chain and referenced only by
/// hash from the compliance hook.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Agent {
    pub address: Address,
    pub region_id: Symbol,
    /// Token the bond is denominated in; recorded so a later token swap cannot
    /// strand or silently revalue an existing bond.
    pub bond_token: Address,
    pub bond: i128,
    pub status: AgentStatus,
    /// Number of successful slashes; used by the dashboard to prioritise review.
    pub slash_count: u32,
    pub registered_at: u64,
    pub updated_at: u64,
}

/// Per-region operating envelope configured by the anchor operator.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RegionConfig {
    pub region_id: Symbol,
    /// Minimum bond required to register. Raising it never retroactively
    /// evicts agents; it only gates new registrations and top-ups.
    pub min_bond: i128,
    /// Hard cap on authorized agents in the region. `0` means uncapped.
    pub max_agents: u32,
    pub active: bool,
}

impl RegionConfig {
    /// Whether a candidate bond satisfies this region's minimum.
    pub fn accepts_bond(&self, bond: i128) -> bool {
        bond >= self.min_bond
    }
}

/// Aggregate counters for the operator dashboard.
///
/// These are maintained on write rather than derived on read so the indexer and
/// admin UI can render network health without paging every agent record.
#[contracttype]
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct RegistryStats {
    pub total_agents: u32,
    pub authorized_agents: u32,
    pub total_bonded: i128,
    pub total_slashed: i128,
}
