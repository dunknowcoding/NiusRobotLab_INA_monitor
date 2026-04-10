import type { DcFilterOptions, DcFilterPlugin } from "../../tool/filterPluginSdk";
import { columnForSignal, type DcSeriesBundle, type DcSignalKey } from "../../tool/pluginSdk";

/** One pipeline stage in the UI (`uid` is for React keys only) */
export type DcPipelineStep = {
  uid: string;
  id: string;
  window?: number;
  alpha?: number;
  maxStep?: number;
};

export function bundleWithSignalColumn(t: number[], y: number[], signal: DcSignalKey): DcSeriesBundle {
  const n = t.length;
  const v: number[] = new Array(n);
  const i: number[] = new Array(n);
  const p: number[] = new Array(n);
  for (let k = 0; k < n; k++) {
    const val = y[k]!;
    v[k] = signal === "v" ? val : 0;
    i[k] = signal === "i" ? val : 0;
    p[k] = signal === "p" ? val : 0;
  }
  return { t, v, i, p };
}

function stepLabel(name: string, id: string, step: Omit<DcPipelineStep, "uid">): string {
  if (id === "ema") {
    if (step.alpha != null && step.alpha > 0 && step.alpha <= 1) {
      return `${name}(α=${step.alpha.toFixed(4)})`;
    }
    return `${name}(span=${step.window ?? 8})`;
  }
  if (id === "slew-limit") {
    return `${name}(Δ≤${step.maxStep ?? "?"})`;
  }
  return `${name}(w=${step.window ?? 5})`;
}

/**
 * Apply the filter chain in order. Empty chain returns a shallow copy of `y`.
 * Allocates one intermediate buffer per stage; length n matches the windowed series.
 */
export function applyDcFilterPipeline(
  t: number[],
  y: number[],
  pipeline: DcPipelineStep[],
  byId: Map<string, DcFilterPlugin>
): { yOut: number[]; chainLine: string } {
  if (pipeline.length === 0) {
    return { yOut: y.slice(), chainLine: "Identity (no filters in chain)" };
  }
  let cur = y;
  const parts: string[] = [];
  for (const step of pipeline) {
    const p = byId.get(step.id);
    if (!p) continue;
    const opts: DcFilterOptions = {};
    if (step.window != null) opts.window = step.window;
    if (step.alpha != null) opts.alpha = step.alpha;
    if (step.maxStep != null) opts.maxStep = step.maxStep;
    cur = p.filter({ t, y: cur, options: Object.keys(opts).length ? opts : undefined });
    parts.push(stepLabel(p.manifest.name, step.id, step));
  }
  return {
    yOut: cur,
    chainLine: parts.length ? `Applied: ${parts.join(" → ")}` : "Identity (no filters in chain)"
  };
}

/**
 * Write filtered samples back into the full ring-buffer column for plotting and analysis.
 * Replaces values only at finite (t,y) indices; returns the same bundle reference if the chain is empty.
 */
export function applyFiltersToSeriesColumn(
  bundle: DcSeriesBundle,
  signal: DcSignalKey,
  pipeline: DcPipelineStep[],
  byId: Map<string, DcFilterPlugin>
): DcSeriesBundle {
  if (pipeline.length === 0) return bundle;
  const col = columnForSignal(bundle, signal);
  const t = bundle.t;
  const yIn: number[] = [];
  const idxMap: number[] = [];
  const n = Math.min(t.length, col.length);
  for (let i = 0; i < n; i++) {
    if (Number.isFinite(t[i]) && Number.isFinite(col[i])) {
      idxMap.push(i);
      yIn.push(col[i]!);
    }
  }
  if (yIn.length === 0) return bundle;
  const tSub = idxMap.map((j) => t[j]!);
  const { yOut } = applyDcFilterPipeline(tSub, yIn, pipeline, byId);
  if (yOut.length !== idxMap.length) return bundle;
  const newCol = col.slice();
  for (let k = 0; k < idxMap.length; k++) {
    newCol[idxMap[k]!] = yOut[k]!;
  }
  if (signal === "v") {
    return { t: bundle.t, v: newCol, i: bundle.i, p: bundle.p };
  }
  if (signal === "i") {
    return { t: bundle.t, v: bundle.v, i: newCol, p: bundle.p };
  }
  return { t: bundle.t, v: bundle.v, i: bundle.i, p: newCol };
}
