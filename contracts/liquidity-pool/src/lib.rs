#![no_std]
#![deny(clippy::all)]
#![warn(clippy::pedantic)]
#![allow(clippy::needless_pass_by_value)]
#![allow(clippy::too_many_arguments)]
#![allow(clippy::missing_errors_doc)]
#![allow(clippy::missing_panics_doc)]
#![allow(clippy::module_name_repetitions)]
#![allow(clippy::must_use_candidate)]
#![allow(clippy::doc_markdown)]

//! # RemitBridge — Regional Liquidity Pool
//!
//! An agent's job is to hand over cash before it has any. That is the whole
//! last-mile problem in one sentence: a shop owner in Lagos can settle a
//! transfer in seconds, but only if there is float in the till at that moment.
//!
//! This contract lets an agent draw stablecoin against its bonded collateral in
//! `AgentRegistry`, and lets liquidity providers fund that float per region.
//! Settlement then flows back as repayment.
//!
//! ## Two ratios, and why both
//!
//! **Collateral ratio** (bond vs. draw, default 150%) protects *the network*.
//! The pool is lending against a bond it does not hold and cannot seize, so the
//! bond must exceed the exposure or the loan is under-secured from the first
//! second.
//!
//! **Utilization cap** (draws vs. deposits, default 80%) protects *depositors*.
//! The float is out in the world as cash; it cannot be recalled on demand. The
//! cap guarantees a reserve stays in the contract so a wave of withdrawals does
//! not become a run, and `withdraw_liquidity` enforces it rather than trusting
//! the cap to have been respected on the draw side.
//!
//! Both are checked against the agent's *total* regional exposure rather than the
//! incremental draw, so an agent cannot slip under either limit by drawing
//! repeatedly in small amounts.
//!
//! ## Share accounting on day one
//!
//! The pool pays no yield yet, yet it already tracks shares. When settlement
//! fees are routed here, the share price rises for existing depositors with no
//! migration — whereas a "balance equals deposit" model would have to be
//! replaced later, at which point the earliest depositors' claims become
//! ambiguous.
//!
//! ## Trust model
//!
//! | Actor | Can do | Cannot do |
//! | --- | --- | --- |
//! | Admin (operator key) | Open regions, set both ratios within bounds, pause | Move depositor funds, raise a ratio above the hard cap, or set a zero collateral ratio |
//! | Liquidity provider | Deposit and redeem shares | Redeem into drawn float, or withdraw more than its shares are worth |
//! | Authorized agent | Draw and repay against its bond, in its own region | Draw without a sufficient bond, exceed the region's cap, draw in a region it is not authorized in |
//! | Anyone | Read pool health | Write anything |
//!
//! ## Known limitation, stated plainly
//!
//! `AgentRegistry::withdraw_bond` does not consult this contract, so an agent
//! with an outstanding draw can reduce its bond below the ratio that justified
//! that draw. The draw is still checked on every subsequent draw, so the exposure
//! cannot grow — but the existing position can become under-collateralised.
//! Closing it properly needs a registry-side callback to the pool or a
//! shared collateral ledger, and the trade-off is tracked in the README roadmap
//! rather than papered over here.

mod events;
mod pool;
mod storage;

#[cfg(test)]
mod test;

pub use remit_interfaces::liquidity::{
    LiquidityError, LiquidityPoolInterface, LiquidityStats, PoolConfig, PoolState, PoolStats,
};

use soroban_sdk::contract;

/// The regional float pool agents draw against their bond.
#[contract]
pub struct LiquidityPool;
