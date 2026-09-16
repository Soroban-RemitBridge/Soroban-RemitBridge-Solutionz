import { describe, expect, it } from 'vitest';

import { parseDeployConfigJson } from '../src/config/deploy-config.js';

/**
 * The deployment configuration is the one object that both the contracts and the
 * operator console describe to a customer, so the interesting cases here are the
 * ones where the JSON is *present but wrong*. Every one of those must throw: a
 * deployment that sets `DEPLOY_CONFIG_JSON` has decided where the read model comes
 * from, and a silent fallback to a file (or to no rows at all) would put tier
 * bands on screen that nobody reviewed.
 */

const region = {
  id: 'ng-lagos',
  displayName: 'Lagos, Nigeria',
  countryCode: 'NG',
  currency: 'NGN',
  minBond: '5000000000',
  maxAgents: 25,
  utilizationCapBps: 7000,
};

const corridor = {
  id: 'usd-ngn',
  regionId: 'ng-lagos',
  sourceCurrency: 'USD',
  destCurrency: 'NGN',
  tier1Max: '1000000000',
  tier2Max: '5000000000',
  dailyLimit: '20000000000',
  spreadBps: 75,
};

const config = { regions: [region], corridors: [corridor] };

describe('parseDeployConfigJson', () => {
  it('treats an unset or blank variable as "the caller should use the file"', () => {
    expect(parseDeployConfigJson(undefined)).toBeUndefined();
    expect(parseDeployConfigJson('')).toBeUndefined();
    expect(parseDeployConfigJson('   \n ')).toBeUndefined();
  });

  it('parses a complete configuration', () => {
    expect(parseDeployConfigJson(JSON.stringify(config))).toEqual(config);
  });

  it('drops unknown keys rather than letting them reach the database', () => {
    const parsed = parseDeployConfigJson(
      JSON.stringify({ ...config, regions: [{ ...region, reviewedBy: 'someone' }] }),
    );
    expect(parsed?.regions[0]).not.toHaveProperty('reviewedBy');
  });

  it('names the variable when the JSON does not parse', () => {
    expect(() => parseDeployConfigJson('{"regions": [')).toThrowError(/DEPLOY_CONFIG_JSON is not valid JSON/);
  });

  it('names the offending field when a value has the wrong type', () => {
    const broken = { ...config, corridors: [{ ...corridor, spreadBps: '75' }] };
    expect(() => parseDeployConfigJson(JSON.stringify(broken))).toThrowError(
      /corridors\.0\.spreadBps/,
    );
  });

  it('rejects a config that parses as JSON but is not a config', () => {
    expect(() => parseDeployConfigJson('{"regions": []}')).toThrowError(/corridors/);
    expect(() => parseDeployConfigJson('[]')).toThrowError(/DEPLOY_CONFIG_JSON is invalid/);
  });
});
