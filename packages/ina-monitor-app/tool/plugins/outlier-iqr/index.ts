import type { DcAnalysisContext, DcAnalysisPlugin, DcAnalysisResult } from "../../pluginSdk";
import { columnForSignal, extractFiniteSeries, percentile, sortedCopy } from "../../pluginSdk";
import manifest from "./manifest.json";

function run(ctx: DcAnalysisContext): DcAnalysisResult {
  const yRaw = columnForSignal(ctx.series, ctx.signal);
  const { y } = extractFiniteSeries(ctx.series.t, yRaw);
  if (y.length < 4) {
    return {
      title: manifest.name,
      summary: "Need ≥4 finite samples for stable quartile estimates.",
      metrics: {}
    };
  }
  const s = sortedCopy(y);
  const q1 = percentile(s, 0.25);
  const q3 = percentile(s, 0.75);
  const iqr = q3 - q1;
  const low = q1 - 1.5 * iqr;
  const high = q3 + 1.5 * iqr;
  let out = 0;
  for (const v of y) {
    if (v < low || v > high) out++;
  }
  return {
    title: manifest.name,
    summary: "Tukey fences (1.5×IQR) on DC window; counts outside [low, high].",
    metrics: {
      Q1: q1,
      Q3: q3,
      IQR: iqr,
      fenceLow: low,
      fenceHigh: high,
      outliers: out
    }
  };
}

export const plugin: DcAnalysisPlugin = {
  manifest: manifest as DcAnalysisPlugin["manifest"],
  run
};
