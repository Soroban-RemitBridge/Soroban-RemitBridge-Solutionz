//! Contract events.
//!
//! Every state transition that the backend read model cares about is published
//! here with a leading topic symbol so the event indexer can filter cheaply
//! (`getEvents` supports topic filters, not payload filters). Payloads carry
//! only addresses, amounts and symbols — never anything that identifies a
//! human being.

use soroban_sdk::{symbol_short, Address, Env, Symbol};

use crate::types::AgentStatus;

/// An agent posted a bond and entered the registry as `Pending`.
pub fn agent_registered(env: &Env, agent: &Address, region_id: &Symbol, bond: i128) {
    env.events().publish(
        (symbol_short!("agent_reg"), agent.clone(), region_id.clone()),
        bond,
    );
}

/// An agent's lifecycle state changed (authorize / suspend / revoke /
/// auto-suspend after an under-collateralising slash).
///
/// `reason` is the operator's own tag (`approved`, `fraud`, `underwater`, ...)
/// — a symbol, not free text, so the indexer can group by cause.
pub fn agent_status_changed(
    env: &Env,
    agent: &Address,
    region_id: &Symbol,
    from: AgentStatus,
    to: AgentStatus,
    reason: &Symbol,
) {
    env.events().publish(
        (symbol_short!("agent_st"), agent.clone(), region_id.clone()),
        (from, to, reason.clone()),
    );
}

/// An agent added collateral without changing status.
pub fn bond_topped_up(env: &Env, agent: &Address, amount: i128, new_bond: i128) {
    env.events().publish(
        (symbol_short!("bond_up"), agent.clone()),
        (amount, new_bond),
    );
}

/// An agent withdrew excess collateral.
pub fn bond_withdrawn(env: &Env, agent: &Address, amount: i128, new_bond: i128) {
    env.events().publish(
        (symbol_short!("bond_down"), agent.clone()),
        (amount, new_bond),
    );
}

/// A slash was applied; `recovered` is what actually moved to the treasury.
pub fn agent_slashed(
    env: &Env,
    agent: &Address,
    requested: i128,
    recovered: i128,
    reason: &Symbol,
) {
    env.events().publish(
        (symbol_short!("slash"), agent.clone(), reason.clone()),
        (requested, recovered),
    );
}

/// A region was created or reconfigured.
pub fn region_configured(env: &Env, region_id: &Symbol, min_bond: i128, active: bool) {
    env.events().publish(
        (symbol_short!("region"), region_id.clone()),
        (min_bond, active),
    );
}

/// A corridor symbol was mapped to a region.
pub fn corridor_mapped(env: &Env, corridor_id: &Symbol, region_id: &Symbol) {
    env.events().publish(
        (symbol_short!("corridor"), corridor_id.clone()),
        region_id.clone(),
    );
}

/// The operator key rotated.
pub fn admin_changed(env: &Env, previous: &Address, next: &Address) {
    env.events()
        .publish((symbol_short!("admin"), previous.clone()), next.clone());
}
