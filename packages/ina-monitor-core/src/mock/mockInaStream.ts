import type { ChipId, MeasurementFrame, MeasurementFrameMulti, MeasurementFrameSingle } from "../model.js";

export type MockWaveform =
  | { kind: "dc"; value: number }
  | { kind: "sine"; amplitude: number; freqHz: number; offset?: number }
  | { kind: "step"; t0_ms: number; before: number; after: number }
  | { kind: "noise"; sigma: number; base?: MockWaveform };

function randn(seed: { v: number }) {
  // deterministic-ish Box-Muller with xorshift32
  seed.v ^= seed.v << 13;
  seed.v ^= seed.v >>> 17;
  seed.v ^= seed.v << 5;
  const u1 = ((seed.v >>> 0) % 1_000_000) / 1_000_000;
  seed.v ^= seed.v << 13;
  seed.v ^= seed.v >>> 17;
  seed.v ^= seed.v << 5;
  const u2 = ((seed.v >>> 0) % 1_000_000) / 1_000_000;
  const r = Math.sqrt(-2 * Math.log(Math.max(u1, 1e-9)));
  const theta = 2 * Math.PI * u2;
  return r * Math.cos(theta);
}

function evalWave(w: MockWaveform, t_ms: number, seed: { v: number }): number {
  if (w.kind === "dc") return w.value;
  if (w.kind === "sine") {
    const off = w.offset ?? 0;
    return off + w.amplitude * Math.sin((2 * Math.PI * w.freqHz * t_ms) / 1000);
  }
  if (w.kind === "step") return t_ms < w.t0_ms ? w.before : w.after;
  // noise
  const base = w.base ? evalWave(w.base, t_ms, seed) : 0;
  return base + w.sigma * randn(seed);
}

export type MockInaConfig = {
  chip: ChipId;
  channelModel: "single" | { kind: "multi"; channelCount: 3 };
  sampleRate_Hz: number;
  busVoltage_V: MockWaveform;
  current_A: MockWaveform;
  seed?: number;
  /**
   * Multi-channel: per-channel time offset (ms) to stagger steps or demo three traces.
   * Default [0,0,0]; e.g. INA3221 mock may use [0, 600, 1200].
   */
  channelTimeOffsetsMs?: [number, number, number];
};

export async function* mockInaStream(cfg: MockInaConfig): AsyncGenerator<MeasurementFrame> {
  const dt_ms = 1000 / cfg.sampleRate_Hz;
  const seed = { v: cfg.seed ?? 123456789 };
  let seq = 0;
  const t0 = Date.now();
  for (;;) {
    const t_host_ms = Date.now();
    const t_rel = t_host_ms - t0;

    const V = evalWave(cfg.busVoltage_V, t_rel, seed);

    if (cfg.channelModel === "single") {
      const I = evalWave(cfg.current_A, t_rel, seed);
      const P = V * I;
      const f: MeasurementFrameSingle = {
        version: 1,
        chip: cfg.chip,
        seq,
        t_host_ms,
        channelModel: { kind: "single" },
        signals: { busVoltage_V: V, current_A: I, power_W: P }
      };
      yield f;
    } else {
      const offsets = cfg.channelTimeOffsetsMs ?? [0, 0, 0];
      const channels = Array.from({ length: cfg.channelModel.channelCount }, (_v, i) => {
        const scale = 1 + 0.02 * (i - 1);
        const tCh = t_rel - (offsets[i] ?? 0);
        const Ii = evalWave(cfg.current_A, tCh, seed);
        return { current_A: Ii * scale, power_W: V * Ii * scale };
      });
      const f: MeasurementFrameMulti = {
        version: 1,
        chip: cfg.chip,
        seq,
        t_host_ms,
        channelModel: { kind: "multi", channelCount: cfg.channelModel.channelCount },
        shared: { busVoltage_V: V },
        channels
      };
      yield f;
    }

    seq++;
    await new Promise((r) => setTimeout(r, dt_ms));
  }
}

