import { Address, type Keypair, nativeToScVal, xdr } from '@stellar/stellar-sdk';

import { env } from '../config/env.js';
import { invoke, read, type InvocationResult } from './rpc.js';

/**
 * Typed wrappers around the four contracts.
 *
 * These exist so the rest of the service never hand-builds an `ScVal`. Getting a
 * `Symbol` versus a `String` wrong is not a type error at the call site — it
 * produces a transaction the host rejects with a decoding error that names
 * neither the field nor the caller, which is a genuinely expensive afternoon.
 */

const str = (value: string): xdr.ScVal => nativeToScVal(value, { type: 'string' });
const sym = (value: string): xdr.ScVal => nativeToScVal(value, { type: 'symbol' });
const i128 = (value: bigint): xdr.ScVal => nativeToScVal(value, { type: 'i128' });
const u32 = (value: number): xdr.ScVal => nativeToScVal(value, { type: 'u32' });
const u64 = (value: bigint): xdr.ScVal => nativeToScVal(value, { type: 'u64' });
const address = (value: string): xdr.ScVal => new Address(value).toScVal();
const bytes32 = (value: Buffer | string): xdr.ScVal =>
  nativeToScVal(value, { type: 'bytes' });
const bool = (value: boolean): xdr.ScVal => nativeToScVal(value, { type: 'bool' });
const vec = (values: xdr.ScVal[]): xdr.ScVal =>
  xdr.ScVal.scvVec(values);

/**
 * Encode a unit variant of a `#[contracttype]` enum.
 *
 * A Rust enum with unit variants crosses the ABI as a **one-element vector of
 * the case name**, not as the bare `Symbol` its name suggests — the XDR union
 * the contract sees is `ScVal::Vec([Symbol("Standard")])`. This was verified
 * against a deployment, not assumed: `publish_attestation` with a bare
 * `Symbol` traps inside the generated entry point (`Error(WasmVm,
 * InvalidAction)`, `UnreachableCodeReached`) because the argument fails to
 * decode, and the same call with the vector form succeeds. The trap names
 * neither the argument nor the caller, so getting this wrong is expensive to
 * diagnose — which is why it is a helper here rather than inlined at the call
 * site.
 */
const enumCase = (variant: string): xdr.ScVal => vec([sym(variant)]);

/**
 * Encode a `#[contracttype]` struct as a Soroban map.
 *
 * Two things have to be right here and `nativeToScVal`'s defaults get both of
 * them wrong for a contract type: the map's keys must be **symbols** (the Rust
 * field names), and each value must be encoded as its *declared* Rust type. A
 * plain object passed with a scalar `type` hint produces string keys and picks
 * the narrowest integer representation that happens to fit, which the host then
 * rejects with a decoding error naming neither the field nor the caller.
 *
 * Building the map explicitly is the only encoding that cannot drift from the
 * Rust definition. Keys must match the Rust field names exactly (`tier1_max`,
 * not `tier1Max`), and entries are sorted because the Soroban runtime expects
 * map keys in order.
 */
function struct(fields: Record<string, xdr.ScVal>): xdr.ScVal {
  const entries = Object.entries(fields)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([key, value]) => new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol(key), val: value }));
  return xdr.ScVal.scvMap(entries);
}

export const contracts = {
  escrow: env.CONTRACT_ESCROW,
  agentRegistry: env.CONTRACT_AGENT_REGISTRY,
  complianceHook: env.CONTRACT_COMPLIANCE_HOOK,
  liquidityPool: env.CONTRACT_LIQUIDITY_POOL,
} as const;

/* ------------------------------------------------------------------ */
/* compliance hook                                                     */
/* ------------------------------------------------------------------ */

export interface PublishAttestationInput {
  attester: Keypair;
  subject: string;
  tier: 'None' | 'Standard' | 'Enhanced';
  attestationHash: Buffer;
  regionId: string;
  providerId: string;
  expiresAt: bigint;
}

