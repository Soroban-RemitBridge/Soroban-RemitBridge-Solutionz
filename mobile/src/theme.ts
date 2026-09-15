/**
 * Theme tokens.
 *
 * One palette for one app. The status colours are here rather than inlined so
 * that "this transfer is expired" and "this transfer is claimed" cannot drift
 * apart between the sender and agent screens — the same person is often looking
 * at both, on the same phone, in the same shop.
 *
 * Light mode only, deliberately: the recipient flow is used outdoors, in
 * daylight, often on a low-end device with the screen turned up for a QR code.
 * Following the system theme into dark mode would make the one screen that most
 * needs to be legible the one that is hardest to read.
 */

export const colors = {
  background: '#f8fafc',
  surface: '#ffffff',
  border: '#e2e8f0',
  borderStrong: '#cbd5e1',

  ink900: '#0f172a',
  ink700: '#334155',
  ink500: '#64748b',
  ink300: '#94a3b8',

  primary: '#0f172a',
  primaryText: '#ffffff',

  good: '#047857',
  goodSurface: '#ecfdf5',
  warn: '#b45309',
  warnSurface: '#fffbeb',
  bad: '#be123c',
  badSurface: '#fff1f2',
  info: '#0369a1',
  infoSurface: '#f0f9ff',
} as const;

export const spacing = {
  xs: 4,
  sm: 8,
  md: 16,
  lg: 24,
  xl: 32,
} as const;

export const radius = {
  sm: 6,
  md: 10,
  lg: 16,
} as const;

export const typography = {
  title: { fontSize: 22, fontWeight: '700' },
  subtitle: { fontSize: 16, fontWeight: '600' },
  body: { fontSize: 15 },
  label: { fontSize: 12, fontWeight: '600', letterSpacing: 0.6, textTransform: 'uppercase' },
  // Claim codes are read aloud and written down. Monospace plus generous
  // letter-spacing is the difference between a working transfer and a support
  // call.
  code: { fontSize: 22, fontWeight: '700', letterSpacing: 2 },
} as const;
