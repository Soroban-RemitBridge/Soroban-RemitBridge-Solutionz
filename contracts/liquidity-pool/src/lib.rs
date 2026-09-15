#![no_std]

//! # RemitBridge — Liquidity Pool (scaffold)
//!
//! Per-region float pool letting agents draw stablecoin against their registry
//! bond. Implementation is added in the following commits.

use soroban_sdk::contract;

/// Regional float pool for agent cash-out liquidity.
#[contract]
pub struct LiquidityPool;
