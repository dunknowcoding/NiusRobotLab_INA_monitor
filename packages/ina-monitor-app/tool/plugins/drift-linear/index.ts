import type { DcAnalysisContext, DcAnalysisPlugin, DcAnalysisResult } from "../../pluginSdk";
import { columnForSignal, extractFiniteSeries, linearRegression } from "../../pluginSdk";
import manifest from "./manifest.json";

function run(ctx: DcAnalysisContext): DcAnalysisResult {
  const yRaw = columnForSignal(ctx.series, ctx.signal);
  const { t, y } = extractFiniteSeries(ctx.series.t, yRaw);
  if (t.length < 2) {
    return {
      title: manifest.name,
      summary: "Need ≥2 finite samples to estimate drift.",
      metrics: {}
    };
  }
  const t0 = t[0]!;
  const xs = t.map((ti) => (ti - t0) / 1000);
  const { slope, intercept } = linearRegression(xs, y);
  const spanS = (t[t.length - 1]! - t0) / 1000;
  const delta = Number.isFinite(slope) && Number.isFinite(spanS) ? slope * spanS : NaN;
  return {
    title: manifest.name,
    summary: `OLS line vs. elapsed time (s) for ${ctx.signalLabel}.`,
    metrics: {
      slopePerS: slope,
      intercept: intercept,
      windowDuration_s: spanS,
      deltaEndToStart: delta
    }
  };
}

export const plugin: DcAnalysisPlugin = {
  manifest: manifest as DcAnalysisPlugin["manifest"],
  run
};
