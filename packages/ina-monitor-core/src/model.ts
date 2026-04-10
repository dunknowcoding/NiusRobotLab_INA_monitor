export type ChipId =
  | "INA219"
  | "INA220"
  | "INA220-Q1"
  | "INA2227"
  | "INA226"
  | "INA226-Q1"
  | "INA228"
  | "INA228-Q1"
  | "INA229"
  | "INA229-Q1"
  | "INA230"
  | "INA231"
  | "INA232"
  | "INA233"
  | "INA234"
  | "INA236"
  | "INA237"
  | "INA237-Q1"
  | "INA238"
  | "INA238-Q1"
  | "INA239"
  | "INA239-Q1"
  | "INA3221"
  | "INA3221-Q1"
  | "INA4230"
  | "INA4235"
  | "INA740X"
  | "UNKNOWN";

export type ChannelModel =
  | { kind: "single" }
  | { kind: "multi"; channelCount: number };

export type SignalKey =
  | "busVoltage_V"
  | "shuntVoltage_V"
  | "current_A"
  | "power_W"
  | "temperature_C";

export type ChannelSignals = Partial<Record<SignalKey, number>>;

export type MeasurementFrameBase = {
  version: 1;
  chip: ChipId;
  seq: number;
  t_mcu_ms?: number;
  t_host_ms: number;
  alerts?: string[];
  rawRegisters?: Record<string, number>;
};

export type MeasurementFrameSingle = MeasurementFrameBase & {
  channelModel: { kind: "single" };
  signals: ChannelSignals;
};

export type MeasurementFrameMulti = MeasurementFrameBase & {
  channelModel: { kind: "multi"; channelCount: number };
  shared?: ChannelSignals;
  channels: ChannelSignals[];
};

export type MeasurementFrame = MeasurementFrameSingle | MeasurementFrameMulti;

export type FaultCode =
  | "LINK_TIMEOUT"
  | "CRC_ERROR"
  | "DROP_RATE_HIGH"
  | "OVERCURRENT"
  | "SHORT_CIRCUIT"
  | "OVERVOLTAGE"
  | "UNDERVOLTAGE"
  | "ABSOLUTE_BUS_OVERVOLTAGE"
  | "ABSOLUTE_OVERCURRENT"
  | "ABSOLUTE_OVERPOWER"
  | "INVALID_CONFIG"
  | "MEASUREMENT_INVALID";

export type Severity = "info" | "warn" | "fault";

export type DetectionConfidence = "strong" | "medium" | "weak" | "unknown";

export type ChipDetectionResult = {
  detectedChip: ChipId;
  confidence: DetectionConfidence;
  details?: string;
  // raw evidence (e.g., deviceId/manufacturerId registers) for audit
  evidence?: Record<string, number | string>;
};

export type FaultEvent = {
  eventId: string;
  timestamp_ms: number;
  chip: ChipId;
  faultCode: FaultCode;
  severity: Severity;
  stateBefore: string;
  stateAfter: string;
  actionsTaken: string[];
  triggerRule?: Record<string, unknown>;
  frameRange?: { startSeq: number; endSeq: number };
  lastFrames?: MeasurementFrame[];
};

export type InfoEvent = {
  eventId: string;
  timestamp_ms: number;
  chip?: ChipId;
  type: "CHIP_MISMATCH" | "LINK_RECONNECTED" | "CONFIG_APPLIED" | "NOTE";
  message: string;
  payload?: Record<string, unknown>;
};

