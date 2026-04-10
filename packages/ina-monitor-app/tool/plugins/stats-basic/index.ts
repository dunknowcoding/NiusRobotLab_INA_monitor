import type { DcAnalysisContext, DcAnalysisPlugin, DcAnalysisResult } from "../../pluginSdk";
import { columnForSignal, extractFiniteSeries, mean, stdSample } from "../../pluginSdk";
import manifest from "./manifest.json";

function run(ctx: DcAnalysisContext): DcAnalysisResult {
  const yRaw = columnForSignal(ctx.series, ctx.signal);
  const { y } = extractFiniteSeries(ctx.series.t, yRaw);
  const n = y.length;
  if (n === 0) {
    return {
      title: manifest.name,
      summary: "No finite samples in the selected window.",
      metrics: {}
    };
  }
  let minV = y[0]!;
  let maxV = y[0]!;
  for (const v of y) {
    if (v < minV) minV = v;
    if (v > maxV) maxV = v;
  }
  const m = mean(y);
  const sd = stdSample(y);
  return {
    title: manifest.name,
    summary: `${n} finite samples on ${ctx.sourceLabel} · ${ctx.signalLabel}.`,
    metrics: {
      n,
      mean: m,
      min: minV,
      max: maxV,
      "σ (sample)": sd
    }
  };
}

export const plugin: DcAnalysisPlugin = {
  manifest: manifest as DcAnalysisPlugin["manifest"],
  run
};
