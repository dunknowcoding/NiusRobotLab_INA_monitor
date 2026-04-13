import React, { useEffect, useRef, useState } from "react";
import type { ChipId } from "@niusrobotlab/ina-monitor-core";
import type { DcAnalysisPlugin, DcAnalysisResult, DcSignalKey } from "../../tool/pluginSdk";
import { columnForSignal, extractFiniteSeries } from "../../tool/pluginSdk";
import type { DcFilterPlugin } from "../../tool/filterPluginSdk";
import { filterPluginMap } from "../tools/dcFilterRegistry";
import { applyDcFilterPipeline, bundleWithSignalColumn, type DcPipelineStep } from "../tools/dcFilterPipeline";
import { applyAnalysisWindow } from "../tools/dcAnalysisWindow";
import { emptySeries, SERIES_BUFFER_CAPACITY, type Ina3221UiMode, type SeriesBundle } from "./ina3221Helpers";

export type DcToolsSourceSnapshot = {
  sourceLabel: string;
  chip: ChipId;
  ina3221Mode: "single" | "all" | "na";
  series: SeriesBundle;
  ina3221SeriesByCh?: [SeriesBundle, SeriesBundle, SeriesBundle];
};

type ToolsTab = "filters" | "analysis" | "window" | "advanced" | "output";

function isMultiChannelChipId(chip: ChipId): boolean {
  return chip === "INA3221" || chip === "INA3221-Q1";
}

function signalLabel(k: DcSignalKey): string {
  if (k === "v") return "Bus V";
  if (k === "i") return "Shunt I";
  return "Power";
}

