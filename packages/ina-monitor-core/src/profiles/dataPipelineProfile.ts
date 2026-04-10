import type { ChipId } from "../model.js";
import type { SignalKey } from "../model.js";

/**
 * Data pipeline profile: export fields, default plots, protection scope (keeps logic centralized).
 * From P1 onward ties to UI/protocol decoders; currently a type skeleton.
 */
export type ProtectionScope =
  | { kind: "aggregate"; metric: "maxAbsCurrent" | "sumPower" }
  | { kind: "perChannel"; channelIndex: number };

export type DataPipelineProfile = {
  chipId: ChipId;
  /** Default signals shown in Basic/Advanced for this chip */
  defaultSignals: SignalKey[];
  /** Per-channel export column prefix, e.g. ch1_ */
  exportColumnPrefix?: (ch: number) => string;
  /** Default scope for short/over-current protection */
  defaultCurrentProtectionScope: ProtectionScope;
};

export function defaultProfileForChip(chipId: ChipId): DataPipelineProfile | undefined {
  if (chipId === "INA3221" || chipId === "INA3221-Q1") {
    return {
      chipId,
      defaultSignals: ["busVoltage_V", "current_A", "power_W"],
      exportColumnPrefix: (ch) => `ch${ch + 1}_`,
      defaultCurrentProtectionScope: { kind: "aggregate", metric: "maxAbsCurrent" }
    };
  }
  return {
    chipId,
    defaultSignals: ["busVoltage_V", "shuntVoltage_V", "current_A", "power_W"],
    defaultCurrentProtectionScope: { kind: "aggregate", metric: "maxAbsCurrent" }
  };
}
