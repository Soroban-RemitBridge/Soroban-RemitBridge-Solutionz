import { describe, expect, it } from 'vitest';

import { classifyAlert, evaluateAgent, type LiquidityObservation } from '../src/agent-liquidity/service.js';

/**
 * The arithmetic behind "is this agent about to run out of cash" is exactly the
 * kind of thing that should be unit-testable without a database, an RPC node or a
 * clock, so it is a pure function and these tests are exhaustive at the
 * boundaries rather than illustrative.
 */

const COLLATERAL_BPS = 15_000;

function evaluate(bond: bigint, drawn: bigint) {
  return evaluateAgent({ bond, drawn, collateralRatioBps: COLLATERAL_BPS });
}

describe('evaluateAgent', () => {
  it('gives a fully bonded, undrawn agent its whole bond as capacity', () => {
    const result = evaluate(1_500n, 0n);
    // 1_500 bonded at 150% covers 1_000 of exposure.
    expect(result.undrawnCapacity).toBe(1_000n);
    expect(result.floatRatioBps).toBe(6_666);
    expect(result.collateralHeadroomBps).toBe(10_000);
  });

  it('shrinks capacity by exactly what has already been drawn', () => {
    const result = evaluate(1_500n, 600n);
    // 1_500 - 900 required for the current 600 leaves 600 of headroom, which
    // covers a further 400 of exposure at 150%.
    expect(result.undrawnCapacity).toBe(400n);
  });

  it('reports zero capacity rather than a negative one when already under-collateralised', () => {
    // The realistic cause is a slash or a bond withdrawal after the draw; the
    // registry does not consult the pool on `withdraw_bond`, which is the known
    // limitation documented in the pool's crate docs.
    const result = evaluate(100n, 1_000n);
    expect(result.undrawnCapacity).toBe(0n);
    expect(result.collateralHeadroomBps).toBe(0);
  });

  it('does not divide by zero for an agent with no bond', () => {
    const result = evaluate(0n, 0n);
    expect(result.undrawnCapacity).toBe(0n);
    expect(result.floatRatioBps).toBe(0);
  });
});

describe('classifyAlert', () => {
  function observation(overrides: Partial<LiquidityObservation>): LiquidityObservation {
    return {
      agentId: 'agent-1',
      regionId: 'NG_LAG',
      bond: 1_500n,
      drawn: 0n,
      undrawnCapacity: 1_000n,
      floatRatioBps: 6_666,
      collateralHeadroomBps: 10_000,
      ...overrides,
    };
  }

  it('stays quiet for a healthy agent', () => {
    expect(classifyAlert(observation({}))).toBeNull();
  });

  it('classifies low float separately from tight collateral', () => {
    // Low float with plenty of bond headroom: the remedy is more pool liquidity.
    expect(classifyAlert(observation({ floatRatioBps: 2_000 }))).toMatchObject({ kind: 'FLOAT_LOW' });
    // Tight collateral: the remedy is a bond top-up, and no amount of pool
    // liquidity will help. Merging these two alerts would send an operator to the
    // wrong fix.
    expect(classifyAlert(observation({ collateralHeadroomBps: 500 }))).toMatchObject({
      kind: 'COLLATERAL_TIGHT',
    });
  });

  it('reports tight collateral ahead of low float when both apply', () => {
    const alert = classifyAlert(observation({ collateralHeadroomBps: 0, floatRatioBps: 0 }));
    expect(alert?.kind).toBe('COLLATERAL_TIGHT');
  });

  it('fires exactly at the threshold, not one basis point later', () => {
    expect(classifyAlert(observation({ collateralHeadroomBps: 999 }))).toMatchObject({ kind: 'COLLATERAL_TIGHT' });
    expect(classifyAlert(observation({ floatRatioBps: 2_999 }))).toMatchObject({ kind: 'FLOAT_LOW' });
  });
});
