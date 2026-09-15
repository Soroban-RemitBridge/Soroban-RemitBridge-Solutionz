/**
 * Constants shared with the contracts.
 *
 * Anything in this file duplicates an on-chain truth. Each entry says where the
 * authority lives and how the duplicate is kept honest, because a constant that
 * silently drifts from the contract is worse than no constant at all.
 */

/** Ledgers close roughly every 5 seconds; used to convert TTLs to wall time. */
export const SECONDS_PER_LEDGER = 5;

/** Mirrors `escrow::MAX_FEE_BPS`. The contract rejects anything above this, so a
 * config that exceeds it fails at the transaction rather than at parse time —
 * catching it here turns that into a boot error. */
export const MAX_FEE_BPS = 500;

/** Mirrors `liquidity_pool::MIN_COLLATERAL_RATIO_BPS` and `MAX_...`. */
export const MIN_COLLATERAL_RATIO_BPS = 10_000;
export const MAX_COLLATERAL_RATIO_BPS = 100_000;
export const MAX_UTILIZATION_CAP_BPS = 9_500;

/** Topic symbols emitted by the contracts. The indexer filters on these, and
 * `decoder.ts` refuses to decode a topic it does not recognise rather than
 * silently dropping it. */
export const EVENT_TOPICS = {
  transferCreated: 'tr_create',
  transferClaimed: 'tr_claim',
  transferRefunded: 'tr_refnd',
  transferCancelled: 'tr_cncl',
  escrowConfig: 'esc_cfg',
  escrowWiring: 'esc_wire',
  escrowAdmin: 'esc_adm',
  agentRegistered: 'agent_reg',
  agentStatus: 'agent_st',
  bondTopUp: 'bond_up',
  bondWithdraw: 'bond_down',
  agentSlashed: 'slash',
  regionConfigured: 'region',
  corridorMapped: 'corridor',
  registryAdmin: 'admin',
  attestationPublished: 'kyc_pub',
  attestationRevoked: 'kyc_rev',
  thresholdsUpdated: 'kyc_tier',
  attestationOperator: 'kyc_oper',
  compliancePause: 'kyc_paus',
  complianceEscrow: 'kyc_escr',
  transferCommitted: 'kyc_comm',
  poolRegion: 'lp_region',
  poolDeposit: 'lp_dep',
  poolWithdraw: 'lp_wdraw',
  poolDraw: 'lp_draw',
  poolRepay: 'lp_repay',
  poolConfig: 'lp_cfg',
  poolWire: 'lp_wire',
  poolAdmin: 'lp_admin',
} as const;

export type EventTopic = (typeof EVENT_TOPICS)[keyof typeof EVENT_TOPICS];

/**
 * Contract error-code to variant-name mapping, transcribed from the
 * `#[contracterror]` enums in `contracts/interfaces`.
 *
 * The mapping is here rather than being read from the deployed spec because the
 * backend must be able to name a failure from a signed transaction's return
 * value without an RPC round-trip — for example while replaying history during a
 * reindex. `pnpm verify:errors` in `scripts/` compares this table against the
 * built contract specs and fails the build on drift.
 */
export const COMPLIANCE_ERROR_NAMES: Record<number, string> = {
  1: 'NotInitialized',
  2: 'AlreadyInitialized',
  3: 'Unauthorized',
  4: 'NotAnAttester',
  5: 'NotEscrow',
  6: 'InvalidAmount',
  7: 'UnknownCorridor',
  8: 'InvalidThresholds',
  9: 'TransfersPaused',
  10: 'AttestationMissing',
  11: 'AttestationExpired',
  12: 'AttestationRevoked',
  13: 'TierTooLow',
  14: 'DailyLimitExceeded',
  15: 'InvalidExpiry',
  16: 'Overflow',
  17: 'EscrowNotSet',
};

export const ESCROW_ERROR_NAMES: Record<number, string> = {
  1: 'NotInitialized',
  2: 'AlreadyInitialized',
  3: 'Unauthorized',
  4: 'Paused',
  5: 'InvalidAmount',
  6: 'InvalidExpiry',
  7: 'ExpiryTooFar',
  8: 'TransferNotFound',
  9: 'TransferNotPending',
  10: 'TransferExpired',
  11: 'TransferNotExpired',
  12: 'InvalidClaimCode',
  13: 'AgentNotAuthorized',
  14: 'ComplianceRefused',
  15: 'ComplianceCallFailed',
  16: 'RegistryCallFailed',
  17: 'FeeTooHigh',
  18: 'InvalidConfig',
  19: 'Overflow',
  20: 'SenderCannotClaim',
};

export const AGENT_REGISTRY_ERROR_NAMES: Record<number, string> = {
  1: 'NotInitialized',
  2: 'AlreadyInitialized',
  3: 'Unauthorized',
  4: 'InvalidAmount',
  5: 'UnknownRegion',
  6: 'RegionInactive',
  7: 'RegionFull',
  8: 'BondBelowMinimum',
  9: 'AgentAlreadyRegistered',
  10: 'AgentNotRegistered',
  11: 'InsufficientBond',
  12: 'BondLockedWhileAuthorized',
  13: 'InvalidStatusTransition',
  14: 'BondTokenMismatch',
  15: 'RegionAlreadyExists',
  16: 'SlashExceedsBond',
  17: 'UnknownCorridor',
  18: 'InvalidAdmin',
  19: 'Overflow',
};

export const LIQUIDITY_ERROR_NAMES: Record<number, string> = {
  1: 'NotInitialized',
  2: 'AlreadyInitialized',
  3: 'Unauthorized',
  4: 'Paused',
  5: 'InvalidAmount',
  6: 'UnknownRegion',
  7: 'RegionInactive',
  8: 'RegionAlreadyOpen',
  9: 'AgentNotAuthorized',
  10: 'InsufficientCollateral',
  11: 'UtilizationCapExceeded',
  12: 'InsufficientLiquidity',
  13: 'InsufficientShares',
  14: 'RepaymentExceedsExposure',
  15: 'ZeroShares',
  16: 'InvalidConfig',
  17: 'RegistryCallFailed',
  18: 'Overflow',
};

export const NETWORK_LABELS: Record<string, string> = {
  testnet: 'Stellar Testnet',
  futurenet: 'Stellar Futurenet',
  mainnet: 'Stellar Mainnet (PUBLIC)',
  local: 'Local Sandbox',
};
