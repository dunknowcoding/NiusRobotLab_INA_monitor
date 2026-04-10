import type { ChipId } from "./model.js";

/** Chip capabilities (used with DataPipelineProfile to avoid ad-hoc UI/core branching) */
export type ChipCapabilities = {
  chipId: ChipId;
  channelModel: { kind: "single" } | { kind: "multi"; channelCount: number };
  /** Reportable signal keys (aligned with MeasurementFrame) */
  signals: {
    busVoltage: boolean;
    shuntVoltage: boolean;
    current: boolean;
    power: boolean;
    temperature: boolean;
    energyRegister?: boolean;
  };
  /** Whether the protocol should carry rawRegisters for PC-side recomputation */
  prefersRawRegisters: boolean;
};

/** Placeholder: filled per-chip by profiles */
export const CHIP_CAPABILITIES_PLACEHOLDER: Partial<Record<ChipId, ChipCapabilities>> = {
  INA219: {
    chipId: "INA219",
    channelModel: { kind: "single" },
    signals: {
      busVoltage: true,
      shuntVoltage: true,
      current: true,
      power: true,
      temperature: false
    },
    prefersRawRegisters: true
  },
  INA3221: {
    chipId: "INA3221",
    channelModel: { kind: "multi", channelCount: 3 },
    signals: {
      busVoltage: true,
      shuntVoltage: true,
      current: true,
      power: true,
      temperature: false
    },
    prefersRawRegisters: true
  },
  INA226: {
    chipId: "INA226",
    channelModel: { kind: "single" },
    signals: {
      busVoltage: true,
      shuntVoltage: true,
      current: true,
      power: true,
      temperature: false
    },
    prefersRawRegisters: true
  }
};
