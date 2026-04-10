import type { MeasurementFrame } from "@niusrobotlab/ina-monitor-core";

export type Ina3221UiMode = "single" | "all";

export type SeriesBundle = { t: number[]; v: number[]; i: number[]; p: number[] };

export const emptySeries = (): SeriesBundle => ({ t: [], v: [], i: [], p: [] });

export const emptyIna3221SeriesByCh = (): [SeriesBundle, SeriesBundle, SeriesBundle] => [
  emptySeries(),
  emptySeries(),
  emptySeries()
];

/** Ring buffer length for V/I/P time series in the UI */
export const SERIES_BUFFER_CAPACITY = 300;

const MAX_POINTS = SERIES_BUFFER_CAPACITY;

function pushPoint(s: SeriesBundle, t: number, v: number, i: number, p: number) {
  s.t.push(t);
  s.v.push(v);
  s.i.push(i);
  s.p.push(p);
  if (s.t.length > MAX_POINTS) {
    s.t = s.t.slice(-MAX_POINTS);
    s.v = s.v.slice(-MAX_POINTS);
    s.i = s.i.slice(-MAX_POINTS);
    s.p = s.p.slice(-MAX_POINTS);
  }
}

/** Split a multi-channel frame into three series (aligned with single-channel display rules). */
export function appendIna3221FrameToSeries(
  frame: MeasurementFrame,
  prev: [SeriesBundle, SeriesBundle, SeriesBundle],
  sharedV: number | undefined
): [SeriesBundle, SeriesBundle, SeriesBundle] {
  if (!("channels" in frame) || frame.channels.length < 3) return prev;
  const t = frame.t_host_ms;
  const next: [SeriesBundle, SeriesBundle, SeriesBundle] = [
    { ...prev[0], t: [...prev[0].t], v: [...prev[0].v], i: [...prev[0].i], p: [...prev[0].p] },
    { ...prev[1], t: [...prev[1].t], v: [...prev[1].v], i: [...prev[1].i], p: [...prev[1].p] },
    { ...prev[2], t: [...prev[2].t], v: [...prev[2].v], i: [...prev[2].i], p: [...prev[2].p] }
  ];
  for (let idx = 0; idx < 3; idx++) {
    const ch = frame.channels[idx]!;
    const V =
      typeof sharedV === "number" ? sharedV : typeof ch.busVoltage_V === "number" ? ch.busVoltage_V : NaN;
    const I = typeof ch.current_A === "number" ? ch.current_A : NaN;
    const P = typeof ch.power_W === "number" ? ch.power_W : NaN;
    pushPoint(next[idx], t, V, I, P);
  }
  return next;
}

/** Serial start command: single-channel poll vs all channels (firmware may extend; parsers often key on START). */
export function ina3221StartCommand(mode: Ina3221UiMode, singleCh: 0 | 1 | 2): string {
  if (mode === "all") return "START ALL\n";
  return `START CH${singleCh}\n`;
}

export function ina3221StopCommandForSwitch(): string {
  return "STOP\n";
}

export function ina3221ChannelStartCommand(ch: 0 | 1 | 2): string {
  return `START CH${ch}\n`;
}

export function ina3221ChannelStopCommand(ch: 0 | 1 | 2): string {
  return `STOP CH${ch}\n`;
}
