//! Pool events.
//!
//! The backend's agent-liquidity service is the main consumer: it watches for
//! `draw` and `repay` to keep its float model current, and uses the draw/repay
//! ratio per region to decide when to ask an operator to rebalance. Payloads
//! carry amounts and addresses only.

use soroban_sdk::{symbol_short, Address, Env, Symbol};

/// A region's pool was opened or reconfigured.
pub fn region_configured(env: &Env, region_id: &Symbol, utilization_cap_bps: u32, active: bool) {
    env.events().publish(
        (symbol_short!("lp_region"), region_id.clone()),
        (utilization_cap_bps, active),
    );
}

/// A liquidity provider deposited float.
pub fn liquidity_deposited(
    env: &Env,
    provider: &Address,
    region_id: &Symbol,
    amount: i128,
    shares: i128,
    total_deposited: i128,
) {
    env.events().publish(
        (symbol_short!("lp_dep"), provider.clone(), region_id.clone()),
        (amount, shares, total_deposited),
    );
}

/// A liquidity provider redeemed shares.
pub fn liquidity_withdrawn(
    env: &Env,
    provider: &Address,
    region_id: &Symbol,
    shares: i128,
    amount: i128,
    total_deposited: i128,
) {
    env.events().publish(
        (
            symbol_short!("lp_wdraw"),
            provider.clone(),
            region_id.clone(),
        ),
        (shares, amount, total_deposited),
    );
}

/// An agent drew float against its bond.
pub fn liquidity_drawn(
    env: &Env,
    agent: &Address,
    region_id: &Symbol,
    amount: i128,
    exposure: i128,
    utilization_bps: u32,
) {
    env.events().publish(
        (symbol_short!("lp_draw"), agent.clone(), region_id.clone()),
        (amount, exposure, utilization_bps),
    );
}

/// An agent returned float.
pub fn liquidity_repaid(
    env: &Env,
    agent: &Address,
    region_id: &Symbol,
    amount: i128,
    exposure: i128,
) {
    env.events().publish(
        (symbol_short!("lp_repay"), agent.clone(), region_id.clone()),
        (amount, exposure),
    );
}

// Note: there is deliberately no `draw_rejected` event.
//
// A refused draw returns a typed error, which reverts the invocation, and
// Soroban discards events from reverted invocations. Logging refusals on-chain
// would require committing a write on every rejected attempt, handing anyone a
// cheap way to bloat the ledger. The backend records them from the typed error
// instead, and `required_bond_for` lets the console explain a refusal without
// needing a log entry.

/// Contract-wide configuration changed.
pub fn config_updated(env: &Env, tag: &Symbol, collateral_ratio_bps: u32, paused: bool) {
    env.events().publish(
        (symbol_short!("lp_cfg"), tag.clone()),
        (collateral_ratio_bps, paused),
    );
}

/// The registry used for bond checks changed.
pub fn registry_updated(env: &Env, registry: &Address) {
    env.events()
        .publish((symbol_short!("lp_wire"),), registry.clone());
}

/// The operator key rotated.
pub fn admin_changed(env: &Env, previous: &Address, next: &Address) {
    env.events()
        .publish((symbol_short!("lp_admin"), previous.clone()), next.clone());
}
