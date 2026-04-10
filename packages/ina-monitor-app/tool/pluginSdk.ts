/**
 * DC signal analysis plugin SDK (time-domain; no AC / spectrum workflow).
 * Add a plugin under tool/plugins/<id>/ with manifest.json + index.ts exporting `plugin`.
 */

export type DcSignalKey = "v" | "i" | "p";

export type DcSeriesBundle = {
  t: number[];
  v: number[];
  i: number[];
  p: number[];
};

export type DcPluginManifest = {
  id: string;
  name: string;
  description: string;
  version: string;
  domain: "dc";
};

export type DcToolOptions = {
  window?: number;
  thresholdHigh?: number;
  thresholdLow?: number;
};

export type DcAnalysisContext = {
  series: DcSeriesBundle;
  signal: DcSignalKey;
  signalLabel: string;
  sourceLabel: string;
  sampleCount: number;
  options?: DcToolOptions;
};

export type DcAnalysisResult = {
  title: string;
  summary: string;
  metrics?: Record<string, string | number>;
};

export type DcAnalysisPlugin = {
  manifest: DcPluginManifest;
  run(ctx: DcAnalysisContext): DcAnalysisResult | Promise<DcAnalysisResult>;
};

export function columnForSignal(s: DcSeriesBundle, signal: DcSignalKey): number[] {
  if (signal === "v") return s.v;
  if (signal === "i") return s.i;
  return s.p;
}

export function extractFiniteSeries(t: number[], y: number[]): { t: number[]; y: number[] } {
  const tt: number[] = [];
  const yy: number[] = [];
  const n = Math.min(t.length, y.length);
  for (let i = 0; i < n; i++) {
    const ti = t[i]!;
    const yi = y[i]!;
    if (Number.isFinite(ti) && Number.isFinite(yi)) {
      tt.push(ti);
      yy.push(yi);
    }
  }
  return { t: tt, y: yy };
}

export function mean(arr: number[]): number {
  if (arr.length === 0) return NaN;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

export function stdSample(arr: number[]): number {
  if (arr.length < 2) return NaN;
  const m = mean(arr);
  const v = arr.reduce((s, x) => s + (x - m) * (x - m), 0) / (arr.length - 1);
  return Math.sqrt(v);
}

export function linearRegression(xs: number[], ys: number[]): { slope: number; intercept: number } {
  const n = Math.min(xs.length, ys.length);
  if (n < 2) return { slope: NaN, intercept: NaN };
  let mx = 0;
  let my = 0;
  for (let i = 0; i < n; i++) {
    mx += xs[i]!;
    my += ys[i]!;
  }
  mx /= n;
  my /= n;
  let sxx = 0;
  let sxy = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i]! - mx;
    const dy = ys[i]! - my;
    sxx += dx * dx;
    sxy += dx * dy;
  }
  if (sxx < 1e-30) return { slope: NaN, intercept: my };
  const slope = sxy / sxx;
  const intercept = my - slope * mx;
  return { slope, intercept };
}

export function sortedCopy(arr: number[]): number[] {
  return [...arr].sort((a, b) => a - b);
}

/** Linear-interpolated quantile, p in [0,1], sorted array */
export function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return NaN;
  if (sorted.length === 1) return sorted[0]!;
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo]!;
  return sorted[lo]! * (hi - idx) + sorted[hi]! * (idx - lo);
}

export function medianUnsorted(arr: number[]): number {
  if (arr.length === 0) return NaN;
  const s = sortedCopy(arr);
  const mid = Math.floor(s.length / 2);
  if (s.length % 2 === 1) return s[mid]!;
  return (s[mid - 1]! + s[mid]!) / 2;
}
