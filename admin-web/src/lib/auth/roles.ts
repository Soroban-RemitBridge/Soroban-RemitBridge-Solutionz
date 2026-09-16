/**
 * The role vocabulary.
 *
 * Its own module, with no imports, for one concrete reason: `accounts.ts` uses
 * `node:crypto` to verify passwords, and `middleware.ts` runs in the Edge runtime
 * where that import fails the build. When the roles lived in `accounts.ts`,
 * `session.ts` importing them dragged `node:crypto` into the Edge bundle and the
 * console would not build.
 *
 * So this file is the seam: everything the Edge touches imports roles from here,
 * and only the Node-only modules import `accounts.ts`.
 */

export const ROLES = ['viewer', 'operator', 'admin'] as const;

export type Role = (typeof ROLES)[number];
