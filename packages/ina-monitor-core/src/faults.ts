import type { ChipId } from "./model.js";
import type { FaultCode, FaultEvent, MeasurementFrame, Severity } from "./model.js";
import { defaultAbsoluteMaxBusVoltage_V, defaultAbsoluteMaxCurrent_A, defaultAbsoluteMaxPower_W } from "./chipRatings.js";

export type LimitMode = "auto" | "manual";

export type ProtectionConfig = {
  enabled: boolean;
  sampleRate_Hz: number;
  /** Soft alarm: consecutive samples for over-current before asserting */
  holdSamples_over: number;
  /** Soft alarm: consecutive samples for over/under-voltage before asserting */
  holdSamples_uv_ov: number;
  /** Soft alarm: consecutive samples for over-power before asserting */
  holdSamples_power: number;
  /** Absolute trip: consecutive hits before fault (spike rejection) */
  holdSamples_absolute: number;

  I_max_expected_A: number;
  V_nominal_V: number;

  alarmVoltageEnabled: boolean;
  alarmCurrentEnabled: boolean;
  alarmPowerEnabled: boolean;

  voltageLimitMode: LimitMode;
  currentLimitMode: LimitMode;
  powerLimitMode: LimitMode;

  /** Thresholds in manual mode; in auto mode defaults come from defaultProtectionConfig but auto formulas apply */
  V_over_V: number;
  V_under_V: number;
  I_over_A: number;
  P_over_W: number;

  /** Above chip/range safety: must trip (UI default, editable) */
  absoluteMaxBusVoltage_V: number;
  absoluteMaxCurrent_A: number;
  absoluteMaxPower_W: number;

  /**
   * Bus voltages below this are treated as invalid/unwired (e.g. I2C only, BUS floating); excluded from over/under/absolute bus logic.
   */
  minValidBusVoltage_V: number;
};

export type SoftAlarms = {
  voltage?: "over" | "under";
  current?: "over";
  power?: "over";
};

export type FrameEvalResult = {
  fault?: FaultDecision;
  soft: SoftAlarms;
};

export function defaultProtectionConfig(input: {
  sampleRate_Hz?: number;
  I_max_expected_A: number;
  V_nominal_V: number;
  chip?: ChipId;
}): ProtectionConfig {
  const sr = input.sampleRate_Hz ?? 10;
  const chip = input.chip ?? "UNKNOWN";
  const busMax = defaultAbsoluteMaxBusVoltage_V(chip);
  const Iabs = defaultAbsoluteMaxCurrent_A(input.I_max_expected_A);
  const Pabs = defaultAbsoluteMaxPower_W(input.V_nominal_V, input.I_max_expected_A);
  const V_over = 1.1 * input.V_nominal_V;
  const V_under = 0.9 * input.V_nominal_V;
  const I_over = 1.2 * input.I_max_expected_A;
  const P_over = 1.1 * input.V_nominal_V * input.I_max_expected_A;

  return {
    enabled: true,
    sampleRate_Hz: sr,
    holdSamples_over: 10,
    holdSamples_uv_ov: 5,
    holdSamples_power: 10,
    holdSamples_absolute: 2,
    I_max_expected_A: input.I_max_expected_A,
    V_nominal_V: input.V_nominal_V,
    alarmVoltageEnabled: true,
    alarmCurrentEnabled: true,
    alarmPowerEnabled: false,
    voltageLimitMode: "auto",
    currentLimitMode: "auto",
    powerLimitMode: "auto",
    V_over_V: V_over,
    V_under_V: V_under,
    I_over_A: I_over,
    P_over_W: P_over,
    absoluteMaxBusVoltage_V: busMax,
    absoluteMaxCurrent_A: Iabs,
    absoluteMaxPower_W: Pabs,
    minValidBusVoltage_V: 0.25
  };
}

export type FaultDecision = {
  faultCode: FaultCode;
  severity: Severity;
  reason: string;
  triggerRule: Record<string, unknown>;
};

type CounterState = {
  overI: number;
  overV: number;
  underV: number;
  overP: number;
  absV: number;
  absI: number;
  absP: number;
};

export function effectiveVoltageThresholds(cfg: ProtectionConfig): { over: number; under: number } {
  if (cfg.voltageLimitMode === "auto") {
    return { over: 1.1 * cfg.V_nominal_V, under: 0.9 * cfg.V_nominal_V };
  }
  return { over: cfg.V_over_V, under: cfg.V_under_V };
}

export function effectiveCurrentOver_A(cfg: ProtectionConfig): number {
  if (cfg.currentLimitMode === "auto") return 1.2 * cfg.I_max_expected_A;
  return cfg.I_over_A;
}

export function effectivePowerOver_W(cfg: ProtectionConfig): number {
  if (cfg.powerLimitMode === "auto") return 1.1 * cfg.V_nominal_V * cfg.I_max_expected_A;
  return cfg.P_over_W;
}

function effVoltage(cfg: ProtectionConfig): { over: number; under: number } {
  return effectiveVoltageThresholds(cfg);
}

function effCurrentOver(cfg: ProtectionConfig): number {
  return effectiveCurrentOver_A(cfg);
}

function effPowerOver(cfg: ProtectionConfig): number {
  return effectivePowerOver_W(cfg);
}

