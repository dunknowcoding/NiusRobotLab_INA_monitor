/**
 * DSP pipeline placeholder (P1): raw → optional filter/de-glitch → UI/metrics.
 * Wire protection to raw vs processed consistently with FaultDetector inputs.
 */

export type DspChainId = "none" | "ema" | "median3";

export type DspConfig = {
  chain: DspChainId;
  /** First-order IIR EMA coefficient α∈(0,1] */
  emaAlpha?: number;
};

export const defaultDspConfig: DspConfig = { chain: "none" };

/** Exponential moving average on a scalar stream */
export function ema1d(prev: number | undefined, x: number, alpha: number): number {
  if (prev === undefined) return x;
  return alpha * x + (1 - alpha) * prev;
}
