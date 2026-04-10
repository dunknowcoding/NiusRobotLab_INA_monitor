/**
 * DC time-domain filter plugin SDK. Optimized for small INA ring buffers (typically ≤ a few hundred samples).
 */

export type DcFilterManifest = {
  id: string;
  name: string;
  description: string;
  version: string;
  domain: "dc";
};

/** Numeric parameters written from the UI */
export type DcFilterOptions = {
  window?: number;
  /** Direct EMA coefficient; if unset, derived from `window` span */
  alpha?: number;
  /** Slew limit: max |Δy| between consecutive samples (same units as y) */
  maxStep?: number;
};

export type DcFilterContext = {
  t: number[];
  y: number[];
  options?: DcFilterOptions;
};

export type DcFilterPlugin = {
  manifest: DcFilterManifest;
  /** Output length equals input; does not mutate `y` */
  filter(ctx: DcFilterContext): number[];
};

// --- Small-n helpers (minimize allocations; n is often ≤ 300) ---

/** O(n) symmetric boxcar mean; w = window length (≥1); edges use shortened windows */
export function boxcarMeanFast(y: ReadonlyArray<number>, w: number): number[] {
  const n = y.length;
  if (n === 0) return [];
  w = Math.max(1, Math.floor(w));
  if (w === 1) return y.slice();
  const half = Math.floor(w / 2);
  const ps = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) ps[i + 1] = ps[i]! + y[i]!;
  const out = new Array<number>(n);
  for (let i = 0; i < n; i++) {
    const l = Math.max(0, i - half);
    const r = Math.min(n - 1, i + half);
    const cnt = r - l + 1;
    out[i] = (ps[r + 1]! - ps[l]!) / cnt;
  }
  return out;
}

/** O(n) first-order exponential smoothing, alpha ∈ (0,1] */
export function emaFast(y: ReadonlyArray<number>, alpha: number): number[] {
  const n = y.length;
  if (n === 0) return [];
  const a = Math.min(1, Math.max(1e-9, alpha));
  const out = new Array<number>(n);
  out[0] = y[0]!;
  for (let i = 1; i < n; i++) {
    out[i] = a * y[i]! + (1 - a) * out[i - 1]!;
  }
  return out;
}

/** Map an equivalent span (samples) to EMA alpha (roughly N-sample memory) */
export function alphaFromSpan(span: number): number {
  const s = Math.max(1, Math.floor(span));
  return 2 / (s + 1);
}

/** O(n·w·log w) symmetric median filter; w odd; edges shortened (OK for small n) */
export function medianFilterFast(y: ReadonlyArray<number>, w: number): number[] {
  const n = y.length;
  if (n === 0) return [];
  w = Math.max(1, Math.floor(w));
  if (w % 2 === 0) w += 1;
  const half = (w - 1) >> 1;
  const out = new Array<number>(n);
  const part: number[] = [];
  for (let i = 0; i < n; i++) {
    const l = Math.max(0, i - half);
    const r = Math.min(n - 1, i + half);
    part.length = 0;
    for (let j = l; j <= r; j++) part.push(y[j]!);
    part.sort((a, b) => a - b);
    const k = part.length;
    const mid = k >> 1;
    out[i] = k % 2 === 1 ? part[mid]! : (part[mid - 1]! + part[mid]!) / 2;
  }
  return out;
}

/**
 * Clamp sample-to-sample step: |y[i] − y[i−1]| ≤ maxStep (physical units of y).
 * O(n), single output buffer.
 */
export function slewLimitFast(y: ReadonlyArray<number>, maxStep: number): number[] {
  const n = y.length;
  if (n === 0) return [];
  const m = Math.max(0, maxStep);
  const out = new Array<number>(n);
  out[0] = y[0]!;
  for (let i = 1; i < n; i++) {
    const d = y[i]! - out[i - 1]!;
    if (d > m) out[i] = out[i - 1]! + m;
    else if (d < -m) out[i] = out[i - 1]! - m;
    else out[i] = y[i]!;
  }
  return out;
}
