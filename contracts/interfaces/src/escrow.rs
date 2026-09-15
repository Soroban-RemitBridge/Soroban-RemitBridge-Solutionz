//! Remit escrow interface: transfer state, errors and the contract trait.
//!
//! Unlike the registry and compliance traits, this one carries no
//! `#[contractclient]`: nothing on-chain calls the escrow, so there is no Rust
//! client to generate. The backend and the mobile app reach it through the
//! generated TypeScript bindings instead.

use soroban_sdk::{contracterror, contracttype, Address, BytesN, Env, Symbol, Vec};

/// Platform fee ceiling, in basis points (5%).
///
/// Bounded on-chain rather than by convention so a compromised or mistaken
/// operator key cannot turn the escrow into a fee-extraction mechanism against
/// funds it already holds.
pub const MAX_FEE_BPS: u32 = 500;

/// Transfer lifecycle.
#[contracttype]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum TransferStatus {
    /// Funds locked, claim code outstanding, not yet expired.
    Pending,
    /// Settled to an authorized agent.
    Claimed,
    /// Nobody claimed before expiry; funds returned to the sender.
    Refunded,
    /// Sender withdrew before any claim.
    Cancelled,
}

/// A single remittance held in escrow.
///
/// `claim_hash` is `sha256(claim_code)`. The code itself never appears on-chain
/// in any form — see the crate-level rationale in the escrow contract.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Transfer {
    pub id: u64,
    pub sender: Address,
    pub amount: i128,
    pub token: Address,
    pub claim_hash: BytesN<32>,
    pub corridor_id: Symbol,
    pub expiry: u64,
    pub status: TransferStatus,
    pub created_at: u64,
    /// `0` until the transfer is claimed or refunded.
    pub settled_at: u64,
    /// `None` until claimed; useful for agent-side reconciliation.
    pub claimed_by: Option<Address>,
}

impl Transfer {
    pub fn is_pending(&self) -> bool {
        matches!(self.status, TransferStatus::Pending)
    }

    /// A transfer is stale once the ledger clock passes its expiry.
    pub fn has_expired(&self, now: u64) -> bool {
        now > self.expiry
    }
}

/// Contract-wide configuration, held in a single instance-storage entry.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct EscrowConfig {
    pub agent_registry: Address,
    pub compliance_hook: Address,
    /// Receives claimed fees.
    pub treasury: Address,
    /// Platform fee in basis points, capped by [`MAX_FEE_BPS`].
    pub fee_bps: u32,
    pub paused: bool,
    /// Upper bound on `expiry - now` at creation, so a sender cannot lock funds
    /// for an effectively infinite window and strand them.
    pub max_expiry_secs: u64,
}

/// What an agent would net for settling a transfer, before committing to it.
///
/// Separate from [`ClaimReceipt`] because a quote has no claimant: returning a
/// receipt with a placeholder agent address would invite a caller to read a
/// meaningless field.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ClaimQuote {
    pub transfer_id: u64,
    pub gross: i128,
    pub fee: i128,
    pub payout: i128,
}

/// What the claiming agent (and the indexer) gets back from a successful claim.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ClaimReceipt {
    pub transfer_id: u64,
    pub agent: Address,
    pub gross: i128,
    pub fee: i128,
    pub payout: i128,
    pub settled_at: u64,
}

/// Aggregate counters for the operator dashboard.
#[contracttype]
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct EscrowStats {
    pub created: u32,
    pub claimed: u32,
    pub refunded: u32,
    pub cancelled: u32,
    pub volume_locked: i128,
    pub volume_settled: i128,
    pub fees_collected: i128,
}

/* ------------------------------------------------------------------ */
/* errors                                                              */
/* ------------------------------------------------------------------ */

/// Failure modes of the escrow.
///
/// The distinction between the refusal variants matters operationally:
/// `ComplianceRefused` is a policy outcome the sender can act on (complete
/// verification, split the transfer), while `ComplianceCallFailed` means the
/// gate itself could not be reached and is an incident.
#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum EscrowError {
    NotInitialized = 1,
    AlreadyInitialized = 2,
    /// Caller is not the anchor operator key.
    Unauthorized = 3,
    /// New transfers are paused contract-wide.
    Paused = 4,
    /// Amount was zero or negative.
    InvalidAmount = 5,
    /// Expiry is not in the future.
    InvalidExpiry = 6,
    /// Expiry exceeds `max_expiry_secs`.
    ExpiryTooFar = 7,
    /// No transfer with that id.
    TransferNotFound = 8,
    /// Transfer is claimed, refunded or cancelled.
    TransferNotPending = 9,
    /// Claim attempted after expiry; the sender must refund instead.
    TransferExpired = 10,
    /// Refund attempted before expiry.
    TransferNotExpired = 11,
    /// `sha256(reveal) != claim_hash`.
    InvalidClaimCode = 12,
    /// Claimant is not an authorized agent for the transfer's corridor.
    AgentNotAuthorized = 13,
    /// The compliance gate refused the transfer.
    ComplianceRefused = 14,
    /// The compliance gate could not be reached or errored unexpectedly.
    ComplianceCallFailed = 15,
    /// The agent registry could not be reached or errored unexpectedly.
    RegistryCallFailed = 16,
    /// Fee exceeds [`MAX_FEE_BPS`].
    FeeTooHigh = 17,
    /// A rejected configuration value.
    InvalidConfig = 18,
    /// Arithmetic overflowed `i128`.
    Overflow = 19,
    /// The sender cannot claim their own transfer.
    SenderCannotClaim = 20,
}

