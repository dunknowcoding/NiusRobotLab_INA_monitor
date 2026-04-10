import type { DcAnalysisContext, DcAnalysisPlugin, DcAnalysisResult } from "../../pluginSdk";
import { columnForSignal, extractFiniteSeries } from "../../pluginSdk";
import manifest from "./manifest.json";

function run(ctx: DcAnalysisContext): DcAnalysisResult {
  const yRaw = columnForSignal(ctx.series, ctx.signal);
  const { y } = extractFiniteSeries(ctx.series.t, yRaw);
  if (y.length === 0) {
    return { title: manifest.name, summary: "No finite samples.", metrics: {} };
  }
  const hi = ctx.options?.thresholdHigh;
  const lo = ctx.options?.thresholdLow;
  const hiOk = typeof hi === "number" && Number.isFinite(hi);
  const loOk = typeof lo === "number" && Number.isFinite(lo);
  let over = 0;
  let under = 0;
  if (hiOk) for (const v of y) if (v > hi!) over++;
  if (loOk) for (const v of y) if (v < lo!) under++;
  if (!hiOk && !loOk) {
    return {
      title: manifest.name,
      summary: "Set at least one finite threshold (upper and/or lower) in the tool panel.",
      metrics: { n: y.length }
    };
  }
  return {
    title: manifest.name,
    summary: `Sample-wise compare vs. thresholds on ${ctx.signalLabel}.`,
    metrics: {
      n: y.length,
      ...(hiOk ? { countAboveHi: over } : {}),
      ...(loOk ? { countBelowLo: under } : {})
    }
  };
}

export const plugin: DcAnalysisPlugin = {
  manifest: manifest as DcAnalysisPlugin["manifest"],
  run
};