export function createFaultDetector(cfg: ProtectionConfig) {
  const c: CounterState = { overI: 0, overV: 0, underV: 0, overP: 0, absV: 0, absI: 0, absP: 0 };

  const pick = (frame: MeasurementFrame, k: "current_A" | "busVoltage_V" | "power_W"): number | undefined => {
    if ("signals" in frame) return frame.signals[k];
    if (k === "current_A") {
      let best: number | undefined;
      for (const ch of frame.channels) {
        const v = ch.current_A;
        if (typeof v !== "number") continue;
        if (best === undefined || Math.abs(v) > Math.abs(best)) best = v;
      }
      return best;
    }
    if (k === "power_W") {
      let best: number | undefined;
      for (const ch of frame.channels) {
        const v = ch.power_W;
        if (typeof v !== "number") continue;
        if (best === undefined || Math.abs(v) > Math.abs(best)) best = v;
      }
      return best;
    }
    const shared = frame.shared?.busVoltage_V;
    if (typeof shared === "number") return shared;
    let best: number | undefined;
    for (const ch of frame.channels) {
      const v = ch.busVoltage_V;
      if (typeof v !== "number") continue;
      if (best === undefined || v > best) best = v;
    }
    return best;
  };

  function evalFrame(frame: MeasurementFrame): FrameEvalResult {
    const empty: SoftAlarms = {};
    if (!cfg.enabled) {
      return { soft: empty };
    }

    const I = pick(frame, "current_A");
    const V = pick(frame, "busVoltage_V");
    const P = pick(frame, "power_W");

    const busOk = typeof V === "number" && Number.isFinite(V) && V >= cfg.minValidBusVoltage_V;

    // --- Absolute limits (fault, must disconnect) ---
    if (busOk && typeof V === "number" && V >= cfg.absoluteMaxBusVoltage_V) c.absV++;
    else c.absV = 0;

    if (typeof I === "number" && Math.abs(I) >= cfg.absoluteMaxCurrent_A) c.absI++;
    else c.absI = 0;

    if (typeof P === "number" && Number.isFinite(P) && P >= cfg.absoluteMaxPower_W) c.absP++;
    else c.absP = 0;

    const hsA = cfg.holdSamples_absolute;
    if (c.absV >= hsA) {
      return {
        fault: {
          faultCode: "ABSOLUTE_BUS_OVERVOLTAGE",
          severity: "fault",
          reason: `V>=absoluteMaxBus for ${c.absV} samples`,
          triggerRule: { absoluteMaxBusVoltage_V: cfg.absoluteMaxBusVoltage_V, holdSamples_absolute: hsA }
        },
        soft: empty
      };
    }
    if (c.absI >= hsA) {
      return {
        fault: {
          faultCode: "ABSOLUTE_OVERCURRENT",
          severity: "fault",
          reason: `|I|>=absoluteMaxCurrent for ${c.absI} samples`,
          triggerRule: { absoluteMaxCurrent_A: cfg.absoluteMaxCurrent_A, holdSamples_absolute: hsA }
        },
        soft: empty
      };
    }
    if (c.absP >= hsA) {
      return {
        fault: {
          faultCode: "ABSOLUTE_OVERPOWER",
          severity: "fault",
          reason: `P>=absoluteMaxPower for ${c.absP} samples`,
          triggerRule: { absoluteMaxPower_W: cfg.absoluteMaxPower_W, holdSamples_absolute: hsA }
        },
        soft: empty
      };
    }

    // --- Soft alarms (UI indication only) ---
    const soft: SoftAlarms = {};
    const vEff = effVoltage(cfg);
    const iOver = effCurrentOver(cfg);
    const pOver = effPowerOver(cfg);

    if (cfg.alarmVoltageEnabled && busOk && typeof V === "number") {
      if (V >= vEff.over) c.overV++;
      else c.overV = 0;
      if (V <= vEff.under) c.underV++;
      else c.underV = 0;
      if (c.overV >= cfg.holdSamples_uv_ov) soft.voltage = "over";
      if (c.underV >= cfg.holdSamples_uv_ov) soft.voltage = "under";
    } else {
      c.overV = 0;
      c.underV = 0;
    }

    if (cfg.alarmCurrentEnabled && typeof I === "number") {
      if (Math.abs(I) >= iOver) c.overI++;
      else c.overI = 0;
      if (c.overI >= cfg.holdSamples_over) soft.current = "over";
    } else {
      c.overI = 0;
    }

    if (cfg.alarmPowerEnabled && typeof P === "number" && Number.isFinite(P)) {
      if (P >= pOver) c.overP++;
      else c.overP = 0;
      if (c.overP >= cfg.holdSamples_power) soft.power = "over";
    } else {
      c.overP = 0;
    }

    return { soft };
  }

  function toFaultEvent(input: {
    decision: FaultDecision;
    frame: MeasurementFrame;
    stateBefore: string;
    stateAfter: string;
    actionsTaken: string[];
    lastFrames?: MeasurementFrame[];
  }): FaultEvent {
    const eventId = `${input.frame.t_host_ms}-${input.frame.seq}-${input.decision.faultCode}`;
    return {
      eventId,
      timestamp_ms: input.frame.t_host_ms,
      chip: input.frame.chip,
      faultCode: input.decision.faultCode,
      severity: input.decision.severity,
      stateBefore: input.stateBefore,
      stateAfter: input.stateAfter,
      actionsTaken: input.actionsTaken,
      triggerRule: input.decision.triggerRule,
      frameRange: input.lastFrames?.length
        ? { startSeq: input.lastFrames[0]!.seq, endSeq: input.lastFrames[input.lastFrames.length - 1]!.seq }
        : { startSeq: input.frame.seq, endSeq: input.frame.seq },
      lastFrames: input.lastFrames
    };
  }

  return { evalFrame, toFaultEvent };
}