/**
 * The argument vector for `publish_attestation`, exported so it can be tested.
 *
 * Separated from the call so the encoding of the `tier` enum — the one argument
 * whose correct form is not guessable — can be asserted without a network. That
 * is worth the extraction: the wrong encoding does not fail as a type error, it
 * traps inside the contract and surfaces as `Error(WasmVm, InvalidAction)` with
 * no mention of the argument.
 */
export function publishAttestationArgs(
  input: Omit<PublishAttestationInput, 'attester'> & { attesterPublicKey: string },
): xdr.ScVal[] {
  return [
    address(input.attesterPublicKey),
    address(input.subject),
    // Not `sym(input.tier)`: see `enumCase`. The variant ordinal is also wrong —
    // the contract decodes the case name, and rejects both the ordinal and the
    // bare symbol.
    enumCase(input.tier),
    bytes32(input.attestationHash),
    sym(input.regionId),
    sym(input.providerId),
    u64(input.expiresAt),
  ];
}

/**
 * Publish a verification result. Only the hash crosses this boundary — the
 * document that produced it stays in Postgres.
 */
export function publishAttestation(
  input: PublishAttestationInput,
): Promise<InvocationResult<void>> {
  return invoke<void>({
    contractId: contracts.complianceHook,
    method: 'publish_attestation',
    signer: input.attester,
    args: publishAttestationArgs({
      ...input,
      attesterPublicKey: input.attester.publicKey(),
    }),
  });
}

export function revokeAttestation(
  attester: Keypair,
  subject: string,
  reason: string,
): Promise<InvocationResult<void>> {
  return invoke<void>({
    contractId: contracts.complianceHook,
    method: 'revoke_attestation',
    signer: attester,
    args: [address(attester.publicKey()), address(subject), sym(reason)],
  });
}

export interface TierThresholdsInput {
  corridorId: string;
  tier1Max: bigint;
  tier2Max: bigint;
  dailyLimit: bigint;
}

export function setTierThresholds(
  operator: Keypair,
  thresholds: TierThresholdsInput,
): Promise<InvocationResult<void>> {
  return invoke<void>({
    contractId: contracts.complianceHook,
    method: 'set_tier_thresholds',
    signer: operator,
    args: [
      struct({
        corridor_id: sym(thresholds.corridorId),
        tier1_max: i128(thresholds.tier1Max),
        tier2_max: i128(thresholds.tier2Max),
        daily_limit: i128(thresholds.dailyLimit),
      }),
    ],
  });
}

export function setEscrowContract(
  operator: Keypair,
  escrow: string,
): Promise<InvocationResult<void>> {
  return invoke<void>({
    contractId: contracts.complianceHook,
    method: 'set_escrow',
    signer: operator,
    args: [address(escrow)],
  });
}

export function checkTransferAllowed(
  sender: string,
  amount: bigint,
  corridorId: string,
): Promise<boolean | undefined> {
  return read<boolean>({
    contractId: contracts.complianceHook,
    method: 'check_transfer_allowed',
    args: [address(sender), i128(amount), sym(corridorId)],
  });
}

export function explainTransfer(
  sender: string,
  amount: bigint,
  corridorId: string,
): Promise<unknown> {
  return read<unknown>({
    contractId: contracts.complianceHook,
    method: 'explain_transfer',
    args: [address(sender), i128(amount), sym(corridorId)],
  });
}

/* ------------------------------------------------------------------ */
/* agent registry                                                      */
/* ------------------------------------------------------------------ */

export function setOperator(
  operator: Keypair,
  attester: string,
  allowed: boolean,
): Promise<InvocationResult<void>> {
  return invoke<void>({
    contractId: contracts.complianceHook,
    method: 'set_operator',
    signer: operator,
    args: [address(attester), bool(allowed)],
  });
}

export function addRegion(
  operator: Keypair,
  regionId: string,
  minBond: bigint,
  maxAgents: number,
): Promise<InvocationResult<void>> {
  return invoke<void>({
    contractId: contracts.agentRegistry,
    method: 'add_region',
    signer: operator,
    args: [sym(regionId), i128(minBond), u32(maxAgents)],
  });
}

