import type { DcAnalysisContext, DcAnalysisPlugin, DcAnalysisResult } from "../../pluginSdk";
import { columnForSignal, extractFiniteSeries, mean } from "../../pluginSdk";
import manifest from "./manifest.json";

function run(ctx: DcAnalysisContext): DcAnalysisResult {
  const yRaw = columnForSignal(ctx.series, ctx.signal);
  const { t, y } = extractFiniteSeries(ctx.series.t, yRaw);
  if (t.length < 2) {
    return { title: manifest.name, summary: "Need ≥2 finite (t,y) pairs.", metrics: {} };
  }
  const rates: number[] = [];
  for (let i = 1; i < t.length; i++) {
    const dt = (t[i]! - t[i - 1]!) / 1000;
    if (!Number.isFinite(dt) || dt <= 0) continue;
    rates.push((y[i]! - y[i - 1]!) / dt);
  }
  if (rates.length === 0) {
    return { title: manifest.name, summary: "No valid Δt between consecutive samples.", metrics: {} };
  }
  const abs = rates.map((r) => Math.abs(r));
  const mx = Math.max(...abs);
  const absMean = mean(abs);
  return {
    title: manifest.name,
    summary: `|d(${ctx.signalLabel})/dt| from backward differences; Δt from timestamps (s).`,
    metrics: {
      meanAbsRate: absMean,
      peakAbsRate: mx,
      segments: rates.length
    }
  };
}

export const plugin: DcAnalysisPlugin = {
  manifest: manifest as DcAnalysisPlugin["manifest"],
  run
};