function newStepId(): string {
  return typeof crypto !== "undefined" && crypto.randomUUID
    ? crypto.randomUUID()
    : `s-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

function defaultStepForFilter(filterId: string): Omit<DcPipelineStep, "uid"> {
  if (filterId === "ema") return { id: "ema", window: 8 };
  if (filterId === "median") return { id: "median", window: 5 };
  if (filterId === "slew-limit") return { id: "slew-limit", maxStep: 0.01 };
  return { id: "boxcar", window: 5 };
}

function rmsDiff(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return NaN;
  let s = 0;
  for (let i = 0; i < a.length; i++) {
    const d = a[i]! - b[i]!;
    s += d * d;
  }
  return Math.sqrt(s / a.length);
}

function formatMetricValue(v: string | number | undefined, sigDigits: number): string {
  if (v === undefined) return "—";
  if (typeof v === "number" && Number.isFinite(v)) {
    const d = Math.max(3, Math.min(12, Math.floor(sigDigits)));
    return v.toPrecision(d);
  }
  return String(v);
}

type AnalysisOutcome =
  | null
  | { kind: "error"; message: string }
  | {
      kind: "ok";
      toolTitle: string;
      rBefore: DcAnalysisResult;
      rAfter: DcAnalysisResult;
      chainLine: string;
      rms: number;
      same: boolean;
      chartPreviewOn: boolean;
      windowDescription: string;
    };

function deltaRows(
  before: DcAnalysisResult,
  after: DcAnalysisResult,
  sigDigits: number
): { key: string; before: string; after: string; delta: string }[] {
  const keys = [...new Set([...Object.keys(before.metrics ?? {}), ...Object.keys(after.metrics ?? {})])].sort();
  const d = Math.max(3, Math.min(12, Math.floor(sigDigits)));
  return keys.map((k) => {
    const vb = before.metrics?.[k];
    const va = after.metrics?.[k];
    const bothNum = typeof vb === "number" && typeof va === "number" && Number.isFinite(vb) && Number.isFinite(va);
    return {
      key: k,
      before: formatMetricValue(vb, sigDigits),
      after: formatMetricValue(va, sigDigits),
      delta: bothNum ? (va - vb).toPrecision(d) : "—"
    };
  });
}

function AnalysisResultColumn({ title, r, sigDigits }: { title: string; r: DcAnalysisResult; sigDigits: number }) {
  const entries = r.metrics ? Object.entries(r.metrics) : [];
  return (
    <div className="dcAnalysisCol">
      <div className="dcAnalysisColHead">{title}</div>
      <p className="dcAnalysisSummary">{r.summary}</p>
      {entries.length > 0 ? (
        <dl className="dcAnalysisDl">
          {entries.map(([k, v]) => (
            <React.Fragment key={k}>
              <dt>{k}</dt>
              <dd>{formatMetricValue(v, sigDigits)}</dd>
            </React.Fragment>
          ))}
        </dl>
      ) : (
        <p className="dcAnalysisMuted">No metric table</p>
      )}
    </div>
  );
}

type Props = {
  plugins: DcAnalysisPlugin[];
  filterPlugins: DcFilterPlugin[];
  snap: DcToolsSourceSnapshot;
  pipeline: DcPipelineStep[];
  onPipelineChange: React.Dispatch<React.SetStateAction<DcPipelineStep[]>>;
  toolSignal: DcSignalKey;
  onToolSignalChange: (s: DcSignalKey) => void;
  ina3221ToolCh: 0 | 1 | 2;
  onIna3221ToolChChange: (c: 0 | 1 | 2) => void;
  chartFilterPreview: boolean;
  onChartFilterPreviewChange: (v: boolean) => void;
  /** Used with Auto: when true, the timer runs only while capture is active */
  monitoring: boolean;
};

const TAB_LABELS: Record<ToolsTab, string> = {
  filters: "Filters",
  analysis: "Analysis",
  window: "Time window",
  advanced: "Advanced",
  output: "Output"
};

export function DcToolsPanel({
  plugins,
  filterPlugins,
  snap,
  pipeline,
  onPipelineChange,
  toolSignal,
  onToolSignalChange,
  ina3221ToolCh,
  onIna3221ToolChChange,
  chartFilterPreview,
  onChartFilterPreviewChange,
  monitoring
}: Props) {
  const [toolsTab, setToolsTab] = useState<ToolsTab>("filters");
  const [pluginId, setPluginId] = useState(() => plugins[0]?.manifest.id ?? "");
  const [addFilterId, setAddFilterId] = useState(() => filterPlugins[0]?.manifest.id ?? "");
  const [windowN, setWindowN] = useState(5);
  const [thrHigh, setThrHigh] = useState("");
  const [thrLow, setThrLow] = useState("");
  const [analysisOutcome, setAnalysisOutcome] = useState<AnalysisOutcome>(null);
  const [busy, setBusy] = useState(false);
  const [rmsEpsilonStr, setRmsEpsilonStr] = useState("1e-15");
  const [metricSigDigits, setMetricSigDigits] = useState(6);

  const [analysisMode, setAnalysisMode] = useState<"manual" | "auto">("manual");
  const [autoIntervalMs, setAutoIntervalMs] = useState(1000);
  const [analysisDurationMsStr, setAnalysisDurationMsStr] = useState("");
  const [analysisMaxPointsStr, setAnalysisMaxPointsStr] = useState(String(SERIES_BUFFER_CAPACITY));
  const [autoOnlyWhenMonitoring, setAutoOnlyWhenMonitoring] = useState(true);

  const busyRef = useRef(false);
  const runAnalysisRef = useRef<() => Promise<void>>(async () => {});

  const selected = plugins.find((p) => p.manifest.id === pluginId) ?? plugins[0];
  const fMap = filterPluginMap(filterPlugins);

  const bundle = (() => {
    if (isMultiChannelChipId(snap.chip) && snap.ina3221Mode === "all") {
      return snap.ina3221SeriesByCh?.[ina3221ToolCh] ?? emptySeries();
    }
    return snap.series;
  })();

  const sourceLabel =
    isMultiChannelChipId(snap.chip) && snap.ina3221Mode === "all"
      ? `${snap.sourceLabel} · CH${ina3221ToolCh + 1}`
      : snap.sourceLabel;

  const sampleCount = bundle.t.length;

  function moveStep(uid: string, dir: -1 | 1) {
    onPipelineChange((prev) => {
      const i = prev.findIndex((s) => s.uid === uid);
      if (i < 0) return prev;
      const j = i + dir;
      if (j < 0 || j >= prev.length) return prev;
      const next = [...prev];
      [next[i], next[j]] = [next[j]!, next[i]!];
      return next;
    });
  }

  function updateStep(uid: string, patch: Partial<DcPipelineStep>) {
    onPipelineChange((prev) => prev.map((s) => (s.uid === uid ? { ...s, ...patch } : s)));
  }

  function addFilter() {
    const id = addFilterId;
    if (!id) return;
    const base = defaultStepForFilter(id);
    onPipelineChange((prev) => [...prev, { uid: newStepId(), ...base }]);
  }

  async function runAnalysis() {
    if (!selected) {
      setAnalysisOutcome({ kind: "error", message: "No analysis plugins loaded." });
      return;
    }
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setAnalysisOutcome(null);
    try {
      const yRaw = columnForSignal(bundle, toolSignal);
      const { t: t0, y: y0 } = extractFiniteSeries(bundle.t, yRaw);
      if (t0.length === 0) {
        setAnalysisOutcome({ kind: "error", message: "No finite samples — start capture or widen the window." });
        return;
      }

      const durParsed = analysisDurationMsStr.trim();
      const durationMs = durParsed === "" ? undefined : parseFloat(durParsed);
      const maxParsed = analysisMaxPointsStr.trim();
      const maxPoints = maxParsed === "" ? undefined : parseInt(maxParsed, 10);
      const winOpts = {
        durationMs: typeof durationMs === "number" && durationMs > 0 && Number.isFinite(durationMs) ? durationMs : undefined,
        maxPoints: typeof maxPoints === "number" && maxPoints > 0 && Number.isFinite(maxPoints) ? maxPoints : undefined
      };
      const { t, y, description: windowDescription } = applyAnalysisWindow(t0, y0, winOpts);
      if (t.length === 0) {
        setAnalysisOutcome({ kind: "error", message: windowDescription || "No samples in the analysis window." });
        return;
      }

      const { yOut, chainLine } = applyDcFilterPipeline(t, y, pipeline, fMap);
      const rms = rmsDiff(y, yOut);
      const epsParsed = parseFloat(rmsEpsilonStr.trim().replace(/,/g, ""));
      const effEps = Number.isFinite(epsParsed) && epsParsed > 0 ? epsParsed : 1e-15;
      const same = pipeline.length === 0 || (Number.isFinite(rms) && rms < effEps);

      const opt: { window?: number; thresholdHigh?: number; thresholdLow?: number } = {};
      if (selected.manifest.id === "moving-average") {
        opt.window = Math.max(1, Math.floor(windowN) || 5);
      }
      if (selected.manifest.id === "threshold-events") {
        const h = parseFloat(thrHigh);
        const l = parseFloat(thrLow);
        if (Number.isFinite(h)) opt.thresholdHigh = h;
        if (Number.isFinite(l)) opt.thresholdLow = l;
      }

      const baseCtx = {
        signal: toolSignal,
        signalLabel: signalLabel(toolSignal),
        sourceLabel,
        sampleCount: t.length,
        options: Object.keys(opt).length ? opt : undefined
      };

      const seriesBefore = bundleWithSignalColumn(t, y, toolSignal);
      const seriesAfter = bundleWithSignalColumn(t, yOut, toolSignal);

      const rBefore = await Promise.resolve(
        selected.run({
          ...baseCtx,
          series: seriesBefore
        })
      );
      const rAfter = await Promise.resolve(
        selected.run({
          ...baseCtx,
          series: seriesAfter
        })
      );

      setAnalysisOutcome({
        kind: "ok",
        toolTitle: selected.manifest.name,
        rBefore,
        rAfter,
        chainLine,
        rms,
        same,
        chartPreviewOn: chartFilterPreview,
        windowDescription
      });
      if (analysisMode === "manual") setToolsTab("output");
    } catch (e) {
      setAnalysisOutcome({ kind: "error", message: e instanceof Error ? e.message : String(e) });
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  runAnalysisRef.current = runAnalysis;

  useEffect(() => {
    const autoActive =
      analysisMode === "auto" &&
      (!autoOnlyWhenMonitoring || monitoring) &&
      sampleCount > 0 &&
      Boolean(selected);
    if (!autoActive) return;
    const id = window.setInterval(() => {
      void runAnalysisRef.current();
    }, autoIntervalMs);
    return () => window.clearInterval(id);
  }, [analysisMode, autoIntervalMs, autoOnlyWhenMonitoring, monitoring, sampleCount, pluginId]);

  const scheduleFields = (
    <div className="dcToolsScheduleRow">
      <label className="dcToolsField dcToolsFieldTrigger">
        <span className="dcToolsFieldLabel">Trigger</span>
        <select
          className="dcToolsSelect dcToolsSelectSm"
          value={analysisMode}
          onChange={(e) => setAnalysisMode(e.target.value as "manual" | "auto")}
        >
          <option value="manual">Manual</option>
          <option value="auto">Auto</option>
        </select>
      </label>
      {analysisMode === "auto" ? (
        <div className="dcToolsAutoScheduleGroup">
          <label className="dcToolsField">
            <span className="dcToolsFieldLabel">Period</span>
            <select
              className="dcToolsSelect dcToolsSelectSm"
              value={String(autoIntervalMs)}
              onChange={(e) => setAutoIntervalMs(Number(e.target.value))}
            >
              <option value="500">0.5 s</option>
              <option value="1000">1 s</option>
              <option value="2000">2 s</option>
              <option value="5000">5 s</option>
              <option value="10000">10 s</option>
            </select>
          </label>
          <label className="dcToolsField dcToolsFieldCheck">
            <input type="checkbox" checked={autoOnlyWhenMonitoring} onChange={(e) => setAutoOnlyWhenMonitoring(e.target.checked)} />
            <span>Auto</span>
          </label>
        </div>
      ) : null}
    </div>
  );

  const tabList = (Object.keys(TAB_LABELS) as ToolsTab[]).map((id) => (
    <button
      key={id}
      type="button"
      className={`dcToolsTab${toolsTab === id ? " dcToolsTabActive" : ""}`}
      onClick={() => setToolsTab(id)}
    >
      {TAB_LABELS[id]}
    </button>
  ));

  return (
    <div className="dcToolsPanel dcToolsPanelCompact dcToolsPanelDense">
      <div className="dcToolsTopCluster" role="region" aria-label="DC tools header">
        <h4 className="dcToolsTitle">DC filters / analysis</h4>
        <div className="dcToolsTopClusterTail">
          <label className="dcToolsPreviewToggle">
            <input
              type="checkbox"
              checked={chartFilterPreview}
              onChange={(e) => onChartFilterPreviewChange(e.target.checked)}
            />
            Plot overlay
          </label>
          <span className="dcToolsMutedSm dcToolsMetaInline" title="Active source buffer">
            {sourceLabel} · {sampleCount}/{SERIES_BUFFER_CAPACITY}
            {analysisMode === "auto" ? ` · ${autoIntervalMs / 1000}s` : ""}
          </span>
          <button
            type="button"
            className="btnGhost btnTiny"
            disabled={busy || !selected || sampleCount === 0}
            title="Run analysis once (Manual). For periodic runs, set Trigger to Auto on the Analysis tab."
            onClick={() => void runAnalysis()}
          >
            {busy ? "…" : "Run"}
          </button>
        </div>
      </div>

      <div className="dcToolsTabBar dcToolsTabBarDense" role="tablist" aria-label="Tool sections">
        {tabList}
      </div>

      <div className="dcToolsTabPanel dcToolsTabPanelDense">
        {toolsTab === "filters" ? (
          <div className="dcToolsCol">
            <div className="dcToolsToolbar">
              <select className="dcToolsSelect dcToolsSelectSm" value={addFilterId} onChange={(e) => setAddFilterId(e.target.value)}>
                {filterPlugins.map((p) => (
                  <option key={p.manifest.id} value={p.manifest.id}>
                    {p.manifest.name}
                  </option>
                ))}
              </select>
              <button type="button" className="btnGhost btnTiny" disabled={filterPlugins.length === 0} onClick={addFilter}>
                Add
              </button>
            </div>
            {pipeline.length > 0 ? (
              <ul className="dcFilterChain dcFilterChainCompact">
                {pipeline.map((step, idx) => {
                  const fp = fMap.get(step.id);
                  const name = fp?.manifest.name ?? step.id;
                  return (
                    <li key={step.uid} className="dcFilterChainItem">
                      <span className="dcFilterChainIdx">{idx + 1}</span>
                      <span className="dcFilterChainName">{name}</span>
                      {step.id === "ema" ? (
                        <>
                          <input
                            className="dcToolsInputMicro"
                            type="number"
                            title="EMA span (samples)"
                            min={1}
                            max={200}
                            value={step.window ?? 8}
                            onChange={(e) => updateStep(step.uid, { window: Number(e.target.value) })}
                          />
                          <input
                            className="dcToolsInputMicro"
                            type="text"
                            title="α override (empty = derive from span)"
                            placeholder="α"
                            value={step.alpha != null ? String(step.alpha) : ""}
                            onChange={(e) => {
                              const v = e.target.value.trim();
                              if (v === "") {
                                updateStep(step.uid, { alpha: undefined });
                                return;
                              }
                              const a = parseFloat(v);
                              if (Number.isFinite(a)) updateStep(step.uid, { alpha: a });
                            }}
                          />
                        </>
                      ) : null}
                      {(step.id === "boxcar" || step.id === "median") && (
                        <input
                          className="dcToolsInputMicro"
                          type="number"
                          title="Window length (samples)"
                          min={step.id === "median" ? 3 : 1}
                          max={99}
                          value={step.window ?? 5}
                          onChange={(e) => updateStep(step.uid, { window: Number(e.target.value) })}
                        />
                      )}
                      {step.id === "slew-limit" && (
                        <input
                          className="dcToolsInputMicro"
                          type="text"
                          title="Max |Δy| per sample (signal units)"
                          value={step.maxStep != null ? String(step.maxStep) : "0.01"}
                          onChange={(e) => {
                            const a = parseFloat(e.target.value);
                            if (Number.isFinite(a)) updateStep(step.uid, { maxStep: a });
                          }}
                        />
                      )}
                      <span className="dcFilterChainBtns">
                        <button type="button" className="btnGhost btnTiny" onClick={() => moveStep(step.uid, -1)} disabled={idx === 0}>
                          ↑
                        </button>
                        <button
                          type="button"
                          className="btnGhost btnTiny"
                          onClick={() => moveStep(step.uid, 1)}
                          disabled={idx === pipeline.length - 1}
                        >
                          ↓
                        </button>
                        <button type="button" className="btnGhost btnTiny" onClick={() => onPipelineChange((p) => p.filter((x) => x.uid !== step.uid))}>
                          ×
                        </button>
                      </span>
                    </li>
                  );
                })}
              </ul>
            ) : (
              <p className="dcToolsMutedSm">Empty chain → identity on the analysis column.</p>
            )}
          </div>
        ) : null}

        {toolsTab === "analysis" ? (
          <div className="dcToolsCol">
            <div className="dcToolsToolbar dcToolsToolbarWrap">
              <select className="dcToolsSelect dcToolsSelectSm" value={selected?.manifest.id ?? ""} onChange={(e) => setPluginId(e.target.value)}>
                {plugins.map((p) => (
                  <option key={p.manifest.id} value={p.manifest.id}>
                    {p.manifest.name}
                  </option>
                ))}
              </select>
              <select className="dcToolsSelect dcToolsSelectSm" value={toolSignal} onChange={(e) => onToolSignalChange(e.target.value as DcSignalKey)}>
                <option value="v">V</option>
                <option value="i">A</option>
                <option value="p">W</option>
              </select>
              {isMultiChannelChipId(snap.chip) && snap.ina3221Mode === "all" ? (
                <select
                  className="dcToolsSelect dcToolsSelectSm"
                  value={ina3221ToolCh}
                  onChange={(e) => onIna3221ToolChChange(Number(e.target.value) as 0 | 1 | 2)}
                >
                  <option value={0}>CH1</option>
                  <option value={1}>CH2</option>
                  <option value={2}>CH3</option>
                </select>
              ) : null}
            </div>
            {selected?.manifest.id === "moving-average" ? (
              <div className="dcToolsToolbar">
                <span className="dcToolsMutedSm">Internal MA length</span>
                <input
                  className="dcToolsInputMicro"
                  type="number"
                  min={1}
                  max={500}
                  value={windowN}
                  onChange={(e) => setWindowN(Number(e.target.value))}
                />
              </div>
            ) : null}
            {selected?.manifest.id === "threshold-events" ? (
              <div className="dcToolsToolbar">
                <input
                  className="dcToolsInputMicro dcToolsInputThr"
                  type="text"
                  placeholder="Upper"
                  title="Upper threshold (finite)"
                  value={thrHigh}
                  onChange={(e) => setThrHigh(e.target.value)}
                />
                <input
                  className="dcToolsInputMicro dcToolsInputThr"
                  type="text"
                  placeholder="Lower"
                  title="Lower threshold (finite)"
                  value={thrLow}
                  onChange={(e) => setThrLow(e.target.value)}
                />
              </div>
            ) : null}
            <div className="dcToolsWindowGrid" style={{ marginTop: 10 }}>
              <p className="dcToolsMutedSm dcToolsFieldSpan2" style={{ margin: 0 }}>
                <strong>Manual</strong> — click <strong>Run</strong> in the header. <strong>Auto</strong> — same analysis on a timer while samples exist
                {autoOnlyWhenMonitoring ? " and monitoring is on" : ""}.
              </p>
              {scheduleFields}
            </div>
          </div>
        ) : null}

        {toolsTab === "window" ? (
          <div className="dcToolsCol dcToolsWindowGrid">
            <p className="dcToolsMutedSm dcToolsFieldSpan2" style={{ margin: 0 }}>
              <strong>Schedule</strong> (Manual / Auto) is shared with the <strong>Analysis</strong> tab. Below: limit which samples are passed into the tool (time tail).
            </p>
            {scheduleFields}
            <label className="dcToolsField dcToolsFieldSpan2">
              <span className="dcToolsFieldLabel">Last duration (ms)</span>
              <input
                className="dcToolsInputMicro dcToolsInputWide"
                type="text"
                inputMode="decimal"
                placeholder="∞"
                title="Keep samples whose t ≥ t_max − duration; empty = no time trim"
                value={analysisDurationMsStr}
                onChange={(e) => setAnalysisDurationMsStr(e.target.value)}
              />
            </label>
            <label className="dcToolsField dcToolsFieldSpan2">
              <span className="dcToolsFieldLabel">Tail max points</span>
              <input
                className="dcToolsInputMicro dcToolsInputWide"
                type="text"
                inputMode="numeric"
                placeholder="∞"
                title="After time trim, keep at most N newest finite samples; empty = no cap"
                value={analysisMaxPointsStr}
                onChange={(e) => setAnalysisMaxPointsStr(e.target.value)}
              />
            </label>
          </div>
        ) : null}

        {toolsTab === "advanced" ? (
          <div className="dcToolsCol dcToolsAdvancedGrid">
            <div className="dcToolsReadonly">
              <span className="dcToolsFieldLabel">Ring buffer</span>
              <span>{SERIES_BUFFER_CAPACITY} samples (fixed)</span>
            </div>
            <label className="dcToolsField dcToolsFieldSpan2">
              <span className="dcToolsFieldLabel">RMS equiv. ε</span>
              <input
                className="dcToolsInputMicro dcToolsInputSci"
                type="text"
                title="If RMS(raw−filtered) &lt; ε, treat as numerically identical"
                value={rmsEpsilonStr}
                onChange={(e) => setRmsEpsilonStr(e.target.value)}
              />
            </label>
            <label className="dcToolsField">
              <span className="dcToolsFieldLabel">Sig. figs.</span>
              <select
                className="dcToolsSelect dcToolsSelectSm"
                value={String(metricSigDigits)}
                onChange={(e) => setMetricSigDigits(Number(e.target.value))}
              >
                {[4, 5, 6, 7, 8, 9, 10].map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </select>
            </label>
            <p className="dcToolsMutedSm dcToolsFieldSpan2">
              Window: time filter is applied before tail cap. Filter chain runs on the windowed column only.
            </p>
          </div>
        ) : null}

        {toolsTab === "output" ? (
          <div className="dcToolsOutputWrap">
            {!analysisOutcome ? (
              <p className="dcAnalysisMuted">Run analysis or enable Auto — results land here.</p>
            ) : analysisOutcome.kind === "error" ? (
              <div className="dcAnalysisError dcAnalysisErrorInline">{analysisOutcome.message}</div>
            ) : (
              <>
                <div className="dcAnalysisMetaBar">
                  <span className="dcAnalysisMetaItem">
                    <strong>{analysisOutcome.toolTitle}</strong>
                  </span>
                  <span className="dcAnalysisMetaItem dcAnalysisMetaGrow" title={analysisOutcome.chainLine}>
                    {analysisOutcome.chainLine}
                  </span>
                  <span className="dcAnalysisMetaItem">
                    RMS(raw−filt):{" "}
                    {analysisOutcome.same
                      ? `<ε (${rmsEpsilonStr.trim() || "1e-15"})`
                      : Number.isFinite(analysisOutcome.rms)
                        ? analysisOutcome.rms.toPrecision(8)
                        : "—"}
                  </span>
                  <span className="dcAnalysisMetaItem">Overlay: {analysisOutcome.chartPreviewOn ? "on" : "off"}</span>
                </div>
                <div className="dcAnalysisMetaBar dcAnalysisMetaBarSub">
                  <span className="dcAnalysisMetaItem dcAnalysisMetaGrow">{analysisOutcome.windowDescription}</span>
                </div>
                <div className="dcAnalysisCompareGrid">
                  <AnalysisResultColumn title="Pre-filter" r={analysisOutcome.rBefore} sigDigits={metricSigDigits} />
                  <AnalysisResultColumn title="Post-filter" r={analysisOutcome.rAfter} sigDigits={metricSigDigits} />
                </div>
                <div className="dcAnalysisDelta">
                  <div className="dcAnalysisColHead">Δ table</div>
                  {(() => {
                    const rows = deltaRows(analysisOutcome.rBefore, analysisOutcome.rAfter, metricSigDigits);
                    const hasNumericDelta = rows.some((row) => row.delta !== "—");
                    if (rows.length === 0) {
                      return <p className="dcAnalysisMuted">No metrics to compare</p>;
                    }
                    return (
                      <div className="dcAnalysisTableWrap">
                        <table className="dcAnalysisTable">
                          <thead>
                            <tr>
                              <th>Key</th>
                              <th>Pre</th>
                              <th>Post</th>
                              <th>Δ (post−pre)</th>
                            </tr>
                          </thead>
                          <tbody>
                            {rows.map((row) => (
                              <tr key={row.key}>
                                <td>{row.key}</td>
                                <td>{row.before}</td>
                                <td>{row.after}</td>
                                <td className={row.delta !== "—" ? "dcAnalysisDeltaCell" : ""}>{row.delta}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                        {!hasNumericDelta ? <p className="dcAnalysisMuted dcAnalysisMutedBelow">Δ only for numeric keys with the same name.</p> : null}
                      </div>
                    );
                  })()}
                </div>
              </>
            )}
          </div>
        ) : null}
      </div>
    </div>
  );
}

export function buildDcToolsSnapshot(
  sourceId: string,
  serialPath: string | undefined,
  transport: string,
  chip: ChipId,
  ina3221UiMode: Ina3221UiMode | undefined,
  series: SeriesBundle,
  ina3221SeriesByCh: [SeriesBundle, SeriesBundle, SeriesBundle] | undefined
): DcToolsSourceSnapshot {
  const sourceLabel = transport === "Serial" ? serialPath ?? sourceId : sourceId;
  if (isMultiChannelChipId(chip) && (ina3221UiMode ?? "single") === "all") {
    return {
      sourceLabel,
      chip,
      ina3221Mode: "all",
      series,
      ina3221SeriesByCh: ina3221SeriesByCh ?? undefined
    };
  }
  return {
    sourceLabel,
    chip,
    ina3221Mode: isMultiChannelChipId(chip) ? "single" : "na",
    series
  };
}
