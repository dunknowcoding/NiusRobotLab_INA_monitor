import type { DcAnalysisContext, DcAnalysisPlugin, DcAnalysisResult } from "../../pluginSdk";
import { columnForSignal, extractFiniteSeries } from "../../pluginSdk";
import manifest from "./manifest.json";

/** Trapezoidal ∫ y dt with t in ms → result in y-units × seconds */
function integrateTrapezoidMs(t: number[], y: number[]): number {
  if (t.length < 2 || y.length < 2) return NaN;
  let s = 0;
  for (let i = 1; i < t.length; i++) {
    const dt = (t[i]! - t[i - 1]!) / 1000;
    if (!Number.isFinite(dt) || dt <= 0) continue;
    s += 0.5 * (y[i]! + y[i - 1]!) * dt;
  }
  return s;
}

function run(ctx: DcAnalysisContext): DcAnalysisResult {
  const yRaw = columnForSignal(ctx.series, ctx.signal);
  const { t, y } = extractFiniteSeries(ctx.series.t, yRaw);
  if (t.length < 2) {
    return {
      title: manifest.name,
      summary: "Need ≥2 finite samples with strictly increasing timestamps for quadrature.",
      metrics: {}
    };
  }
  const integ = integrateTrapezoidMs(t, y);
  if (ctx.signal === "p") {
    const wh = integ / 3600;
    return {
      title: manifest.name,
      summary: "∫P·dt (DC hold); J and Wh columns.",
      metrics: {
        energy_J: integ,
        energy_Wh: wh
      }
    };
  }
  if (ctx.signal === "i") {
    const ah = integ / 3600;
    return {
      title: manifest.name,
      summary: "∫I·dt; As and Ah (assuming I in amperes).",
      metrics: {
        charge_As: integ,
        charge_Ah: ah
      }
    };
  }
  return {
    title: manifest.name,
    summary: "∫V·dt → volt·seconds (interpretation depends on use case).",
    metrics: {
      voltSeconds: integ
    }
  };
}

export const plugin: DcAnalysisPlugin = {
  manifest: manifest as DcAnalysisPlugin["manifest"],
  run
};
