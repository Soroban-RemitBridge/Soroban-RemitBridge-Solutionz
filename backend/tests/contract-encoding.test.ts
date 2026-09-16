import { Address, xdr } from '@stellar/stellar-sdk';
import { describe, expect, it } from 'vitest';

import { publishAttestationArgs } from '../src/soroban/contracts.js';

/**
 * Encoding tests for the arguments this service sends to the contracts.
 *
 * These exist because of a bug that only a real network could show: the `tier`
 * argument was sent as the bare `Symbol` its name suggests, and every
 * `publish_attestation` call trapped inside the contract's generated entry point
 * with `Error(WasmVm, InvalidAction)` / `UnreachableCodeReached`. Nothing about
 * that error names the argument that failed to decode, the failure is not a type
 * error at the call site, and a test that only checks the call was attempted
 * would pass.
 *
 * The rule the contract actually implements, read from its own Wasm contract
 * spec (`Spec.fromWasm` on the built artifact): a `#[contracttype]` enum with
 * unit variants crosses the ABI as a one-element vector of the case name.
 *
 * The assertions compare XDR objects rather than reaching into typed variants,
 * so each expected value is built with the SDK's own constructors and cannot
 * drift from what the SDK would produce.
 */

const ATTESTER = 'GC53DXK4XGEIYQAXGTSSWOZVNW6WHEFGYOU6JEGZ5YJ572JMJNJLPP6F';
const SUBJECT = 'GBOLZOLTMDKXUY2QJGKNZJVQZ5GDET3GNSE4IZK3L4GP7FWCFJXEAW7C';
const HASH_BYTES = Buffer.alloc(32, 7);

type Tier = 'None' | 'Standard' | 'Enhanced';

function args(tier: Tier): xdr.ScVal[] {
  return publishAttestationArgs({
    attesterPublicKey: ATTESTER,
    subject: SUBJECT,
    tier,
    attestationHash: HASH_BYTES,
    regionId: 'NG_LAG',
    providerId: 'mock',
    expiresAt: 1_789_000_000n,
  });
}

function wire(value: xdr.ScVal): unknown {
  return value.toXdrObject();
}

describe('publish_attestation argument encoding', () => {
  it('sends the tier as a one-element vector of the case name', () => {
    const tier = args('Standard')[2] as xdr.ScVal;

    expect(tier.type).toBe('scvVec');
    expect(wire(tier)).toEqual(wire(xdr.ScVal.scvVec([xdr.ScVal.scvSymbol('Standard')])));
  });

  it('does not send the tier as a bare symbol or an ordinal', () => {
    const tier = args('Enhanced')[2] as xdr.ScVal;

    // `sym('Enhanced')` — the encoding this replaced — compared against the
    // expected value, so a regression fails here rather than as a trap on a
    // network.
    expect(wire(tier)).not.toEqual(wire(xdr.ScVal.scvSymbol('Enhanced')));
    expect(tier.type).not.toBe('scvU32');
  });

  it('carries every variant through, so none is silently unrepresentable', () => {
    for (const variant of ['None', 'Standard', 'Enhanced'] as const) {
      const tier = args(variant)[2] as xdr.ScVal;
      expect(wire(tier)).toEqual(wire(xdr.ScVal.scvVec([xdr.ScVal.scvSymbol(variant)])));
    }
  });

  it('sends the remaining arguments in the order the contract declares', () => {
    const encoded = args('Standard');
    expect(encoded).toHaveLength(7);

    expect(wire(encoded[0] as xdr.ScVal)).toEqual(wire(new Address(ATTESTER).toScVal()));
    expect(wire(encoded[1] as xdr.ScVal)).toEqual(wire(new Address(SUBJECT).toScVal()));
    // The commitment is a full 32-byte hash: a truncated one would still be a
    // plausible `ScVal` and the contract would reject it only at run time.
    // Built from a plain `Uint8Array` so the comparison is bytes-to-bytes: a
    // `Buffer` is a subclass of it, and comparing the two serialises differently
    // even though both encode the same 32 bytes.
    expect(wire(encoded[3] as xdr.ScVal)).toEqual(
      wire(xdr.ScVal.scvBytes(Uint8Array.from(HASH_BYTES))),
    );
    // `region_id` and `provider_id` really are `Symbol`s, unlike the tier: only
    // the enum takes the vector form, which is exactly the distinction that is
    // easy to get backwards.
    expect(wire(encoded[4] as xdr.ScVal)).toEqual(wire(xdr.ScVal.scvSymbol('NG_LAG')));
    expect(wire(encoded[5] as xdr.ScVal)).toEqual(wire(xdr.ScVal.scvSymbol('mock')));
    expect(wire(encoded[6] as xdr.ScVal)).toEqual(wire(xdr.ScVal.scvU64(1_789_000_000n)));
  });
});
