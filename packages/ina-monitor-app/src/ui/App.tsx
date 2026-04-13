import React, { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import type {
  ChipDetectionResult,
  ChipId,
  LimitMode,
  MeasurementFrame,
  ProtectionConfig,
  SoftAlarms
} from "@niusrobotlab/ina-monitor-core";
import {
  createMonitorEngine,
  defaultProtectionConfig,
  effectiveCurrentOver_A,
  effectivePowerOver_W,
  effectiveVoltageThresholds,
  mockInaStream
} from "@niusrobotlab/ina-monitor-core";
import {
  appendIna3221FrameToSeries,
  emptyIna3221SeriesByCh,
  emptySeries,
  ina3221ChannelStartCommand,
  ina3221ChannelStopCommand,
  ina3221StartCommand,
  ina3221StopCommandForSwitch,
  seriesBufferCapacityHz,
  type Ina3221UiMode,
  type SeriesBundle
} from "./ina3221Helpers";
import { CHIP_UI_GROUPS, chipOptionLabel } from "./chipCatalog";
import { DC_ANALYSIS_PLUGINS } from "../tools/dcPluginRegistry";
import { DC_FILTER_PLUGINS, filterPluginMap } from "../tools/dcFilterRegistry";
import { applyFiltersToSeriesColumn, type DcPipelineStep } from "../tools/dcFilterPipeline";
import type { DcSignalKey } from "../../tool/pluginSdk";
import { buildDcToolsSnapshot, DcToolsPanel } from "./DcToolsPanel";
import { IconConnect, IconDisconnect, IconStart, IconStop } from "./SourceControlIcons";

type Mode = "basic" | "advanced";

/** Inferred from device JSON `addr` (0x.. = I²C, SPI = SPI-only bridge). */
type SerialLinkBus = "unknown" | "i2c" | "spi";

function inferSerialLinkBus(addr: unknown): SerialLinkBus {
  if (typeof addr !== "string") return "unknown";
  const a = addr.trim();
  if (/^spi$/i.test(a)) return "spi";
  if (/^0x[0-9a-fA-F]{1,2}$/.test(a)) return "i2c";
  return "unknown";
}

function maxSampleRateForBus(bus: SerialLinkBus): number {
  return bus === "spi" ? 2000 : 400;
}

const SAMPLE_RATES_I2C = [1, 2, 5, 10, 20, 50, 100, 200, 400] as const;
const SAMPLE_RATES_SPI_EXTRA = [500, 800, 1000, 1500, 2000] as const;

function sampleRateMenuValues(bus: SerialLinkBus): number[] {
  return bus === "spi" ? [...SAMPLE_RATES_I2C, ...SAMPLE_RATES_SPI_EXTRA] : [...SAMPLE_RATES_I2C];
}

function clampSampleRateForBus(hz: number, bus: SerialLinkBus): number {
  const cap = maxSampleRateForBus(bus);
  return Math.min(Math.max(1, Math.round(hz)), cap);
}

/** Serial: chip from device JSON only. Mock: user-selected simulated part. */
function effectiveChip(s: Source): ChipId {
  if (s.transport === "Serial") {
    return s.detected?.detectedChip ?? "UNKNOWN";
  }
  return s.selectedChip;
}

/**
 * Max points drawn per trace (evenly subsampled). Capped lower at high Hz so polylines are readable
 * and SVG updates are less smeared than ~2.4*Hz with a 2400 ceiling.
 */
function plotDecimationMax(sampleHz: number): number {
  const hz = Math.max(1, sampleHz);
  const raw = Math.round(160 + hz * 0.42);
  return Math.min(480, Math.max(200, raw));
}

/** V/I/P cards: 5 Hz — readable at high stream rates. */
const METRIC_DISPLAY_INTERVAL_MS = 200;

/**
 * Chart redraw cadence: at ≥20 Hz sampling, cap to ~20 Hz motion (50 ms); slower sampling follows the sample period.
 */
function chartUiThrottleMs(sampleHz: number): number {
  const hz = Math.max(1, sampleHz);
  return Math.max(50, 1000 / hz);
}

function snapshotSeriesBundle(s: SeriesBundle): SeriesBundle {
  return { t: s.t.slice(), v: s.v.slice(), i: s.i.slice(), p: s.p.slice() };
}

function useThrottledPlotSeries(series: SeriesBundle, intervalMs: number): SeriesBundle {
  const latestRef = useRef(series);
  latestRef.current = series;
  const [display, setDisplay] = useState(() => snapshotSeriesBundle(series));
  useEffect(() => {
    setDisplay(snapshotSeriesBundle(latestRef.current));
    const id = window.setInterval(() => {
      setDisplay(snapshotSeriesBundle(latestRef.current));
    }, intervalMs);
    return () => window.clearInterval(id);
  }, [intervalMs]);
  return display;
}

/** Browser tab has no preload — serial bridge unavailable */
const MSG_NO_ELECTRON =
  "Serial is only available in the Electron app window opened by npm run dev. Do not use Chrome/Edge to open localhost:5173 directly.";

/** Electron shell without working preload */
const MSG_PRELOAD_MISSING =
  "Serial bridge not ready (preload missing). Fully quit, run npm run dev again, or run npm run build:electron and check the terminal for errors.";

function serialBridgeUnavailableMessage(): string {
  if (typeof window !== "undefined" && window.__INA_MONITOR_SHELL__ === "electron") {
    return MSG_PRELOAD_MISSING;
  }
  return MSG_NO_ELECTRON;
}

function getInaApi() {
  return typeof window !== "undefined" ? window.inaApi : undefined;
}

/** Match electron/main canonicalSerialPath so COM paths compare consistently */
function normalizeSerialPathForMatch(p: string): string {
  let s = p.trim();
  const low = s.toLowerCase();
  if (low.startsWith("\\\\.\\") || low.startsWith("//./")) {
    s = s.slice(4);
  }
  if (/^com\d+$/i.test(s)) {
    return s.toUpperCase();
  }
  return s;
}

function serialPathsEqual(a: string, b: string): boolean {
  return normalizeSerialPathForMatch(a) === normalizeSerialPathForMatch(b);
}

function fmt(n: number | undefined, unit: string, digits = 3) {
  if (typeof n !== "number" || Number.isNaN(n)) return `— ${unit}`;
  return `${n.toFixed(digits)} ${unit}`;
}

function softAlarmsLabel(soft: SoftAlarms): string | null {
  const parts: string[] = [];
  if (soft.voltage === "over") parts.push("V high");
  if (soft.voltage === "under") parts.push("V low");
  if (soft.current === "over") parts.push("I high");
  if (soft.power === "over") parts.push("P high");
  return parts.length ? parts.join(" · ") : null;
}

function framePickSingle(frame: MeasurementFrame) {
  if ("signals" in frame) return frame.signals;
  const V = frame.shared?.busVoltage_V;
  let I: number | undefined;
  let P: number | undefined;
  for (const ch of frame.channels) {
    const ci = ch.current_A;
    if (typeof ci === "number" && (I === undefined || Math.abs(ci) > Math.abs(I))) I = ci;
    const cp = ch.power_W;
    if (typeof cp === "number" && (P === undefined || Math.abs(cp) > Math.abs(P))) P = cp;
  }
  return { busVoltage_V: V, current_A: I, power_W: P };
}

/** Multi-channel aggregate (max |I|) or one channel; single-channel frame is one signal */
function framePickForDisplay(
  frame: MeasurementFrame | null | undefined,
  displayChannel: "aggregate" | 0 | 1 | 2
): { busVoltage_V?: number; current_A?: number; power_W?: number } {
  if (!frame) return {};
  if ("signals" in frame) return frame.signals;
  const Vshared = frame.shared?.busVoltage_V;
  if (displayChannel === "aggregate") return framePickSingle(frame);
  const ch = frame.channels[displayChannel];
  if (!ch) return {};
  return {
    busVoltage_V: typeof Vshared === "number" ? Vshared : ch.busVoltage_V,
    current_A: ch.current_A,
    power_W: ch.power_W
  };
}

function isMultiChannelChipId(chip: ChipId): boolean {
  return chip === "INA3221" || chip === "INA3221-Q1";
}

type SourceTransport = "Mock" | "Serial" | "UsbI2c";
type DisplayChannel = "aggregate" | 0 | 1 | 2;

type Source = {
  sourceId: string;
  transport: SourceTransport;
  /** 1-based slot for hardware serial list (label: Source N — port) */
  hardwareSlot?: number;
  /** e.g. COM6 — required for Serial transport */
  serialPath?: string;
  selectedChip: ChipId;
  detected?: ChipDetectionResult;
  /** Set from JSON `addr` once INFO/sample lines arrive (Serial only). */
  serialLinkBus?: SerialLinkBus;
  sampleRate: number;
  connected: boolean;
  monitoring: boolean;
  Imax: number;
  Vnom: number;
  lastFrame: MeasurementFrame | null;
  faultText: string | null;
  series: { t: number[]; v: number[]; i: number[]; p: number[] };
  /** Session time origin for X axis (relative ms) after Start */
  chartSessionOriginMs: number | null;
  /** Advanced: merge over defaults from Imax/Vnom/sample rate */
  protectionOverrides?: Partial<ProtectionConfig>;
  /** Multi-channel: plot/card channel vs aggregate (engine still uses full frame max |I|) */
  displayChannel?: DisplayChannel;
  /** INA3221: single-channel poll vs all-channel view */
  ina3221UiMode?: Ina3221UiMode;
  /** Single-channel UI channel index (0 = CH1) */
  ina3221SingleChannel?: 0 | 1 | 2;
  /** Per-channel run memory when leaving a channel while monitoring */
  ina3221RunMemory?: Partial<Record<0 | 1 | 2, boolean>>;
  /** All-channel: per-channel user start state */
  ina3221ChannelRun?: [boolean, boolean, boolean];
  /** All-channel: separate plot buffers */
  ina3221SeriesByCh?: [SeriesBundle, SeriesBundle, SeriesBundle];
  /** All-channel: per-channel session origins */
  chartSessionOriginMsByCh?: [number | null, number | null, number | null];
};

/** Clear INA3221 runtime buffers on Stop/disconnect */
function clearIna3221RuntimeBuffers(chip: ChipId): Partial<Source> {
  if (!isMultiChannelChipId(chip)) return {};
  return {
    ina3221SeriesByCh: undefined,
    chartSessionOriginMsByCh: undefined,
    ina3221ChannelRun: undefined
  };
}

/** Same V/I/P pick as plot/cards */
function pickSignalsForSource(s: Source): { busVoltage_V?: number; current_A?: number; power_W?: number } {
  if (!s.lastFrame) return {};
  if (isMultiChannelChipId(effectiveChip(s)) && (s.ina3221UiMode ?? "single") === "all" && "channels" in s.lastFrame) {
    if (typeof s.displayChannel === "number") {
      return pickSignalsIna3221Channel(s.lastFrame, s.displayChannel);
    }
    return framePickSingle(s.lastFrame);
  }
  if (isMultiChannelChipId(effectiveChip(s)) && (s.ina3221UiMode ?? "single") === "single") {
    const ch = (s.ina3221SingleChannel ??
      (typeof s.displayChannel === "number" ? s.displayChannel : 0)) as 0 | 1 | 2;
    return framePickForDisplay(s.lastFrame, ch);
  }
  return framePickForDisplay(s.lastFrame, s.displayChannel ?? "aggregate");
}

function pickSignalsIna3221Channel(
  frame: MeasurementFrame,
  ch: 0 | 1 | 2
): { busVoltage_V?: number; current_A?: number; power_W?: number } {
  if (!("channels" in frame) || !frame.channels[ch]) return {};
  const Vshared = frame.shared?.busVoltage_V;
  const c = frame.channels[ch]!;
  return {
    busVoltage_V: typeof Vshared === "number" ? Vshared : c.busVoltage_V,
    current_A: c.current_A,
    power_W: c.power_W
  };
}

/** Source list chip column: serial shows JSON-reported model only; mock shows selected sim chip */
function sourceListChipDisplay(s: Source): string {
  if (s.transport === "Serial") {
    return s.detected?.detectedChip ?? "—";
  }
  return s.selectedChip;
}

function formatHardwareSourceTitle(s: Source): string {
  if (s.transport === "Serial" && s.hardwareSlot != null) {
    const port = s.serialPath?.trim() || "—";
    return `Source ${s.hardwareSlot} — ${port}`;
  }
  if (s.transport === "Mock") {
    const short = s.sourceId.replace(/^Mock - /, "");
    return `Sim — ${short}`;
  }
  return s.sourceId;
}

/** Compact tag for status / alarms (uses selectedChip — correct per mock INA219/226/3221) */
function compactSourceTag(s: Source): string {
  if (s.transport === "Serial" && s.hardwareSlot != null) {
    return `S${s.hardwareSlot} ${s.serialPath?.trim() || "?"}`;
  }
  return `Sim·${s.selectedChip}`;
}

/** INA3221 routing suffix only (avoids repeating chip name from compactSourceTag) */
function ina3221RouteSuffix(s: Source): string {
  if (!isMultiChannelChipId(effectiveChip(s))) return "";
  if ((s.ina3221UiMode ?? "single") === "all") {
    if (typeof s.displayChannel === "number") return ` ·M${s.displayChannel + 1}`;
    return " ·MΣ";
  }
  const ch = s.ina3221SingleChannel ?? (typeof s.displayChannel === "number" ? s.displayChannel : 0);
  return ` ·CH${ch + 1}`;
}

function engineStateShort(name: string): string {
  if (name === "Monitoring") return "MON";
  if (name === "FaultLatched") return "FLT";
  if (name === "Idle") return "IDLE";
  return name;
}

function makeSerialSources(): Source[] {
  const list: Source[] = [];
  for (let slot = 1; slot <= 16; slot++) {
    const id = `HW${String(slot).padStart(2, "0")}`;
    list.push({
      sourceId: id,
      hardwareSlot: slot,
      transport: "Serial",
      serialPath: `COM${slot}`,
      selectedChip: "UNKNOWN",
      serialLinkBus: "unknown",
      sampleRate: 10,
      connected: false,
      monitoring: false,
      Imax: 3.2,
      Vnom: 3.3,
      lastFrame: null,
      faultText: null,
      series: emptySeries(),
      chartSessionOriginMs: null
    });
  }
  return list;
}

function LiveMetricTriple(p: {
  busVoltage_V?: number;
  current_A?: number;
  power_W?: number;
  className?: string;
}) {
  const latestRef = useRef(p);
  latestRef.current = p;
  const [disp, setDisp] = useState({
    busVoltage_V: p.busVoltage_V,
    current_A: p.current_A,
    power_W: p.power_W
  });
  useEffect(() => {
    const id = window.setInterval(() => {
      const c = latestRef.current;
      setDisp({ busVoltage_V: c.busVoltage_V, current_A: c.current_A, power_W: c.power_W });
    }, METRIC_DISPLAY_INTERVAL_MS);
    return () => window.clearInterval(id);
  }, []);
  return (
    <div className={`cards cardsCompact${p.className ? ` ${p.className}` : ""}`}>
      <div className="card">
        <div className="cardTitle">Vbus</div>
        <div className="cardValue">{fmt(disp.busVoltage_V, "V", 3)}</div>
      </div>
      <div className="card">
        <div className="cardTitle">I</div>
        <div className="cardValue">{fmt(disp.current_A, "A", 3)}</div>
      </div>
      <div className="card">
        <div className="cardTitle">P</div>
        <div className="cardValue">{fmt(disp.power_W, "W", 3)}</div>
      </div>
    </div>
  );
}

type MonitoringStripItem = {
  key: string;
  source: Source;
  /** INA3221 3-ch mode: which shunt row; null = use whole-source series + SourceStripReadouts */
  ina3221Ch: 0 | 1 | 2 | null;
  series: SeriesBundle;
  sessionOriginMs: number | null;
};

/** Multi-strip: expand each INA3221 “3-ch strip” source into 1 or 3 plot rows based on Metrics (aggregate vs CHn). */
function expandMonitoringChartStrips(sources: Source[]): MonitoringStripItem[] {
  const out: MonitoringStripItem[] = [];
  for (const s of sources) {
    if (isMultiChannelChipId(effectiveChip(s)) && (s.ina3221UiMode ?? "single") === "all") {
      const byCh = s.ina3221SeriesByCh ?? emptyIna3221SeriesByCh();
      const origins = s.chartSessionOriginMsByCh ?? [null, null, null];
      const dc = s.displayChannel;
      if (dc === undefined || dc === "aggregate") {
        for (let i = 0; i < 3; i++) {
          out.push({
            key: `${s.sourceId}-ch${i}`,
            source: s,
            ina3221Ch: i as 0 | 1 | 2,
            series: byCh[i]!,
            sessionOriginMs: origins[i] ?? null
          });
        }
      } else {
        const i = dc as 0 | 1 | 2;
        out.push({
          key: `${s.sourceId}-ch${i}`,
          source: s,
          ina3221Ch: i,
          series: byCh[i]!,
          sessionOriginMs: origins[i] ?? null
        });
      }
    } else {
      out.push({
        key: s.sourceId,
        source: s,
        ina3221Ch: null,
        series: s.series,
        sessionOriginMs: s.chartSessionOriginMs
      });
    }
  }
  return out;
}

/** V/I/P readouts aligned under each chart strip (multi-source or INA3221 CH) */
function SourceStripReadouts({ s }: { s: Source }) {
  return (
    <div className="chartStripMetrics">
      <LiveMetricTriple {...pickSignalsForSource(s)} className="cardsStripEmbedded" />
    </div>
  );
}

function buildProtectionConfig(source: Source): ProtectionConfig {
  const base = defaultProtectionConfig({
    sampleRate_Hz: source.sampleRate,
    I_max_expected_A: source.Imax,
    V_nominal_V: source.Vnom,
    chip: effectiveChip(source)
  });
  return { ...base, ...source.protectionOverrides };
}

function mockDetectChip(selected: ChipId, sourceId: string): ChipDetectionResult | undefined {
  if (sourceId === "Mock - mismatch INA226" && selected !== "INA226") {
    return { detectedChip: "INA226", confidence: "strong", details: "Mock: intentional mismatch", evidence: { deviceId: "0x226" } };
  }
  if (sourceId === "Mock - mismatch INA3221" && selected !== "INA3221") {
    return { detectedChip: "INA3221", confidence: "medium", details: "Mock: intentional mismatch", evidence: { hint: "multi-channel" } };
  }
  return { detectedChip: selected, confidence: "unknown", details: "Mock: matches selection" };
}

export function App() {
  const [mode, setMode] = useState<Mode>("basic");
  const [ports, setPorts] = useState<{ path: string; manufacturer?: string }[]>([]);

  useEffect(() => {
    void (async () => {
      try {
        const list = (await getInaApi()?.listSerialPorts?.()) ?? [];
        setPorts(list.map((p) => ({ path: p.path, manufacturer: p.manufacturer })));
      } catch {
        /* ignore */
      }
    })();
  }, []);
  const [sources, setSources] = useState<Source[]>(() => [
    ...makeSerialSources(),
    {
      sourceId: "Mock - INA219",
      transport: "Mock",
      selectedChip: "INA219",
      sampleRate: 10,
      connected: false,
      monitoring: false,
      Imax: 2.0,
      Vnom: 5.0,
      lastFrame: null,
      faultText: null,
      series: { t: [], v: [], i: [], p: [] },
      chartSessionOriginMs: null
    },
    {
      sourceId: "Mock - INA226",
      transport: "Mock",
      selectedChip: "INA226",
      sampleRate: 10,
      connected: false,
      monitoring: false,
      Imax: 1.0,
      Vnom: 12.0,
      lastFrame: null,
      faultText: null,
      series: { t: [], v: [], i: [], p: [] },
      chartSessionOriginMs: null
    },
    {
      sourceId: "Mock - INA3221",
      transport: "Mock",
      selectedChip: "INA3221",
      sampleRate: 10,
      connected: false,
      monitoring: false,
      Imax: 3.2,
      Vnom: 12.0,
      lastFrame: null,
      faultText: null,
      series: { t: [], v: [], i: [], p: [] },
      chartSessionOriginMs: null,
      displayChannel: "aggregate",
      ina3221UiMode: "all",
      ina3221SingleChannel: 0,
      ina3221ChannelRun: [true, true, true],
      ina3221SeriesByCh: emptyIna3221SeriesByCh(),
      chartSessionOriginMsByCh: [null, null, null]
    }
  ]);
  const [activeSourceId, setActiveSourceId] = useState<string>("HW06");
  /** Plot every active Serial/Mock source when multi-source is enabled */
  const [multiSerialChart, setMultiSerialChart] = useState(false);

  /** DC tools: filter pipeline + signal owned here; plot preview shares filtered column */
  const [dcFilterPipeline, setDcFilterPipeline] = useState<DcPipelineStep[]>([]);
  const [dcToolSignal, setDcToolSignal] = useState<DcSignalKey>("v");
  const [dcIna3221ToolCh, setDcIna3221ToolCh] = useState<0 | 1 | 2>(0);
  const [dcChartFilterPreview, setDcChartFilterPreview] = useState(true);
  const [dcFilterApplyTo, setDcFilterApplyTo] = useState<Record<DcSignalKey, boolean>>({
    v: true,
    i: true,
    p: true
  });

  const dcFilterPluginMap = useMemo(() => filterPluginMap(DC_FILTER_PLUGINS), []);

  const chartSeriesForPreview = useCallback(
    (bundle: SeriesBundle) => {
      if (!dcChartFilterPreview || dcFilterPipeline.length === 0) return bundle;
      let out = bundle;
      for (const sig of ["v", "i", "p"] as const) {
        if (dcFilterApplyTo[sig]) {
          out = applyFiltersToSeriesColumn(out, sig, dcFilterPipeline, dcFilterPluginMap);
        }
      }
      return out;
    },
    [dcChartFilterPreview, dcFilterPipeline, dcFilterApplyTo, dcFilterPluginMap]
  );

  const active = sources.find((s) => s.sourceId === activeSourceId) ?? sources[0]!;
  const protectionCfg = buildProtectionConfig(active);
  const vEff = effectiveVoltageThresholds(protectionCfg);
  const iEff = effectiveCurrentOver_A(protectionCfg);
  const pEff = effectivePowerOver_W(protectionCfg);
  /** Lock protection form while acquiring */
  const protectionFormLocked = active.monitoring;

  // One engine per source (P0→P1 required for true multi-port monitoring).
  const enginesRef = useRef<
    Record<
      string,
      {
        engine: ReturnType<typeof createMonitorEngine>;
        // Keep last-known config to decide when to recreate engine
        cfgKey: string;
      }
    >
  >({});
  const streamAbortRef = useRef<Record<string, { stop: boolean }>>({});
  const sourcesRef = useRef(sources);
  sourcesRef.current = sources;

  /**
   * Mock stream restarts only when monitoring or waveform-related params change.
   * Excludes INA3221 UI routing so display toggles do not abort the mock stream.
   */
  const mockStreamSig = sources
    .filter((s) => s.transport === "Mock")
    .map((s) => `${s.sourceId}:${s.monitoring ? 1 : 0}:${s.selectedChip}:${s.sampleRate}:${s.Imax}:${s.Vnom}`)
    .join("|");

  function serialStartLine(s: Source): string {
    if (!isMultiChannelChipId(effectiveChip(s))) return "START\n";
    const mode = s.ina3221UiMode ?? "single";
    const ch = (s.ina3221SingleChannel ??
      (typeof s.displayChannel === "number" ? s.displayChannel : 0)) as 0 | 1 | 2;
    return ina3221StartCommand(mode, ch);
  }

  function engineFor(source: Source) {
    const cfg = buildProtectionConfig(source);
    const cfgKey = JSON.stringify(buildProtectionConfig(source));

    const existing = enginesRef.current[source.sourceId];
    if (!existing || existing.cfgKey !== cfgKey) {
      const engine = createMonitorEngine({
        protection: cfg,
        frameBufferSize: 400,
        taskQueueCapacity: 8000
      });
      enginesRef.current[source.sourceId] = { cfgKey, engine };
      // Recreate engine on config change; restore connected/monitoring from latest Source
      if (source.connected) {
        engine.enqueueControl({ kind: "CONNECT" });
        engine.stepUntilIdle(1000);
      }
      if (source.connected && source.monitoring) {
        engine.enqueueControl({ kind: "START" });
        engine.stepUntilIdle(1000);
      }
    }
    return enginesRef.current[source.sourceId]!.engine;
  }

  const updateActive = (patch: Partial<Source>) => {
    setSources((prev) =>
      prev.map((s) => (s.sourceId === activeSourceId ? { ...s, ...patch } : s))
    );
  };

  const patchActiveProtection = (patch: Partial<ProtectionConfig>) => {
    updateActive({
      protectionOverrides: { ...active.protectionOverrides, ...patch }
    });
  };

  const updateSource = (sourceId: string, patch: Partial<Source>) => {
    setSources((prev) => prev.map((s) => (s.sourceId === sourceId ? { ...s, ...patch } : s)));
  };

  const refreshPorts = async () => {
    try {
      const list = (await getInaApi()?.listSerialPorts?.()) ?? [];
      setPorts(list.map((p) => ({ path: p.path, manufacturer: p.manufacturer })));
    } catch (e) {
      setPorts([{ path: "Port enum failed (see console)" }]);
      console.error(e);
    }
  };

  const connectSource = (s: Source) => {
    if (s.transport === "Serial") {
      const path = s.serialPath || s.sourceId;
      void (async () => {
        try {
          const api = getInaApi();
          if (!api?.serialOpen) {
            updateSource(s.sourceId, { faultText: serialBridgeUnavailableMessage() });
            return;
          }
          await api.serialOpen({ path, baudRate: 115200 });
          const eng = engineFor(s);
          eng.enqueueControl({ kind: "CONNECT" });
          eng.stepUntilIdle(1000);
          updateSource(s.sourceId, { connected: true, faultText: null, detected: undefined, serialLinkBus: "unknown" });
        } catch (e) {
          updateSource(s.sourceId, { faultText: `Open serial failed: ${String(e)}` });
        }
      })();
      return;
    }
    const eng = engineFor(s);
    eng.enqueueControl({ kind: "CONNECT" });
    eng.stepUntilIdle(1000);
    const detected = mockDetectChip(s.selectedChip, s.sourceId);
    updateSource(s.sourceId, { connected: true, faultText: null, detected });
  };

  const disconnectSource = (s: Source) => {
    updateSource(s.sourceId, {
      monitoring: false,
      chartSessionOriginMs: null,
      ...clearIna3221RuntimeBuffers(effectiveChip(s)),
      series: emptySeries(),
      lastFrame: null,
      ...(s.transport === "Serial" ? { detected: undefined, serialLinkBus: "unknown" as SerialLinkBus } : {})
    });
    const abort = streamAbortRef.current[s.sourceId];
    if (abort) abort.stop = true;
    if (s.transport === "Serial") {
      const path = s.serialPath || s.sourceId;
      void (async () => {
        try {
          const api = getInaApi();
          if (api?.serialClose) await api.serialClose(path);
        } catch (e) {
          console.error(e);
        }
        const eng = engineFor(s);
        eng.enqueueControl({ kind: "DISCONNECT" });
        eng.stepUntilIdle(1000);
        updateSource(s.sourceId, { connected: false, serialLinkBus: "unknown" });
      })();
      return;
    }
    const eng = engineFor(s);
    eng.enqueueControl({ kind: "DISCONNECT" });
    eng.stepUntilIdle(1000);
    updateSource(s.sourceId, { connected: false });
  };

  const startSource = (s: Source) => {
    if (!s.connected || s.monitoring) return;
    if (s.transport === "Serial") {
      const path = s.serialPath || s.sourceId;
      const ina = isMultiChannelChipId(effectiveChip(s));
      const mode = s.ina3221UiMode ?? "single";
      const ch = (s.ina3221SingleChannel ??
        (typeof s.displayChannel === "number" ? s.displayChannel : 0)) as 0 | 1 | 2;
      const startPatch: Partial<Source> = {
        faultText: null,
        monitoring: true,
        chartSessionOriginMs: null,
        series: emptySeries(),
        lastFrame: null,
        ...(ina && mode === "all"
          ? {
              ina3221SeriesByCh: emptyIna3221SeriesByCh(),
              chartSessionOriginMsByCh: [null, null, null] as [null, null, null],
              ina3221ChannelRun: [true, true, true] as [boolean, boolean, boolean]
            }
          : ina && mode === "single"
            ? { displayChannel: ch, ina3221SingleChannel: ch }
            : {})
      };
      const sStreaming: Source = { ...s, ...startPatch };
      updateSource(s.sourceId, startPatch);
      const eng = engineFor(sStreaming);
      eng.enqueueControl({ kind: "START" });
      eng.stepUntilIdle(1000);
      void (async () => {
        try {
          const api = getInaApi();
          if (!api?.serialWrite) {
            eng.enqueueControl({ kind: "STOP" });
            eng.stepUntilIdle(1000);
            updateSource(s.sourceId, { faultText: serialBridgeUnavailableMessage(), monitoring: false });
            return;
          }
          const line = serialStartLine({
            ...sStreaming,
            ina3221UiMode: mode,
            ...(ina && mode === "single" ? { ina3221SingleChannel: ch, displayChannel: ch } : {}),
            ...(ina && mode === "all"
              ? { ina3221UiMode: "all" as const, ina3221ChannelRun: [true, true, true] as [boolean, boolean, boolean] }
              : {})
          });
          const bus = sStreaming.serialLinkBus ?? "unknown";
          const effHz = clampSampleRateForBus(sStreaming.sampleRate, bus);
          await api.serialWrite({ path, data: `SR ${effHz}\n` });
          await api.serialWrite({ path, data: line });
          const sid = s.sourceId;
          const sNow = sourcesRef.current.find((x) => x.sourceId === sid);
          if (!sNow?.monitoring || !sNow.connected || sNow.transport !== "Serial") return;
        } catch (e) {
          eng.enqueueControl({ kind: "STOP" });
          eng.stepUntilIdle(1000);
          updateSource(s.sourceId, { faultText: `START failed: ${String(e)}`, monitoring: false });
        }
      })();
      return;
    }
    const inaSm = isMultiChannelChipId(effectiveChip(s));
    const modeSm = s.ina3221UiMode ?? "single";
    const chSm = (s.ina3221SingleChannel ??
      (typeof s.displayChannel === "number" ? s.displayChannel : 0)) as 0 | 1 | 2;
    updateSource(s.sourceId, { faultText: null });
    const eng = engineFor(s);
    eng.enqueueControl({ kind: "START" });
    eng.stepUntilIdle(1000);
    updateSource(s.sourceId, {
      monitoring: true,
      chartSessionOriginMs: null,
      series: { t: [], v: [], i: [], p: [] },
      lastFrame: null,
      ...(inaSm && modeSm === "all"
        ? {
            ina3221SeriesByCh: emptyIna3221SeriesByCh(),
            chartSessionOriginMsByCh: [null, null, null] as [null, null, null],
            ina3221ChannelRun: [true, true, true] as [boolean, boolean, boolean]
          }
        : inaSm && modeSm === "single"
          ? { displayChannel: chSm, ina3221SingleChannel: chSm }
          : {})
    });
  };

  const stopSource = (s: Source) => {
    updateSource(s.sourceId, {
      monitoring: false,
      chartSessionOriginMs: null,
      ...clearIna3221RuntimeBuffers(effectiveChip(s)),
      series: emptySeries(),
      lastFrame: null
    });
    const abort = streamAbortRef.current[s.sourceId];
    if (abort) abort.stop = true;
    if (s.transport === "Serial") {
      const path = s.serialPath || s.sourceId;
      void (async () => {
        try {
          const api = getInaApi();
          if (api?.serialWrite) await api.serialWrite({ path, data: "STOP\n" });
        } catch (e) {
          console.error(e);
        }
        const eng = engineFor(s);
        eng.enqueueControl({ kind: "STOP" });
        eng.stepUntilIdle(1000);
      })();
      return;
    }
    const eng = engineFor(s);
    eng.enqueueControl({ kind: "STOP" });
    eng.stepUntilIdle(1000);
  };

  const resetFault = () => {
    updateActive({ faultText: null });
    const eng = engineFor(active);
    eng.enqueueControl({ kind: "RESET_FAULT" });
    eng.stepUntilIdle(1000);
  };

  const handleIna3221SingleChannelSwitch = (nextCh: 0 | 1 | 2) => {
    if (!isMultiChannelChipId(effectiveChip(active))) return;
    const path = active.serialPath || active.sourceId;
    const prevCh = (active.ina3221SingleChannel ??
      (typeof active.displayChannel === "number" ? active.displayChannel : 0)) as 0 | 1 | 2;
    const wasMonitoring = active.monitoring;
    updateActive({
      displayChannel: nextCh,
      ina3221SingleChannel: nextCh,
      series: emptySeries(),
      lastFrame: null,
      chartSessionOriginMs: null,
      ina3221RunMemory: { ...(active.ina3221RunMemory ?? {}), [prevCh]: wasMonitoring }
    });
    if (active.transport === "Serial" && (active.ina3221UiMode ?? "single") === "single" && wasMonitoring) {
      void (async () => {
        try {
          const api = getInaApi();
          if (!api?.serialWrite) return;
          await api.serialWrite({ path, data: ina3221StopCommandForSwitch() });
          await api.serialWrite({ path, data: ina3221StartCommand("single", nextCh) });
        } catch (e) {
          console.error(e);
        }
      })();
    }
  };

  const handleIna3221UiModeChange = (mode: Ina3221UiMode) => {
    if (!isMultiChannelChipId(effectiveChip(active))) return;
    if ((active.ina3221UiMode ?? "single") === mode) return;
    const path = active.serialPath || active.sourceId;
    const ch = (active.ina3221SingleChannel ?? 0) as 0 | 1 | 2;
    updateActive({
      ina3221UiMode: mode,
      series: emptySeries(),
      lastFrame: null,
      chartSessionOriginMs: null,
      ina3221SeriesByCh: mode === "all" ? emptyIna3221SeriesByCh() : undefined,
      chartSessionOriginMsByCh: mode === "all" ? ([null, null, null] as [null, null, null]) : undefined,
      displayChannel: mode === "single" ? ch : "aggregate",
      ina3221ChannelRun:
        mode === "all"
          ? active.transport === "Serial"
            ? ([false, false, false] as [boolean, boolean, boolean])
            : ([true, true, true] as [boolean, boolean, boolean])
          : undefined
    });
    if (active.transport === "Serial" && active.monitoring) {
      void (async () => {
        try {
          const api = getInaApi();
          if (!api?.serialWrite) return;
          await api.serialWrite({ path, data: ina3221StopCommandForSwitch() });
          if (mode === "all") await api.serialWrite({ path, data: ina3221StartCommand("all", ch) });
          else await api.serialWrite({ path, data: ina3221StartCommand("single", ch) });
        } catch (e) {
          console.error(e);
        }
      })();
    }
  };

  const startIna3221ChannelOne = (ch: 0 | 1 | 2) => {
    if (!isMultiChannelChipId(effectiveChip(active)) || (active.ina3221UiMode ?? "single") !== "all") return;
    const path = active.serialPath || active.sourceId;
    const cr = active.ina3221ChannelRun ?? [false, false, false];
    const next = [cr[0], cr[1], cr[2]] as [boolean, boolean, boolean];
    next[ch] = true;
    updateActive({ ina3221ChannelRun: next });
    if (active.transport !== "Serial") return;
    void getInaApi()?.serialWrite?.({ path, data: ina3221ChannelStartCommand(ch) });
  };

  const stopIna3221ChannelOne = (ch: 0 | 1 | 2) => {
    if (!isMultiChannelChipId(effectiveChip(active)) || (active.ina3221UiMode ?? "single") !== "all") return;
    const path = active.serialPath || active.sourceId;
    const cr = active.ina3221ChannelRun ?? [false, false, false];
    const next = [cr[0], cr[1], cr[2]] as [boolean, boolean, boolean];
    next[ch] = false;
    updateActive({ ina3221ChannelRun: next });
    if (active.transport !== "Serial") return;
    void getInaApi()?.serialWrite?.({ path, data: ina3221ChannelStopCommand(ch) });
  };

  /** Main-process serial JSONL → update Serial source series + protection engine */
  useEffect(() => {
    let unsub: (() => void) | undefined;
    let pollId: ReturnType<typeof setInterval> | undefined;

    const onSample = (payload: {
      path: string;
      type?: string;
      chip?: string;
      addr?: string;
      v?: number;
      seq?: number;
      t_ms?: number;
      bus_V?: number;
      current_A?: number;
      power_W?: number;
      channels?: { bus_V?: number; current_A?: number; power_W?: number }[];
    }) => {
      if (payload.type === "INFO") {
        const path = payload.path;
        const bus = inferSerialLinkBus(payload.addr);
        const chipStr = typeof payload.chip === "string" ? (payload.chip as ChipId) : undefined;
        if (bus === "unknown" && !chipStr) return;
        setSources((prev) =>
          prev.map((src) => {
            if (src.transport !== "Serial") return src;
            const sp = src.serialPath || src.sourceId;
            if (!serialPathsEqual(sp, path)) return src;
            let serialLinkBus = src.serialLinkBus ?? "unknown";
            let sampleRate = src.sampleRate;
            if (bus !== "unknown") {
              serialLinkBus = bus;
              const cap = maxSampleRateForBus(bus);
              if (sampleRate > cap) sampleRate = cap;
            }
            const detected: ChipDetectionResult | undefined = chipStr
              ? {
                  detectedChip: chipStr,
                  confidence: "strong",
                  details: "JSON INFO (serial)"
                }
              : src.detected;
            return { ...src, serialLinkBus, sampleRate, ...(chipStr ? { detected } : {}) };
          })
        );
        return;
      }
      if (payload.type === "ERR") return;

      const isIna3221Multi =
        (payload.chip === "INA3221" || payload.chip === "INA3221-Q1") &&
        Array.isArray(payload.channels) &&
        payload.channels.length >= 3;

      if (
        !isIna3221Multi &&
        typeof payload.bus_V !== "number" &&
        typeof payload.current_A !== "number" &&
        typeof payload.power_W !== "number"
      ) {
        return;
      }

      const path = payload.path;
      setSources((prev) =>
        prev.map((src) => {
          if (src.transport !== "Serial") return src;
          const sp = src.serialPath || src.sourceId;
          if (!serialPathsEqual(sp, path)) return src;

          const eng = engineFor(src);
          const chip = (payload.chip as ChipId) || "INA219";

          let frame: MeasurementFrame;
          if (isIna3221Multi) {
            const chs = payload.channels!.slice(0, 3);
            let sharedV: number | undefined = typeof payload.bus_V === "number" ? payload.bus_V : undefined;
            if (sharedV === undefined) {
              const bs = chs.map((c) => c.bus_V).filter((x): x is number => typeof x === "number");
              if (bs.length) sharedV = bs.reduce((a, b) => a + b, 0) / bs.length;
            }
            frame = {
              version: 1,
              chip,
              seq: payload.seq ?? 0,
              t_host_ms: typeof payload.t_ms === "number" ? payload.t_ms : Date.now(),
              channelModel: { kind: "multi", channelCount: 3 },
              shared: typeof sharedV === "number" ? { busVoltage_V: sharedV } : undefined,
              channels: chs.map((c) => ({
                busVoltage_V: c.bus_V,
                current_A: c.current_A,
                power_W: c.power_W
              }))
            };
          } else {
            frame = {
              version: 1,
              chip,
              seq: payload.seq ?? 0,
              t_host_ms: typeof payload.t_ms === "number" ? payload.t_ms : Date.now(),
              channelModel: { kind: "single" },
              signals: {
                busVoltage_V: typeof payload.bus_V === "number" ? payload.bus_V : NaN,
                current_A: typeof payload.current_A === "number" ? payload.current_A : NaN,
                power_W: typeof payload.power_W === "number" ? payload.power_W : NaN
              }
            };
          }
          eng.enqueueFrame(frame);
          eng.stepUntilIdle(5000);
          const snap = eng.snapshot();

          const mode3221 = src.ina3221UiMode ?? "single";
          const singleCh = (src.ina3221SingleChannel ??
            (typeof src.displayChannel === "number" ? src.displayChannel : 0)) as 0 | 1 | 2;
          const picked =
            isIna3221Multi && mode3221 === "all"
              ? src.displayChannel === undefined || src.displayChannel === "aggregate"
                ? framePickSingle(frame)
                : framePickForDisplay(frame, src.displayChannel)
              : isIna3221Multi && mode3221 === "single"
                ? framePickForDisplay(frame, singleCh)
                : framePickForDisplay(frame, src.displayChannel ?? "aggregate");
          const addrBus = inferSerialLinkBus(payload.addr);
          let nextBus = src.serialLinkBus ?? "unknown";
          let nextSr = src.sampleRate;
          if (addrBus !== "unknown") {
            nextBus = addrBus;
            const cap = maxSampleRateForBus(addrBus);
            if (nextSr > cap) nextSr = cap;
          }
          const bufCap = seriesBufferCapacityHz(Math.max(src.sampleRate, nextSr));
          const t = frame.t_host_ms;
          const nextSeries = {
            t: [...src.series.t, t],
            v: [...src.series.v, typeof picked.busVoltage_V === "number" ? picked.busVoltage_V : NaN],
            i: [...src.series.i, typeof picked.current_A === "number" ? picked.current_A : NaN],
            p: [...src.series.p, typeof picked.power_W === "number" ? picked.power_W : NaN]
          };
          if (nextSeries.t.length > bufCap) {
            nextSeries.t = nextSeries.t.slice(-bufCap);
            nextSeries.v = nextSeries.v.slice(-bufCap);
            nextSeries.i = nextSeries.i.slice(-bufCap);
            nextSeries.p = nextSeries.p.slice(-bufCap);
          }

          let nextByCh: [SeriesBundle, SeriesBundle, SeriesBundle] | undefined;
          let chartSessionOriginMsByCh: [number | null, number | null, number | null] | undefined;
          if (isIna3221Multi && mode3221 === "all") {
            const sharedV =
              "shared" in frame && frame.shared?.busVoltage_V !== undefined
                ? frame.shared.busVoltage_V
                : undefined;
            const base = src.ina3221SeriesByCh ?? emptyIna3221SeriesByCh();
            nextByCh = appendIna3221FrameToSeries(frame, base, sharedV, bufCap);
            let cob = src.chartSessionOriginMsByCh ?? [null, null, null];
            if (src.monitoring) {
              const nextOrig = [...cob] as [number | null, number | null, number | null];
              for (let i = 0; i < 3; i++) {
                if (nextByCh[i].t.length > 0 && nextOrig[i] == null) {
                  nextOrig[i] = nextByCh[i].t[0]!;
                }
              }
              cob = nextOrig;
            }
            chartSessionOriginMsByCh = cob;
          }

          let faultText = src.faultText;
          let monitoring = src.monitoring;
          if (snap.state.name === "FaultLatched") {
            monitoring = false;
            faultText = `${snap.state.fault.faultCode} (${snap.state.fault.severity}): ${JSON.stringify(snap.state.fault.triggerRule)}`;
            void getInaApi()?.serialWrite?.({ path: sp, data: "STOP\n" });
          }

          const detected =
            src.detected ??
            (payload.chip
              ? ({
                  detectedChip: payload.chip as ChipId,
                  confidence: "strong",
                  details: "JSON bridge (serial)"
                } as ChipDetectionResult)
              : undefined);

          let chartSessionOriginMs = src.chartSessionOriginMs;
          if (src.monitoring && nextSeries.t.length > 0 && chartSessionOriginMs == null) {
            chartSessionOriginMs = nextSeries.t[0]!;
          }

          return {
            ...src,
            lastFrame: frame,
            series: nextSeries,
            faultText,
            monitoring,
            detected,
            serialLinkBus: nextBus,
            sampleRate: nextSr,
            chartSessionOriginMs,
            ...(isIna3221Multi && mode3221 === "all" && nextByCh && chartSessionOriginMsByCh
              ? { ina3221SeriesByCh: nextByCh, chartSessionOriginMsByCh }
              : {})
          };
        })
      );
    };

    function attach(): boolean {
      const sub = getInaApi()?.subscribeSerialSample;
      if (!sub) return false;
      unsub = sub(onSample);
      if (pollId !== undefined) {
        clearInterval(pollId);
        pollId = undefined;
      }
      return true;
    }

    if (!attach()) {
      pollId = setInterval(() => {
        attach();
      }, 200);
    }

    return () => {
      if (pollId !== undefined) clearInterval(pollId);
      unsub?.();
    };
  }, []);

  useEffect(() => {
    // One mock stream per source; key on mockStreamSig so UI ticks do not restart streams.
    const list = sourcesRef.current.filter((s) => s.transport === "Mock" && s.monitoring);
    for (const s of list) {
      if (streamAbortRef.current[s.sourceId] && !streamAbortRef.current[s.sourceId].stop) continue;
      const abort = { stop: false };
      streamAbortRef.current[s.sourceId] = abort;

      const channelModel = isMultiChannelChipId(s.selectedChip)
        ? ({ kind: "multi", channelCount: 3 } as const)
        : "single";
      const sid = s.sourceId;

      (async () => {
        const eng = engineFor(s);
        const gen = mockInaStream({
          chip: s.selectedChip,
          channelModel,
          sampleRate_Hz: s.sampleRate,
          busVoltage_V: { kind: "noise", sigma: 0.01, base: { kind: "dc", value: s.Vnom } },
          current_A: {
            kind: "noise",
            sigma: 0.02,
            base: {
              kind: "step",
              t0_ms: 4000,
              before: 0.3 * s.Imax,
              // Above soft band (~1.2×Imax), below absolute cap (~1.5×Imax); INA3221 per-ch ~1.02×
              after: 1.32 * s.Imax
            }
          },
          ...(channelModel !== "single"
            ? { channelTimeOffsetsMs: [0, 600, 1200] as [number, number, number] }
            : {})
        });

        for await (const frame of gen) {
          if (abort.stop) break;

          eng.enqueueFrame(frame);
          eng.stepUntilIdle(5000);
          const snap = eng.snapshot();

          setSources((prev) =>
            prev.map((src) => {
              if (src.sourceId !== sid) return src;

              const isIna3221Multi =
                isMultiChannelChipId(src.selectedChip) &&
                "channels" in frame &&
                frame.channels.length >= 3;

              const mode3221 = src.ina3221UiMode ?? "single";
              const singleCh = (src.ina3221SingleChannel ??
                (typeof src.displayChannel === "number" ? src.displayChannel : 0)) as 0 | 1 | 2;

              const picked =
                isIna3221Multi && mode3221 === "all"
                  ? src.displayChannel === undefined || src.displayChannel === "aggregate"
                    ? framePickSingle(frame)
                    : framePickForDisplay(frame, src.displayChannel)
                  : isIna3221Multi && mode3221 === "single"
                    ? framePickForDisplay(frame, singleCh)
                    : framePickForDisplay(frame, src.displayChannel ?? "aggregate");

              const t = frame.t_host_ms;
              const nextSeries = {
                t: [...src.series.t, t],
                v: [...src.series.v, typeof picked.busVoltage_V === "number" ? picked.busVoltage_V : NaN],
                i: [...src.series.i, typeof picked.current_A === "number" ? picked.current_A : NaN],
                p: [...src.series.p, typeof picked.power_W === "number" ? picked.power_W : NaN]
              };
              const bufCap = seriesBufferCapacityHz(src.sampleRate);
              if (nextSeries.t.length > bufCap) {
                nextSeries.t = nextSeries.t.slice(-bufCap);
                nextSeries.v = nextSeries.v.slice(-bufCap);
                nextSeries.i = nextSeries.i.slice(-bufCap);
                nextSeries.p = nextSeries.p.slice(-bufCap);
              }

              let nextByCh: [SeriesBundle, SeriesBundle, SeriesBundle] | undefined;
              let chartSessionOriginMsByCh: [number | null, number | null, number | null] | undefined;
              if (isIna3221Multi && mode3221 === "all") {
                const sharedV =
                  "shared" in frame && frame.shared?.busVoltage_V !== undefined
                    ? frame.shared.busVoltage_V
                    : undefined;
                const base = src.ina3221SeriesByCh ?? emptyIna3221SeriesByCh();
                nextByCh = appendIna3221FrameToSeries(frame, base, sharedV, bufCap);
                let cob = src.chartSessionOriginMsByCh ?? [null, null, null];
                if (src.monitoring) {
                  const nextOrig = [...cob] as [number | null, number | null, number | null];
                  for (let i = 0; i < 3; i++) {
                    if (nextByCh[i].t.length > 0 && nextOrig[i] == null) {
                      nextOrig[i] = nextByCh[i].t[0]!;
                    }
                  }
                  cob = nextOrig;
                }
                chartSessionOriginMsByCh = cob;
              }

              let faultText = src.faultText;
              let monitoring = src.monitoring;
              if (snap.state.name === "FaultLatched") {
                monitoring = false;
                abort.stop = true;
                faultText = `${snap.state.fault.faultCode} (${snap.state.fault.severity}): ${JSON.stringify(snap.state.fault.triggerRule)}`;
              }
              let chartSessionOriginMs = src.chartSessionOriginMs;
              if (src.monitoring && nextSeries.t.length > 0 && chartSessionOriginMs == null) {
                chartSessionOriginMs = nextSeries.t[0]!;
              }
              return {
                ...src,
                lastFrame: frame,
                series: nextSeries,
                faultText,
                monitoring,
                chartSessionOriginMs,
                ...(isIna3221Multi && mode3221 === "all" && nextByCh && chartSessionOriginMsByCh
                  ? { ina3221SeriesByCh: nextByCh, chartSessionOriginMsByCh }
                  : {})
              };
            })
          );
        }
      })();
    }

    return () => {
      for (const s of sourcesRef.current) {
        if (s.transport !== "Mock") continue;
        const a = streamAbortRef.current[s.sourceId];
        if (a) a.stop = true;
      }
    };
  }, [mockStreamSig]);

  const activeEngineSnap = engineFor(active).snapshot();
  const activeStateName = activeEngineSnap.state.name;
  const softAlarmItems = sources.flatMap((s) => {
    if (!s.monitoring) return [];
    const soft = engineFor(s).snapshot().softAlarms;
    const label = softAlarmsLabel(soft);
    if (!label) return [];
    return [{ key: s.sourceId, text: `${compactSourceTag(s)}${ina3221RouteSuffix(s)} — ${label}` }];
  });

  const activeContextLine = `${compactSourceTag(active)}${ina3221RouteSuffix(active)}`;

  const picked = useMemo(
    () => pickSignalsForSource(active),
    [
      active.lastFrame,
      active.transport,
      active.selectedChip,
      active.detected,
      active.ina3221UiMode,
      active.displayChannel,
      active.ina3221SingleChannel
    ]
  );
  const mismatch =
    active.transport === "Mock" &&
    active.detected &&
    active.detected.detectedChip !== active.selectedChip &&
    active.detected.detectedChip !== "UNKNOWN";

  /** Another source has points while plot source buffer is empty */
  const sourceWithLivePoints = sources.find(
    (s) => (s.transport === "Serial" || s.transport === "Mock") && s.series.t.length > 0
  );
  /** Active Serial + Mock sources for multi-strip plot */
  const monitoringChartSources = useMemo(
    () => sources.filter((s) => s.monitoring && (s.transport === "Serial" || s.transport === "Mock")),
    [sources]
  );
  const monitoringChartStripItems = useMemo(
    () => expandMonitoringChartStrips(monitoringChartSources),
    [monitoringChartSources]
  );
  const chartViewMismatch =
    sourceWithLivePoints != null &&
    sourceWithLivePoints.sourceId !== active.sourceId &&
    active.series.t.length === 0;

  /** Lock INA3221 plot routing while monitoring */
  const lockIna3221ChartOptions = active.monitoring && isMultiChannelChipId(effectiveChip(active));

  const serialSourcesSorted = useMemo(
    () => sources.filter((s) => s.transport === "Serial").sort((a, b) => (a.hardwareSlot ?? 0) - (b.hardwareSlot ?? 0)),
    [sources]
  );
  const mockSourcesOnly = useMemo(() => sources.filter((s) => s.transport === "Mock"), [sources]);

  return (
    <div className="app">
      <div className="topbar">
        <div className="brand">
          <div className="brandTitle" aria-label="INA Monitor Tool">
            INA Monitor Tool
          </div>
          <div className="brandSub">
            <span className="brandSubBy">Author</span>
            <span className="brandSubAccent">NiusRobotLab</span>
          </div>
        </div>
        <div className="topbarCenter">
          <div
            className={`stateCluster ${activeStateName === "Monitoring" ? "stateClusterOk" : activeStateName === "FaultLatched" ? "stateClusterDanger" : "stateClusterWarn"}`}
            title={`Selected source (Connection / plot)\n${activeContextLine}\nEngine: ${activeStateName}`}
          >
            <span
              className={`stateGlyph ${activeStateName === "Monitoring" ? "stateGlyphPulse" : activeStateName === "FaultLatched" ? "stateGlyphFault" : "stateGlyphIdle"}`}
              aria-hidden
            />
            <span className="stateClusterCode">{engineStateShort(activeStateName)}</span>
            <span className="stateClusterSrc">{activeContextLine}</span>
          </div>
          {softAlarmItems.length > 0 ? (
            <div className="alarmChipStrip" role="list" aria-label="Soft alarms">
              {softAlarmItems.map((a) => (
                <span key={a.key} className="alarmChip" role="listitem" title={a.text}>
                  <span className="alarmChipIcon" aria-hidden>
                    !
                  </span>
                  {a.text}
                </span>
              ))}
            </div>
          ) : (
            <div className="topbarQuiet" title="No soft alarms on monitoring sources">
              <span className="alarmOkGlyph" aria-hidden>
                ✓
              </span>
              alarms clear
            </div>
          )}
        </div>
        <div className="topbarEnd">
          {mismatch ? (
            <div className={`banner bannerCompact ${active.detected?.confidence === "strong" ? "bannerDanger" : ""}`}>
              <div>
                Expected: <b>{active.selectedChip}</b> ≠ detected <b>{active.detected!.detectedChip}</b>
              </div>
              <button
                onClick={() => updateActive({ selectedChip: active.detected!.detectedChip })}
                disabled={active.monitoring}
                title="Apply detected chip to this source"
              >
                Apply
              </button>
              <button onClick={() => updateActive({ detected: undefined })} disabled={active.monitoring} title="Dismiss (may mis-decode frames)">
                ✕
              </button>
            </div>
          ) : null}
          {active.faultText ? (
            <span className="statusPill danger faultPillCompact" title={active.faultText}>
              <span className="faultPillIcon" aria-hidden>
                ⛔
              </span>
              {active.faultText.length > 48 ? `${active.faultText.slice(0, 46)}…` : active.faultText}
            </span>
          ) : null}
        </div>
      </div>

      <div className="content split3">
        <div className="panel panelSidebar panelCompact">
          <h3>Sources</h3>
          <div className="sourceList">
            <div className="sourceGroupTitle">Hardware serial (16)</div>
            {serialSourcesSorted.map((s) => (
              <div
                key={s.sourceId}
                className={`sourceItem ${s.sourceId === activeSourceId ? "sourceItemActive" : ""}`}
                onClick={() => setActiveSourceId(s.sourceId)}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    setActiveSourceId(s.sourceId);
                  }
                }}
              >
                <div className="sourceTitle">{formatHardwareSourceTitle(s)}</div>
                <div className="sourceMeta">
                  <span>{s.connected ? "On" : "Off"}</span>
                  <span>{s.monitoring ? "Run" : "Idle"}</span>
                  <span title={s.transport === "Serial" ? "Reported by device JSON (chip field)" : undefined}>{sourceListChipDisplay(s)}</span>
                  <span>{s.sampleRate} Hz</span>
                </div>
                <div className="sourceBtnRow" onClick={(e) => e.stopPropagation()}>
                  {!s.connected ? (
                    <IconConnect title="Connect" aria-label="Connect" onClick={() => connectSource(s)} />
                  ) : (
                    <IconDisconnect title="Disconnect" aria-label="Disconnect" onClick={() => disconnectSource(s)} />
                  )}
                  <IconStart
                    title={
                      !s.connected
                        ? "Connect the serial port first"
                        : s.monitoring
                          ? "Already monitoring — Stop first"
                          : s.connected && !s.detected && (s.serialLinkBus ?? "unknown") === "unknown"
                            ? "Start: SR + START (chip/link may fill in when INFO arrives)"
                            : "Start monitoring (SR + START)"
                    }
                    aria-label="Start monitoring"
                    disabled={!s.connected || s.monitoring}
                    onClick={() => startSource(s)}
                  />
                  <IconStop title="Stop monitoring" aria-label="Stop monitoring" disabled={!s.connected || !s.monitoring} onClick={() => stopSource(s)} />
                </div>
              </div>
            ))}
            <div className="sourceGroupTitle">Simulation</div>
            {mockSourcesOnly.map((s) => (
              <div
                key={s.sourceId}
                className={`sourceItem ${s.sourceId === activeSourceId ? "sourceItemActive" : ""}`}
                onClick={() => setActiveSourceId(s.sourceId)}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    setActiveSourceId(s.sourceId);
                  }
                }}
              >
                <div className="sourceTitle">{formatHardwareSourceTitle(s)}</div>
                <div className="sourceMeta">
                  <span>{s.connected ? "On" : "Off"}</span>
                  <span>{s.monitoring ? "Run" : "Idle"}</span>
                  <span>{sourceListChipDisplay(s)}</span>
                  <span>{s.sampleRate} Hz</span>
                  {s.detected && s.detected.detectedChip !== s.selectedChip ? <span className="danger">Mismatch</span> : null}
                </div>
                <div className="sourceBtnRow" onClick={(e) => e.stopPropagation()}>
                  {!s.connected ? (
                    <IconConnect title="Connect (Mock)" aria-label="Connect Mock" onClick={() => connectSource(s)} />
                  ) : (
                    <IconDisconnect title="Disconnect" aria-label="Disconnect" onClick={() => disconnectSource(s)} />
                  )}
                  <IconStart
                    title="Start monitoring"
                    aria-label="Start monitoring"
                    disabled={!s.connected || s.monitoring}
                    onClick={() => startSource(s)}
                  />
                  <IconStop title="Stop monitoring" aria-label="Stop monitoring" disabled={!s.connected || !s.monitoring} onClick={() => stopSource(s)} />
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="panel panelSidebar panelCompact">
          <h3>Connection ({mode === "basic" ? "Basic" : "Advanced"})</h3>

          {active.transport === "Serial" ? (
            <>
              <div className="row">
                <div>
                  <label>Serial port</label>
                  <input
                    type="text"
                    value={active.serialPath ?? ""}
                    onChange={(e) => updateActive({ serialPath: e.target.value })}
                    disabled={active.monitoring}
                    title={
                      active.connected && !active.monitoring
                        ? "Connected: disconnect and reconnect to use a new port"
                        : undefined
                    }
                    placeholder="e.g. COM6"
                  />
                </div>
                <div>
                  <label>System list</label>
                  <select
                    value=""
                    onChange={(e) => {
                      const v = e.target.value;
                      if (v) updateActive({ serialPath: v });
                    }}
                    disabled={active.monitoring}
                    title={
                      active.connected && !active.monitoring
                        ? "Connected: pick a new port, then disconnect and reconnect"
                        : undefined
                    }
                  >
                    <option value="">Pick…</option>
                    {ports.map((p) => (
                      <option key={p.path} value={p.path}>
                        {p.path} {p.manufacturer ? `(${p.manufacturer})` : ""}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
              <div className="row">
                <div>
                  <label>&nbsp;</label>
                  <button onClick={refreshPorts} disabled={active.monitoring} style={{ width: "100%" }}>
                    Refresh ports
                  </button>
                </div>
                <div />
              </div>
            </>
          ) : (
            <div className="row">
              <div>
                <label>&nbsp;</label>
                <button onClick={refreshPorts} disabled={active.monitoring} style={{ width: "100%" }}>
                  Refresh ports
                </button>
              </div>
              <div />
            </div>
          )}

          <div className="row">
            {active.transport === "Mock" ? (
              <div>
                <label>Simulated chip</label>
                <select
                  value={active.selectedChip}
                  onChange={(e) => {
                    const selectedChip = e.target.value as ChipId;
                    const patch: Partial<Source> = {
                      selectedChip,
                      ...(!isMultiChannelChipId(selectedChip)
                        ? {
                            displayChannel: undefined,
                            ina3221UiMode: undefined,
                            ina3221SingleChannel: undefined,
                            ina3221RunMemory: undefined,
                            ina3221ChannelRun: undefined,
                            ina3221SeriesByCh: undefined,
                            chartSessionOriginMsByCh: undefined
                          }
                        : {
                            ina3221UiMode: "single",
                            ina3221SingleChannel: 0,
                            displayChannel: 0,
                            ina3221RunMemory: {},
                            ina3221ChannelRun: [false, false, false],
                            ina3221SeriesByCh: emptyIna3221SeriesByCh(),
                            chartSessionOriginMsByCh: [null, null, null]
                          })
                    };
                    updateActive(patch);
                  }}
                  disabled={active.monitoring}
                >
                  {CHIP_UI_GROUPS.map((g) => (
                    <optgroup key={g.label} label={g.label}>
                      {g.chips.map((chip) => (
                        <option key={chip} value={chip}>
                          {chipOptionLabel(chip)}
                        </option>
                      ))}
                    </optgroup>
                  ))}
                </select>
              </div>
            ) : null}
            <div style={active.transport === "Serial" ? { gridColumn: "1 / -1" } : undefined}>
              <label>Sample rate</label>
              <select
                value={active.sampleRate}
                onChange={(e) => updateActive({ sampleRate: Number(e.target.value) })}
                disabled={active.monitoring}
              >
                {sampleRateMenuValues(active.serialLinkBus ?? "unknown").map((v) => (
                  <option key={v} value={v}>
                    {v} Hz
                  </option>
                ))}
              </select>
            </div>
          </div>

          {active.transport === "Serial" ? (
            <div className="row">
              <div style={{ gridColumn: "1 / -1" }}>
                <label>Device (auto)</label>
                <div className="topbarQuiet" style={{ marginTop: 2 }}>
                  <b>{active.detected?.detectedChip ?? "—"}</b>
                  <span style={{ marginLeft: 8, opacity: 0.85 }}>
                    {active.serialLinkBus === "spi" ? "SPI" : active.serialLinkBus === "i2c" ? "I²C" : ""}
                  </span>
                  <span style={{ marginLeft: 6, opacity: 0.65 }}>
                    from JSON <code>chip</code> / <code>addr</code> · pick rate after connect
                  </span>
                </div>
              </div>
            </div>
          ) : null}

          <div className="row">
            <div>
              <label>Imax expected (A)</label>
              <input type="number" step="0.1" value={active.Imax} onChange={(e) => updateActive({ Imax: Number(e.target.value) })} disabled={active.monitoring} />
            </div>
            <div>
              <label>Vnom nominal (V)</label>
              <input type="number" step="0.1" value={active.Vnom} onChange={(e) => updateActive({ Vnom: Number(e.target.value) })} disabled={active.monitoring} />
            </div>
          </div>


          <div className="row rowCheckbox">
            <label className="labelInline">
              <input
                type="checkbox"
                checked={protectionCfg.alarmVoltageEnabled}
                onChange={(e) => patchActiveProtection({ alarmVoltageEnabled: e.target.checked })}
                disabled={protectionFormLocked}
              />
              V alarm
            </label>
            <label>
              Limit mode
              <select
                value={protectionCfg.voltageLimitMode}
                onChange={(e) => {
                  const m = e.target.value as LimitMode;
                  if (m === "manual") {
                    const t = effectiveVoltageThresholds({ ...protectionCfg, voltageLimitMode: "auto" });
                    patchActiveProtection({ voltageLimitMode: "manual", V_over_V: t.over, V_under_V: t.under });
                  } else {
                    patchActiveProtection({ voltageLimitMode: "auto" });
                  }
                }}
                disabled={protectionFormLocked}
              >
                <option value="auto">Auto (±10% Vnom)</option>
                <option value="manual">Manual</option>
              </select>
            </label>
            {protectionCfg.voltageLimitMode === "manual" ? (
              <>
                <label>
                  Over (V)
                  <input
                    type="number"
                    step={0.01}
                    value={protectionCfg.V_over_V}
                    onChange={(e) => patchActiveProtection({ V_over_V: Number(e.target.value) })}
                    disabled={protectionFormLocked}
                  />
                </label>
                <label>
                  Under (V)
                  <input
                    type="number"
                    step={0.01}
                    value={protectionCfg.V_under_V}
                    onChange={(e) => patchActiveProtection({ V_under_V: Number(e.target.value) })}
                    disabled={protectionFormLocked}
                  />
                </label>
              </>
            ) : (
              <span className="panelHint">
                eff {vEff.over.toFixed(2)} / {vEff.under.toFixed(2)} V
              </span>
            )}
          </div>

          <div className="row rowCheckbox">
            <label className="labelInline">
              <input
                type="checkbox"
                checked={protectionCfg.alarmCurrentEnabled}
                onChange={(e) => patchActiveProtection({ alarmCurrentEnabled: e.target.checked })}
                disabled={protectionFormLocked}
              />
              I alarm
            </label>
            <label>
              Limit mode
              <select
                value={protectionCfg.currentLimitMode}
                onChange={(e) => {
                  const m = e.target.value as LimitMode;
                  if (m === "manual") {
                    const t = effectiveCurrentOver_A({ ...protectionCfg, currentLimitMode: "auto" });
                    patchActiveProtection({ currentLimitMode: "manual", I_over_A: t });
                  } else {
                    patchActiveProtection({ currentLimitMode: "auto" });
                  }
                }}
                disabled={protectionFormLocked}
              >
                <option value="auto">Auto (1.2×Imax)</option>
                <option value="manual">Manual</option>
              </select>
            </label>
            {protectionCfg.currentLimitMode === "manual" ? (
              <label>
                I over (A)
                <input
                  type="number"
                  step={0.01}
                  min={0}
                  value={protectionCfg.I_over_A}
                  onChange={(e) => patchActiveProtection({ I_over_A: Number(e.target.value) })}
                  disabled={protectionFormLocked}
                />
              </label>
            ) : (
              <span className="panelHint">eff {iEff.toFixed(3)} A</span>
            )}
          </div>

          <div className="row rowCheckbox">
            <label className="labelInline">
              <input
                type="checkbox"
                checked={protectionCfg.alarmPowerEnabled}
                onChange={(e) => patchActiveProtection({ alarmPowerEnabled: e.target.checked })}
                disabled={protectionFormLocked}
              />
              P alarm
            </label>
            <label>
              Limit mode
              <select
                value={protectionCfg.powerLimitMode}
                onChange={(e) => {
                  const m = e.target.value as LimitMode;
                  if (m === "manual") {
                    const t = effectivePowerOver_W({ ...protectionCfg, powerLimitMode: "auto" });
                    patchActiveProtection({ powerLimitMode: "manual", P_over_W: t });
                  } else {
                    patchActiveProtection({ powerLimitMode: "auto" });
                  }
                }}
                disabled={protectionFormLocked}
              >
                <option value="auto">Auto (1.1×Vnom×Imax)</option>
                <option value="manual">Manual</option>
              </select>
            </label>
            {protectionCfg.powerLimitMode === "manual" ? (
              <label>
                P over (W)
                <input
                  type="number"
                  step={0.01}
                  min={0}
                  value={protectionCfg.P_over_W}
                  onChange={(e) => patchActiveProtection({ P_over_W: Number(e.target.value) })}
                  disabled={protectionFormLocked}
                />
              </label>
            ) : (
              <span className="panelHint">eff {pEff.toFixed(3)} W</span>
            )}
          </div>

          <div className="row">
            <div>
              <label>Absolute Vbus max (V)</label>
              <input
                type="number"
                step={0.1}
                min={0.1}
                value={protectionCfg.absoluteMaxBusVoltage_V}
                onChange={(e) => patchActiveProtection({ absoluteMaxBusVoltage_V: Number(e.target.value) })}
                disabled={protectionFormLocked}
              />
            </div>
            <div>
              <label>Absolute I max (A)</label>
              <input
                type="number"
                step={0.01}
                min={0.001}
                value={protectionCfg.absoluteMaxCurrent_A}
                onChange={(e) => patchActiveProtection({ absoluteMaxCurrent_A: Number(e.target.value) })}
                disabled={protectionFormLocked}
              />
            </div>
            <div>
              <label>Absolute P max (W)</label>
              <input
                type="number"
                step={0.01}
                min={0.01}
                value={protectionCfg.absoluteMaxPower_W}
                onChange={(e) => patchActiveProtection({ absoluteMaxPower_W: Number(e.target.value) })}
                disabled={protectionFormLocked}
              />
            </div>
          </div>

          {mode === "advanced" ? (
            <div className="advancedBlock">
              <div className="advancedTitle">Engine (advanced)</div>
              <div className="row rowCheckbox">
                <label className="labelInline">
                  <input
                    type="checkbox"
                    checked={protectionCfg.enabled}
                    onChange={(e) => patchActiveProtection({ enabled: e.target.checked })}
                    disabled={protectionFormLocked}
                  />
                  Detection enabled
                </label>
                <button
                  type="button"
                  className="btnGhost"
                  onClick={() => updateActive({ protectionOverrides: undefined })}
                  disabled={protectionFormLocked}
                >
                  Reset thresholds
                </button>
              </div>
              <div className="row">
                <div>
                  <label>Hold samples · I soft</label>
                  <input
                    type="number"
                    step={1}
                    min={1}
                    value={protectionCfg.holdSamples_over}
                    onChange={(e) => patchActiveProtection({ holdSamples_over: Math.max(1, Math.round(Number(e.target.value))) })}
                    disabled={protectionFormLocked}
                  />
                </div>
                <div>
                  <label>Hold samples · V soft</label>
                  <input
                    type="number"
                    step={1}
                    min={1}
                    value={protectionCfg.holdSamples_uv_ov}
                    onChange={(e) => patchActiveProtection({ holdSamples_uv_ov: Math.max(1, Math.round(Number(e.target.value))) })}
                    disabled={protectionFormLocked}
                  />
                </div>
              </div>
              <div className="row">
                <div>
                  <label>Hold samples · P soft</label>
                  <input
                    type="number"
                    step={1}
                    min={1}
                    value={protectionCfg.holdSamples_power}
                    onChange={(e) => patchActiveProtection({ holdSamples_power: Math.max(1, Math.round(Number(e.target.value))) })}
                    disabled={protectionFormLocked}
                  />
                </div>
                <div>
                  <label>Hold samples · absolute</label>
                  <input
                    type="number"
                    step={1}
                    min={1}
                    value={protectionCfg.holdSamples_absolute}
                    onChange={(e) => patchActiveProtection({ holdSamples_absolute: Math.max(1, Math.round(Number(e.target.value))) })}
                    disabled={protectionFormLocked}
                  />
                </div>
              </div>
              <div className="row">
                <div>
                  <label>Min valid Vbus (V)</label>
                  <input
                    type="number"
                    step={0.01}
                    min={0}
                    value={protectionCfg.minValidBusVoltage_V}
                    onChange={(e) => patchActiveProtection({ minValidBusVoltage_V: Number(e.target.value) })}
                    disabled={protectionFormLocked}
                  />
                </div>
              </div>
            </div>
          ) : null}

          <div className="btnRow btnRowTight">
            <button onClick={resetFault} disabled={activeStateName !== "FaultLatched"}>
              Clear fault
            </button>
            <button
              onClick={() => {
                if (mode === "advanced") {
                  updateActive({ protectionOverrides: undefined });
                  setMode("basic");
                } else {
                  setMode("advanced");
                }
              }}
              disabled={active.monitoring}
            >
              {mode === "basic" ? "Advanced" : "Basic"}
            </button>
            <button disabled title="Auto-ranging (planned)">
              Auto
            </button>
          </div>
        </div>

        <div className="panel panelChart">
          <h3>Plot</h3>
          <div className="chartToolbar">
            {lockIna3221ChartOptions ? (
              <div className="chartToolbarHint" style={{ marginBottom: 8 }}>
                INA3221 view locked while monitoring — Stop first.
              </div>
            ) : null}
            <div className="chartToolbarRow">
              <label className="chartToolbarLabel">
                <span className="chartToolbarTitle">Source</span>
                <select
                  className="chartToolbarSelect"
                  value={activeSourceId}
                  onChange={(e) => setActiveSourceId(e.target.value)}
                  title="Plot data source"
                >
                  <optgroup label="Hardware serial">
                    {serialSourcesSorted.map((s) => (
                      <option key={s.sourceId} value={s.sourceId}>
                        {formatHardwareSourceTitle(s)}
                        {s.monitoring ? " · live" : ""}
                      </option>
                    ))}
                  </optgroup>
                  <optgroup label="Simulation">
                    {mockSourcesOnly.map((s) => (
                      <option key={s.sourceId} value={s.sourceId}>
                        {formatHardwareSourceTitle(s)}
                        {s.monitoring ? " · live" : ""}
                      </option>
                    ))}
                  </optgroup>
                </select>
              </label>
              <div
                className="chartToolbarTraceGroup"
                title={
                  dcFilterPipeline.length === 0
                    ? "Add filter stages below, enable Plot overlay"
                    : "Apply filter chain to checked traces (Plot overlay on)"
                }
              >
                <span className="chartToolbarTracePrefix">ƒ</span>
                {(["v", "i", "p"] as const).map((k) => (
                  <label key={k} className="chartToolbarTraceLbl">
                    <input
                      type="checkbox"
                      className="chartToolbarTraceCb"
                      checked={dcFilterApplyTo[k]}
                      disabled={!dcChartFilterPreview || dcFilterPipeline.length === 0}
                      onChange={(e) => setDcFilterApplyTo((prev) => ({ ...prev, [k]: e.target.checked }))}
                    />
                    {k.toUpperCase()}
                  </label>
                ))}
              </div>
              {isMultiChannelChipId(effectiveChip(active)) ? (
                <>
                  <label className="chartToolbarLabel">
                    <span className="chartToolbarTitle">INA3221</span>
                    <select
                      className="chartToolbarSelect"
                      value={active.ina3221UiMode ?? "single"}
                      onChange={(e) => handleIna3221UiModeChange(e.target.value as Ina3221UiMode)}
                      disabled={lockIna3221ChartOptions}
                      title={
                        lockIna3221ChartOptions
                          ? "Locked while monitoring"
                          : "Single-channel poll vs all-channel strip chart"
                      }
                    >
                      <option value="single">1-ch poll</option>
                      <option value="all">3-ch strip</option>
                    </select>
                  </label>
                  {(active.ina3221UiMode ?? "single") === "single" ? (
                    <label className="chartToolbarLabel">
                      <span className="chartToolbarTitle">Channel</span>
                      <select
                        className="chartToolbarSelect"
                        value={String(active.ina3221SingleChannel ?? (typeof active.displayChannel === "number" ? active.displayChannel : 0))}
                        onChange={(e) => handleIna3221SingleChannelSwitch(Number(e.target.value) as 0 | 1 | 2)}
                        disabled={lockIna3221ChartOptions}
                        title={lockIna3221ChartOptions ? "Locked while monitoring" : "Active shunt channel"}
                      >
                        <option value="0">CH1</option>
                        <option value="1">CH2</option>
                        <option value="2">CH3</option>
                      </select>
                    </label>
                  ) : (
                    <label className="chartToolbarLabel">
                      <span className="chartToolbarTitle">Metrics</span>
                      <select
                        className="chartToolbarSelect"
                        value={
                          active.displayChannel === undefined || active.displayChannel === "aggregate"
                            ? "aggregate"
                            : String(active.displayChannel)
                        }
                        disabled={lockIna3221ChartOptions}
                        title={
                          lockIna3221ChartOptions
                            ? "Locked while monitoring"
                            : "Aggregate: three CH strips + readouts. CHn: one strip for that channel only."
                        }
                        onChange={(e) => {
                          const v = e.target.value;
                          const displayChannel = (v === "aggregate" ? "aggregate" : (Number(v) as 0 | 1 | 2)) as DisplayChannel;
                          updateActive({ displayChannel });
                        }}
                      >
                        <option value="aggregate">Aggregate</option>
                        <option value="0">CH1</option>
                        <option value="1">CH2</option>
                        <option value="2">CH3</option>
                      </select>
                    </label>
                  )}
                </>
              ) : null}
              <label className="chartToolbarMultiStrip">
                <input
                  type="checkbox"
                  checked={multiSerialChart}
                  onChange={(e) => setMultiSerialChart(e.target.checked)}
                  disabled={active.monitoring}
                  title={active.monitoring ? "Locked while monitoring" : "One strip per active source"}
                />
                <span>Multi-strip</span>
              </label>
            </div>
            {isMultiChannelChipId(effectiveChip(active)) && (active.ina3221UiMode ?? "single") === "all" ? (
              <div className="chartToolbarRow chartToolbarRowWrap">
                {active.transport === "Serial" ? (
                  <>
                    <span className="chartToolbarHint" style={{ marginRight: 8 }}>
                      Per-channel START CHn / STOP CHn (firmware):
                    </span>
                    {([0, 1, 2] as const).map((ch) => (
                      <span key={ch} className="ina3221ChGroup">
                        <span className="ina3221ChLabel">CH{ch + 1}</span>
                        <button
                          type="button"
                          className="btnGhost"
                          disabled={!active.connected || (active.ina3221ChannelRun?.[ch] ?? false)}
                          onClick={() => startIna3221ChannelOne(ch)}
                        >
                          Start
                        </button>
                        <button
                          type="button"
                          className="btnGhost"
                          disabled={!active.connected || !(active.ina3221ChannelRun?.[ch] ?? false)}
                          onClick={() => stopIna3221ChannelOne(ch)}
                        >
                          Stop
                        </button>
                      </span>
                    ))}
                  </>
                ) : (
                  <span className="chartToolbarHint">Mock: single stream; UI-only routing.</span>
                )}
              </div>
            ) : null}
            {!multiSerialChart && chartViewMismatch && sourceWithLivePoints ? (
              <div className="chartToolbarHint chartHintWarn">
                Live: {compactSourceTag(sourceWithLivePoints)} · Plot: {compactSourceTag(active)} — switch source or Multi-strip.
              </div>
            ) : null}
            {active.transport === "Serial" &&
            active.connected &&
            active.monitoring &&
            active.series.t.length === 0 &&
            !chartViewMismatch ? (
              <div className="chartToolbarHint">
                No samples: use Electron app (not browser). Firmware must stream JSON lines with measurements after Start.
              </div>
            ) : null}
          </div>
          <div className="chart">
            {multiSerialChart ? (
              monitoringChartSources.length === 0 ? (
                <div className="chartBodyFlex">
                  <div className="chartMainInner">
                    <div className="chartEmpty">
                      No active sources. Connect → Start, or disable multi-source for single plot.
                    </div>
                  </div>
                </div>
              ) : (
                <div className="chartBodyFlex">
                  <div className="chartMainInner">
                    <div className="legend legendMultiTop">
                      <span>
                        Multi-source · {monitoringChartSources.length} live · {monitoringChartStripItems.length} strip
                        {monitoringChartStripItems.length === 1 ? "" : "s"}
                      </span>
                      <span>
                        <span className="dot" style={{ background: "#5aa7ff" }} />V
                      </span>
                      <span>
                        <span className="dot" style={{ background: "#52c41a" }} />I
                      </span>
                      <span>
                        <span className="dot" style={{ background: "#faad14" }} />P
                      </span>
                    </div>
                    <div className="chartMultiStack">
                      {monitoringChartStripItems.map((item) => (
                        <div key={item.key} className="chartBlock chartBlockIntegrated">
                          <div className="chartBlockHead">
                            {item.ina3221Ch != null
                              ? `${compactSourceTag(item.source)} · CH${item.ina3221Ch + 1}`
                              : `${compactSourceTag(item.source)}${ina3221RouteSuffix(item.source)}`}
                          </div>
                          <div className="chartBlockInner">
                            <div className="chartSvgHost">
                              <MiniPlot
                                series={chartSeriesForPreview(item.series)}
                                sessionOriginMs={item.sessionOriginMs}
                                compact
                                plotDownsampleMax={plotDecimationMax(item.source.sampleRate)}
                                sampleRateHz={item.source.sampleRate}
                              />
                            </div>
                          </div>
                          {item.ina3221Ch != null ? (
                            <div className="chartStripMetrics">
                              <LiveMetricTriple
                                {...(item.source.lastFrame
                                  ? pickSignalsIna3221Channel(item.source.lastFrame, item.ina3221Ch)
                                  : {})}
                                className="cardsStripEmbedded"
                              />
                            </div>
                          ) : (
                            <SourceStripReadouts s={item.source} />
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              )
            ) : isMultiChannelChipId(effectiveChip(active)) && (active.ina3221UiMode ?? "single") === "all" ? (
              <div className="chartBodyFlex">
                <div className="chartMainInner">
                  <div className="legend legendMultiTop">
                    <span>
                      {active.displayChannel === undefined || active.displayChannel === "aggregate"
                        ? "INA3221 · 3 channels (aggregate view)"
                        : `INA3221 · CH${(active.displayChannel as number) + 1} only`}
                    </span>
                    <span>
                      <span className="dot" style={{ background: "#5aa7ff" }} />V
                    </span>
                    <span>
                      <span className="dot" style={{ background: "#52c41a" }} />I
                    </span>
                    <span>
                      <span className="dot" style={{ background: "#faad14" }} />P
                    </span>
                  </div>
                  <div className="chartMultiStack">
                    {(active.displayChannel === undefined || active.displayChannel === "aggregate"
                      ? ([0, 1, 2] as const)
                      : ([active.displayChannel] as const)
                    ).map((i) => {
                      const byCh = active.ina3221SeriesByCh ?? emptyIna3221SeriesByCh();
                      const origin = active.chartSessionOriginMsByCh?.[i] ?? null;
                      return (
                        <div key={i} className="chartBlock chartBlockIntegrated">
                          <div className="chartBlockHead">CH{i + 1}</div>
                          <div className="chartBlockInner">
                            <div className="chartSvgHost">
                              <MiniPlot
                                series={chartSeriesForPreview(byCh[i])}
                                sessionOriginMs={origin}
                                compact
                                plotDownsampleMax={plotDecimationMax(active.sampleRate)}
                                sampleRateHz={active.sampleRate}
                              />
                            </div>
                          </div>
                          <div className="chartStripMetrics">
                            <LiveMetricTriple
                              {...(active.lastFrame ? pickSignalsIna3221Channel(active.lastFrame, i) : {})}
                              className="cardsStripEmbedded"
                            />
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              </div>
            ) : (
              <div className="chartBodyFlex">
                <div className="chartMainInner">
                  <div className="legend">
                    <span>
                      <span className="dot" style={{ background: "#5aa7ff" }} />V
                    </span>
                    <span>
                      <span className="dot" style={{ background: "#52c41a" }} />I
                    </span>
                    <span>
                      <span className="dot" style={{ background: "#faad14" }} />P
                    </span>
                  </div>
                  <div className="chartSvgHost chartSvgHostMain">
                    <MiniPlot
                      series={chartSeriesForPreview(active.series)}
                      sessionOriginMs={active.chartSessionOriginMs}
                      plotDownsampleMax={plotDecimationMax(active.sampleRate)}
                      sampleRateHz={active.sampleRate}
                    />
                  </div>
                  <div className="chartStripMetrics">
                    <LiveMetricTriple {...picked} className="cardsStripEmbedded" />
                  </div>
                </div>
              </div>
            )}
          </div>

          <DcToolsPanel
            plugins={DC_ANALYSIS_PLUGINS}
            filterPlugins={DC_FILTER_PLUGINS}
            snap={buildDcToolsSnapshot(
              active.sourceId,
              active.serialPath,
              active.transport,
              effectiveChip(active),
              active.ina3221UiMode,
              active.series,
              active.ina3221SeriesByCh
            )}
            pipeline={dcFilterPipeline}
            onPipelineChange={setDcFilterPipeline}
            toolSignal={dcToolSignal}
            onToolSignalChange={setDcToolSignal}
            ina3221ToolCh={dcIna3221ToolCh}
            onIna3221ToolChChange={setDcIna3221ToolCh}
            chartFilterPreview={dcChartFilterPreview}
            onChartFilterPreviewChange={setDcChartFilterPreview}
            monitoring={active.monitoring}
          />
        </div>
      </div>

      <div className="footer">
        <div>INA Monitor Tool — NiusRobotLab</div>
        <div>
          Mode: {mode} • Source: {compactSourceTag(active)}
          {ina3221RouteSuffix(active)} • Rate: {active.sampleRate} Hz
          {active.transport === "Serial"
            ? ` • Chip: ${effectiveChip(active)} · Link: ${active.serialLinkBus === "spi" ? "SPI" : active.serialLinkBus === "i2c" ? "I²C" : "…"}`
            : ""}{" "}
          • Detection: {protectionCfg.enabled ? "on" : "off"}
        </div>
      </div>
    </div>
  );
}

/** Nice axis step for human-readable ticks */
function niceStep(rough: number): number {
  if (!Number.isFinite(rough) || rough <= 0) return 1;
  const exp = Math.floor(Math.log10(rough));
  const f = rough / Math.pow(10, exp);
  const nf = f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10;
  return nf * Math.pow(10, exp);
}

function niceTicks(lo: number, hi: number, maxTicks: number): number[] {
  if (!Number.isFinite(lo) || !Number.isFinite(hi) || hi < lo) return [];
  if (hi === lo) return [lo];
  const span = hi - lo;
  const step = niceStep(span / Math.max(2, maxTicks - 1));
  const start = Math.ceil(lo / step - 1e-9) * step;
  const ticks: number[] = [];
  for (let t = start; t <= hi + step * 0.001; t += step) {
    if (t >= lo - step * 1e-6) ticks.push(t);
    if (ticks.length > 16) break;
  }
  if (ticks.length === 0) ticks.push(lo, hi);
  return ticks;
}

/** Evenly spaced ticks inside [lo, hi] that move with the sliding window */
function timeWindowTicks(lo: number, hi: number, tickCount: number): number[] {
  if (!Number.isFinite(lo) || !Number.isFinite(hi) || hi < lo) return [];
  if (hi === lo) return [lo];
  const n = Math.max(2, Math.min(8, tickCount));
  const span = hi - lo;
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    out.push(lo + (span * i) / (n - 1));
  }
  return out;
}

/** Axis labels without scientific notation */
function formatAxisValue(n: number): string {
  if (!Number.isFinite(n)) return "—";
  if (n === 0) return "0";
  const sign = n < 0 ? "-" : "";
  const a = Math.abs(n);
  const trim = (s: string) => s.replace(/\.?0+$/, "") || "0";
  let body: string;
  if (a >= 1000) {
    body = trim(a.toFixed(2));
  } else if (a >= 100) {
    body = a.toFixed(0);
  } else if (a >= 10) {
    body = trim(a.toFixed(1));
  } else if (a >= 1) {
    body = trim(a.toFixed(2));
  } else if (a >= 0.01) {
    body = trim(a.toFixed(3));
  } else {
    const decimals = Math.min(18, Math.max(4, 2 - Math.floor(Math.log10(a))));
    body = trim(a.toFixed(decimals));
  }
  return sign + body;
}

/** Time-axis tick label (ms, relative) — short form when large so ticks stay readable */
function formatTimeTickMs(ms: number): string {
  if (!Number.isFinite(ms)) return "—";
  if (ms === 0) return "0";
  const a = Math.abs(ms);
  if (a >= 100000) return `${(ms / 1000).toFixed(0)}k`;
  if (a >= 10000) return `${(ms / 1000).toFixed(1)}k`;
  if (a >= 500) return `${Math.round(ms)}`;
  if (a >= 50) return `${Math.round(ms)}`;
  if (a >= 5) return ms.toFixed(1);
  return ms.toFixed(2);
}

function dataMinMax(arr: number[]): { min: number; max: number } | null {
  let lo = Infinity;
  let hi = -Infinity;
  for (const v of arr) {
    if (!Number.isFinite(v)) continue;
    lo = Math.min(lo, v);
    hi = Math.max(hi, v);
  }
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return null;
  return { min: lo, max: hi };
}

/** Padded data range for one Y trace (slightly more margin than before for calmer autoscale). */
function seriesYBounds(arr: number[]) {
  let lo = Infinity;
  let hi = -Infinity;
  for (const v of arr) {
    if (!Number.isFinite(v)) continue;
    lo = Math.min(lo, v);
    hi = Math.max(hi, v);
  }
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return { lo: 0, hi: 1 };
  if (lo === hi) {
    const e = Math.abs(lo) === 0 ? 0.5 : Math.abs(lo) * 0.05;
    return { lo: lo - e, hi: hi + e };
  }
  const m = 0.08 * (hi - lo);
  return { lo: lo - m, hi: hi + m };
}

/** Snap axis to coarse nice steps so tiny min/max wiggles do not rescale every frame. */
function quantizeAxisBounds(lo: number, hi: number): { lo: number; hi: number } {
  if (!Number.isFinite(lo) || !Number.isFinite(hi) || !(hi > lo)) return { lo, hi };
  const span = hi - lo;
  const step = niceStep(span / 4);
  if (!Number.isFinite(step) || step <= 0) return { lo, hi };
  const qLo = Math.floor(lo / step - 1e-9) * step;
  const qHi = Math.ceil(hi / step + 1e-9) * step;
  if (!(qHi > qLo)) return { lo, hi };
  return { lo: qLo, hi: qHi };
}

function quantizedSeriesYBounds(arr: number[]): { lo: number; hi: number } {
  const raw = seriesYBounds(arr);
  return quantizeAxisBounds(raw.lo, raw.hi);
}

/**
 * Stabilize Y autoscale: expand immediately when data needs room; contract slowly to reduce vertical jitter.
 * Invariant: lo <= raw.lo, hi >= raw.hi (curve stays inside axis).
 */
function smoothYAxisBounds(
  prev: { lo: number; hi: number } | null,
  raw: { lo: number; hi: number }
): { lo: number; hi: number } {
  if (!prev) return raw;
  let lo = Math.min(prev.lo, raw.lo);
  let hi = Math.max(prev.hi, raw.hi);
  const span = Math.max(hi - lo, 1e-12);
  const relax = span * 0.035;
  lo = Math.min(raw.lo, lo + relax);
  hi = Math.max(raw.hi, hi - relax);
  return { lo, hi };
}

function MiniPlot({
  series,
  sessionOriginMs,
  compact,
  plotDownsampleMax,
  sampleRateHz
}: {
  series: { t: number[]; v: number[]; i: number[]; p: number[] };
  sessionOriginMs: number | null;
  compact?: boolean;
  /** When buffer has more points, draw at most this many per trace (evenly spaced). */
  plotDownsampleMax?: number;
  /** Used to cap chart motion speed (~20 Hz visual at high sample rates). */
  sampleRateHz: number;
}) {
  const clipIdPrefix = useId().replace(/:/g, "");
  const hostRef = useRef<HTMLDivElement>(null);
  const yAxisStableRef = useRef<Record<"v" | "i" | "p", { lo: number; hi: number } | null>>({
    v: null,
    i: null,
    p: null
  });
  const yAxisSessionKeyRef = useRef(sessionOriginMs);
  if (sessionOriginMs !== yAxisSessionKeyRef.current) {
    yAxisSessionKeyRef.current = sessionOriginMs;
    yAxisStableRef.current = { v: null, i: null, p: null };
  }
  const throttleMs = useMemo(() => chartUiThrottleMs(sampleRateHz), [sampleRateHz]);
  const plotSeries = useThrottledPlotSeries(series as SeriesBundle, throttleMs);
  const H = compact ? 740 : 1040;
  /** Match viewBox aspect ratio to host so preserveAspectRatio="meet" fills width (no side letterbox). */
  const [vbW, setVbW] = useState(1400);

  useLayoutEffect(() => {
    const el = hostRef.current;
    if (!el) return;
    const sync = () => {
      let cw = el.clientWidth;
      let ch = el.clientHeight;
      const parent = el.parentElement;
      if ((ch < 12 || cw < 12) && parent) {
        cw = Math.max(cw, parent.clientWidth);
        ch = Math.max(ch, parent.clientHeight);
      }
      if (ch < 8 || cw < 8) return;
      const next = H * (cw / ch);
      setVbW(Math.max(620, Math.min(7200, next)));
    };
    const syncSoon = () => {
      sync();
      requestAnimationFrame(() => {
        sync();
        requestAnimationFrame(sync);
      });
    };
    syncSoon();
    const t1 = window.setTimeout(sync, 0);
    const t2 = window.setTimeout(sync, 80);
    const t3 = window.setTimeout(sync, 280);
    const onWinResize = () => sync();
    window.addEventListener("resize", onWinResize);
    const ro = new ResizeObserver(() => requestAnimationFrame(sync));
    ro.observe(el);
    if (el.parentElement) ro.observe(el.parentElement);
    return () => {
      window.clearTimeout(t1);
      window.clearTimeout(t2);
      window.clearTimeout(t3);
      window.removeEventListener("resize", onWinResize);
      ro.disconnect();
    };
  }, [H, plotSeries.t.length]);

  const W = vbW;
  /** Title column (left of Y ticks) — generous for large labels */
  const titleColW = compact ? 78 : 92;
  /** Y tick numerals sit in [titleColW, leftM) */
  const tickColW = compact ? 86 : 100;
  const tickGap = 12;
  const leftM = titleColW + tickColW + tickGap;
  /** Wide band for Axis + Min/max lines (user-readable at scale) */
  const rightM = compact ? 220 : 248;
  const bottomM = compact ? 88 : 104;
  const topM = compact ? 10 : 14;
  const rowGap = compact ? 10 : 14;
  const plotW = W - leftM - rightM;
  /** User-space px; scales uniformly with SVG meet — keep large for legibility */
  const labelFs = compact ? 22 : 25;
  const unitFs = compact ? 18 : 21;
  const axisNumFs = compact ? 22 : 25;
  const metaFs = compact ? 18 : 21;
  const axisLineY = H - bottomM + 28;
  const xTickLabelY = H - (compact ? 38 : 44);
  const timeCaptionY = H - (compact ? 12 : 14);

  const xs = plotSeries.t;
  const origin = sessionOriginMs ?? (xs.length ? xs[0]! : 0);
  function relMs(tAbs: number) {
    return tAbs - origin;
  }
  const xmin = xs.length ? relMs(xs[0]!) : 0;
  const xmax = xs.length ? relMs(xs[xs.length - 1]!) : 0;
  const xspan = Math.max(1e-6, xmax - xmin);

  const dmax = plotDownsampleMax ?? 1600;
  const plotIndices = useMemo(() => {
    const n = xs.length;
    if (n <= dmax) return null as number[] | null;
    const out: number[] = [];
    const step = (n - 1) / (dmax - 1);
    for (let j = 0; j < dmax; j++) {
      out.push(Math.min(n - 1, Math.round(j * step)));
    }
    return out;
  }, [xs.length, dmax]);

  const lineStrokeW =
    compact ? (xs.length > 1400 ? 1.65 : 2.25) : xs.length > 1400 ? 1.85 : 2.5;

  const rows = useMemo(() => {
    const r = yAxisStableRef.current;
    const boundsFor = (arr: number[], k: "v" | "i" | "p") => {
      const raw = quantizedSeriesYBounds(arr);
      const s = smoothYAxisBounds(r[k], raw);
      r[k] = s;
      return s;
    };
    return [
      { key: "v" as const, label: "Vbus", unit: "V", color: "#5aa7ff", data: plotSeries.v, bounds: boundsFor(plotSeries.v, "v") },
      { key: "i" as const, label: "I", unit: "A", color: "#52c41a", data: plotSeries.i, bounds: boundsFor(plotSeries.i, "i") },
      { key: "p" as const, label: "P", unit: "W", color: "#faad14", data: plotSeries.p, bounds: boundsFor(plotSeries.p, "p") }
    ] as const;
  }, [plotSeries]);

  const plotH = (H - topM - bottomM - 2 * rowGap) / 3;

  function rowTop(i: number) {
    return topM + i * (plotH + rowGap);
  }

  function plotTop(i: number) {
    return rowTop(i);
  }

  const firstPlotTop = plotTop(0);
  const lastPlotBottom = plotTop(2) + plotH;

  const xTicksRel = timeWindowTicks(xmin, xmax, 6);

  function xToPx(tAbs: number) {
    return leftM + ((relMs(tAbs) - xmin) / xspan) * plotW;
  }

  function pathForRow(arr: number[], bounds: { lo: number; hi: number }, pTop: number) {
    const yspan = Math.max(1e-12, bounds.hi - bounds.lo);
    const pts: string[] = [];
    const idxs = plotIndices;
    const emit = (k: number) => {
      const tx = xs[k]!;
      const y = arr[k]!;
      if (!Number.isFinite(y)) return;
      const px = xToPx(tx);
      const py = pTop + plotH - ((y - bounds.lo) / yspan) * plotH;
      pts.push(`${px.toFixed(2)},${py.toFixed(2)}`);
    };
    if (idxs) {
      for (const k of idxs) emit(k);
    } else {
      for (let k = 0; k < xs.length; k++) emit(k);
    }
    return pts.join(" ");
  }

  const gridStroke = "rgba(255,255,255,0.07)";
  const axisStroke = "rgba(255,255,255,0.28)";
  const panelStroke = "rgba(255,255,255,0.14)";
  const textFill = "#aab6d3";
  const textMuted = "#7d8aad";

  if (xs.length === 0) {
    return (
      <div className="chartEmpty">
        No data. Connect → Start monitoring.
      </div>
    );
  }

  return (
    <div ref={hostRef} className="miniPlotResizeHost">
      <svg
        className="chartSvg"
        width="100%"
        height="100%"
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="xMidYMid meet"
        overflow="visible"
        style={{ fontVariantNumeric: "tabular-nums" }}
      >
      <defs>
        {rows.map((r, i) => {
          const pt = plotTop(i);
          return (
            <clipPath key={r.key} id={`${clipIdPrefix}-clip-${r.key}`}>
              <rect x={leftM} y={pt} width={plotW} height={plotH} />
            </clipPath>
          );
        })}
      </defs>

      {xTicksRel.map((tick, tickIdx) => {
        const px = leftM + ((tick - xmin) / xspan) * plotW;
        return (
          <g key={`xt-${tickIdx}-${tick.toFixed(2)}`}>
            <line x1={px} y1={firstPlotTop} x2={px} y2={lastPlotBottom} stroke={gridStroke} strokeWidth={1} />
            <text
              x={px}
              y={xTickLabelY}
              fill={textFill}
              fontSize={axisNumFs}
              textAnchor="middle"
              fontFamily="ui-sans-serif, system-ui, Segoe UI, Roboto, sans-serif"
            >
              {formatTimeTickMs(tick)}
            </text>
          </g>
        );
      })}
      <text
        x={leftM}
        y={timeCaptionY}
        fill={textMuted}
        fontSize={metaFs}
        fontFamily="ui-sans-serif, system-ui, Segoe UI, Roboto, sans-serif"
      >
        {sessionOriginMs != null ? "t (ms, session origin)" : "t (ms, first visible sample)"}
      </text>
      <line
        x1={leftM}
        y1={axisLineY}
        x2={W - rightM}
        y2={axisLineY}
        stroke={axisStroke}
        strokeWidth={1.2}
      />

      {rows.map((r, i) => {
        const ry = rowTop(i);
        const pt = plotTop(i);
        const yTicks = niceTicks(r.bounds.lo, r.bounds.hi, 5);
        const mm = dataMinMax(r.data);
        const lo = r.bounds.lo;
        const hi = r.bounds.hi;
        const ty = ry + plotH / 2;
        const tickTextX = leftM - 10;
        const metaPad = 14;
        const metaY1 = ry + metaPad + metaFs * 0.85;
        const metaY2 = metaY1 + metaFs * 1.35;

        return (
          <g key={r.key}>
            <text
              x={10}
              y={ty - (compact ? 9 : 10)}
              fill={r.color}
              fontSize={labelFs}
              fontWeight={700}
              textAnchor="start"
              dominantBaseline="middle"
              fontFamily="ui-sans-serif, system-ui, Segoe UI, Roboto, sans-serif"
            >
              {r.label}
            </text>
            <text
              x={10}
              y={ty + (compact ? 11 : 12)}
              fill={textMuted}
              fontSize={unitFs}
              textAnchor="start"
              dominantBaseline="middle"
              fontFamily="ui-sans-serif, system-ui, Segoe UI, Roboto, sans-serif"
            >
              ({r.unit})
            </text>

            <text
              x={W - metaPad}
              y={metaY1}
              fill={textMuted}
              fontSize={metaFs}
              textAnchor="end"
              fontFamily="ui-sans-serif, system-ui, Segoe UI, Roboto, sans-serif"
            >
              {`Axis [${formatAxisValue(lo)}, ${formatAxisValue(hi)}] ${r.unit}`}
            </text>
            {mm ? (
              <text
                x={W - metaPad}
                y={metaY2}
                fill={textMuted}
                fontSize={metaFs}
                textAnchor="end"
                fontFamily="ui-sans-serif, system-ui, Segoe UI, Roboto, sans-serif"
              >
                {`Min/max ${formatAxisValue(mm.min)} / ${formatAxisValue(mm.max)} ${r.unit}`}
              </text>
            ) : null}

            <rect
              x={leftM}
              y={pt}
              width={plotW}
              height={plotH}
              fill="rgba(0,0,0,0.14)"
              stroke={panelStroke}
              strokeWidth={1}
              rx={3}
            />
            {yTicks.map((yv) => {
              const yspan = Math.max(1e-12, r.bounds.hi - r.bounds.lo);
              const py = pt + plotH - ((yv - r.bounds.lo) / yspan) * plotH;
              return (
                <g key={`${r.key}-y-${yv}`}>
                  <line x1={leftM} y1={py} x2={W - rightM} y2={py} stroke={gridStroke} strokeWidth={1} />
                  <text
                    x={tickTextX}
                    y={py}
                    fill={textFill}
                    fontSize={axisNumFs}
                    textAnchor="end"
                    dominantBaseline="middle"
                    fontFamily="ui-sans-serif, system-ui, Segoe UI, Roboto, sans-serif"
                  >
                    {formatAxisValue(yv)}
                  </text>
                </g>
              );
            })}
            <line x1={leftM} y1={pt} x2={leftM} y2={pt + plotH} stroke={axisStroke} strokeWidth={1.2} />
            <line x1={W - rightM} y1={pt} x2={W - rightM} y2={pt + plotH} stroke={axisStroke} strokeWidth={1.2} />
            <polyline
              fill="none"
              stroke={r.color}
              strokeWidth={lineStrokeW}
              strokeLinejoin="round"
              strokeLinecap="round"
              points={pathForRow(r.data, r.bounds, pt)}
              style={{ clipPath: `url(#${clipIdPrefix}-clip-${r.key})` }}
            />
          </g>
        );
      })}
      </svg>
    </div>
  );
}