/* ------------------------------------------------------------------ */
/* interface                                                           */
/* ------------------------------------------------------------------ */

/// Public interface of the escrow.
pub trait EscrowInterface {
    /* ---------------- lifecycle ---------------- */

    /// One-time setup. `max_expiry_secs` bounds how far ahead a transfer may be
    /// dated; `fee_bps` must be within [`MAX_FEE_BPS`].
    fn initialize(
        env: Env,
        admin: Address,
        agent_registry: Address,
        compliance_hook: Address,
        treasury: Address,
        fee_bps: u32,
        max_expiry_secs: u64,
    ) -> Result<(), EscrowError>;

    fn set_admin(env: Env, new_admin: Address) -> Result<(), EscrowError>;

    fn set_fee_bps(env: Env, fee_bps: u32) -> Result<(), EscrowError>;

    fn set_treasury(env: Env, treasury: Address) -> Result<(), EscrowError>;

    /// Re-point the escrow at a new registry or compliance hook.
    ///
    /// Both are upgrade paths *and* incident-response tools: if the compliance
    /// hook is found to be letting something through, this is how the network
    /// swaps to a corrected gate without redeploying the contract that holds
    /// user funds.
    fn set_agent_registry(env: Env, agent_registry: Address) -> Result<(), EscrowError>;

    fn set_compliance_hook(env: Env, compliance_hook: Address) -> Result<(), EscrowError>;

    fn set_max_expiry(env: Env, max_expiry_secs: u64) -> Result<(), EscrowError>;

    /// Emergency stop for *creation* only. Claims and refunds keep working, so a
    /// pause never traps funds that are already locked.
    fn set_paused(env: Env, paused: bool) -> Result<(), EscrowError>;

    /* ---------------- sender ---------------- */

    /// Lock `amount` of `token` and return the new transfer id.
    ///
    /// Order matters and is deliberate:
    /// 1. validate cheap inputs (amount, expiry window),
    /// 2. check the compliance gate — before any funds move,
    /// 3. transfer the sender's tokens into escrow,
    /// 4. commit the sender's daily volume,
    /// 5. persist the record and emit the event.
    ///
    /// `claim_hash` must be `sha256(claim_code)`; the contract cannot tell a
    /// hash of a low-entropy code from a good one, so the *client* is responsible
    /// for generating the code from a CSPRNG. See `docs/security.md`.
    fn create_transfer(
        env: Env,
        sender: Address,
        amount: i128,
        token: Address,
        claim_hash: BytesN<32>,
        corridor_id: Symbol,
        expiry: u64,
    ) -> Result<u64, EscrowError>;

    /// Withdraw a transfer that nobody has claimed. Sender-only.
    fn cancel_transfer(env: Env, sender: Address, transfer_id: u64) -> Result<(), EscrowError>;

    /* ---------------- agent ---------------- */

    /// Settle a transfer by revealing the claim code.
    ///
    /// Verifies `sha256(reveal) == claim_hash`, confirms the agent is authorized
    /// in the transfer's region via the registry, then pays the agent its
    /// settlement address minus the platform fee. Idempotent by construction: the
    /// record is flipped to `Claimed` under the same call, so a second attempt
    /// fails with `TransferNotPending` rather than paying twice.
    fn claim_transfer(
        env: Env,
        agent: Address,
        transfer_id: u64,
        reveal: BytesN<32>,
    ) -> Result<ClaimReceipt, EscrowError>;

    /* ---------------- anyone ---------------- */

    /// Return an expired, unclaimed transfer to its sender.
    ///
    /// Callable by anyone: the sender may be gone, and the alternative is funds
    /// locked forever. The destination is the recorded sender, so a third-party
    /// caller cannot redirect them.
    fn refund_expired(env: Env, transfer_id: u64) -> Result<(), EscrowError>;

    /* ---------------- read model ---------------- */

    fn get_transfer(env: Env, transfer_id: u64) -> Option<Transfer>;

    fn transfer_count(env: Env) -> u64;

    fn list_sender_transfers(env: Env, sender: Address) -> Vec<u64>;

    fn escrow_config(env: Env) -> Option<EscrowConfig>;

    fn escrow_stats(env: Env) -> EscrowStats;

    /// Fee the agent would net on a given claim, for display before the agent
    /// commits to handing over cash.
    fn quote_claim(env: Env, transfer_id: u64) -> Result<ClaimQuote, EscrowError>;
}
