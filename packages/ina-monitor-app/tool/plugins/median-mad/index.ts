import type { DcAnalysisContext, DcAnalysisPlugin, DcAnalysisResult } from "../../pluginSdk";
import { columnForSignal, extractFiniteSeries, medianUnsorted, sortedCopy } from "../../pluginSdk";
import manifest from "./manifest.json";

function madScale(y: number[], med: number): number {
  if (y.length === 0) return NaN;
  const devs = y.map((v) => Math.abs(v - med));
  return medianUnsorted(devs);
}

function run(ctx: DcAnalysisContext): DcAnalysisResult {
  const yRaw = columnForSignal(ctx.series, ctx.signal);
  const { y } = extractFiniteSeries(ctx.series.t, yRaw);
  if (y.length === 0) {
    return { title: manifest.name, summary: "No finite samples.", metrics: {} };
  }
  const med = medianUnsorted(y);
  const mad = madScale(y, med);
  const s = sortedCopy(y);
  const lo = s[0]!;
  const hi = s[s.length - 1]!;
  return {
    title: manifest.name,
    summary: "Robust center (median) and dispersion (MAD of deviations).",
    metrics: {
      median: med,
      MAD: mad,
      min: lo,
      max: hi,
      n: y.length
    }
  };
}

export const plugin: DcAnalysisPlugin = {
  manifest: manifest as DcAnalysisPlugin["manifest"],
  run
};
