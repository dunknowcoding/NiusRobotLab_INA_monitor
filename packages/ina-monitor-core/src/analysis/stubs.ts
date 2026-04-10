/**
 * Analysis module placeholders (P1): online stats, energy, FFT/PSD, Allan deviation, etc.
 * Keep pure functions for unit tests; avoid blocking the main thread (may move to a Worker).
 */

export type StatsWindow = {
  min: number;
  max: number;
  mean: number;
  sum: number;
  count: number;
};

export function emptyStats(): StatsWindow {
  return { min: Infinity, max: -Infinity, mean: 0, sum: 0, count: 0 };
}

/** Placeholder: trapezoidal integration of P over time, delta_t in seconds */
export function integratePowerTrapz(power_W: number[], delta_t_s: number): number {
  if (power_W.length < 2) return 0;
  let e = 0;
  for (let i = 1; i < power_W.length; i++) {
    e += 0.5 * (power_W[i - 1]! + power_W[i]!) * delta_t_s;
  }
  return e;
}