export function mapCorridor(
  operator: Keypair,
  corridorId: string,
  regionId: string,
): Promise<InvocationResult<void>> {
  return invoke<void>({
    contractId: contracts.agentRegistry,
    method: 'map_corridor',
    signer: operator,
    args: [sym(corridorId), sym(regionId)],
  });
}

export function authorizeAgent(
  operator: Keypair,
  agent: string,
): Promise<InvocationResult<void>> {
  return invoke<void>({
    contractId: contracts.agentRegistry,
    method: 'authorize_agent',
    signer: operator,
    args: [address(agent)],
  });
}

export function suspendAgent(
  operator: Keypair,
  agent: string,
  reason: string,
): Promise<InvocationResult<void>> {
  return invoke<void>({
    contractId: contracts.agentRegistry,
    method: 'suspend_agent',
    signer: operator,
    args: [address(agent), sym(reason)],
  });
}

export function revokeAgent(
  operator: Keypair,
  agent: string,
  reason: string,
): Promise<InvocationResult<void>> {
  return invoke<void>({
    contractId: contracts.agentRegistry,
    method: 'revoke_agent',
    signer: operator,
    args: [address(agent), sym(reason)],
  });
}

export function slashAgent(
  operator: Keypair,
  agent: string,
  amount: bigint,
  reason: string,
): Promise<InvocationResult<bigint>> {
  return invoke<bigint>({
    contractId: contracts.agentRegistry,
    method: 'slash_agent',
    signer: operator,
    args: [address(agent), i128(amount), sym(reason)],
  });
}

export function isAgentAuthorized(
  agent: string,
  regionId: string,
): Promise<boolean | undefined> {
  return read<boolean>({
    contractId: contracts.agentRegistry,
    method: 'is_authorized',
    args: [address(agent), sym(regionId)],
  });
}

export function registryBond(agent: string): Promise<bigint | undefined> {
  return read<bigint>({
    contractId: contracts.agentRegistry,
    method: 'get_bond',
    args: [address(agent)],
  });
}

/* ------------------------------------------------------------------ */
/* liquidity pool                                                      */
/* ------------------------------------------------------------------ */

export function drawLiquidity(
  operator: Keypair,
  agent: string,
  regionId: string,
  amount: bigint,
): Promise<InvocationResult<bigint>> {
  // Signed by the operator, not the agent: the backend executes an approved
  // top-up on the agent's behalf, and the pool's `require_auth` binds the call
  // to whoever signed it. The agent's own key is never held by the service.
  return invoke<bigint>({
    contractId: contracts.liquidityPool,
    method: 'draw_liquidity',
    signer: operator,
    args: [address(agent), sym(regionId), i128(amount)],
  });
}

export function repayLiquidity(
  operator: Keypair,
  agent: string,
  regionId: string,
  amount: bigint,
): Promise<InvocationResult<bigint>> {
  return invoke<bigint>({
    contractId: contracts.liquidityPool,
    method: 'repay_liquidity',
    signer: operator,
    args: [address(agent), sym(regionId), i128(amount)],
  });
}

export function poolHealth(regionId: string): Promise<unknown> {
  return read<unknown>({
    contractId: contracts.liquidityPool,
    method: 'get_pool_health',
    args: [sym(regionId)],
  });
}

export function requiredBondFor(
  agent: string,
  regionId: string,
  additional: bigint,
): Promise<bigint | undefined> {
  return read<bigint>({
    contractId: contracts.liquidityPool,
    method: 'required_bond_for',
    args: [address(agent), sym(regionId), i128(additional)],
  });
}

export function openPoolRegion(
  operator: Keypair,
  regionId: string,
  utilizationCapBps: number,
): Promise<InvocationResult<void>> {
  return invoke<void>({
    contractId: contracts.liquidityPool,
    method: 'open_region',
    signer: operator,
    args: [sym(regionId), u32(utilizationCapBps)],
  });
}

export const codes = { str, sym, i128, u32, u64, address, bytes32, bool, vec };
