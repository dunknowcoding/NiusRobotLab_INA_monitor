import type { DcAnalysisContext, DcAnalysisPlugin, DcAnalysisResult } from "../../pluginSdk";
import { columnForSignal, extractFiniteSeries, stdSample } from "../../pluginSdk";
import { boxcarMeanFast } from "../../filterPluginSdk";
import manifest from "./manifest.json";

function run(ctx: DcAnalysisContext): DcAnalysisResult {
  const yRaw = columnForSignal(ctx.series, ctx.signal);
  const { y } = extractFiniteSeries(ctx.series.t, yRaw);
  if (y.length === 0) {
    return { title: manifest.name, summary: "No finite samples.", metrics: {} };
  }
  const w = Math.max(1, Math.floor(ctx.options?.window ?? 5));
  const sm = boxcarMeanFast(y, w);
  if (sm.length !== y.length) {
    return { title: manifest.name, summary: "Smoothing failed (length mismatch).", metrics: {} };
  }
  const resid = y.map((v, i) => v - sm[i]!);
  const residStd = stdSample(resid);
  const lastSm = sm[sm.length - 1]!;
  return {
    title: manifest.name,
    summary: `Internal boxcar length ${w} (analysis-only; independent of filter chain).`,
    metrics: {
      windowSamples: w,
      lastSmoothed: lastSm,
      residualStd: residStd
    }
  };
}

export const plugin: DcAnalysisPlugin = {
  manifest: manifest as DcAnalysisPlugin["manifest"],
  run
};
