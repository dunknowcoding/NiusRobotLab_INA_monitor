import type { ChipId } from "./model.js";

/**
 * Datasheet absolute maximum bus voltage (approx.); trip when exceeded.
 * Shunt and range are user-defined; this is chip voltage rating only.
 */
export function defaultAbsoluteMaxBusVoltage_V(chip: ChipId): number {
  switch (chip) {
    case "INA219":
    case "INA220":
    case "INA220-Q1":
    case "INA3221":
    case "INA3221-Q1":
      return 26;
    case "INA226":
    case "INA226-Q1":
    case "INA228":
    case "INA228-Q1":
    case "INA229":
    case "INA229-Q1":
    case "INA230":
    case "INA231":
    case "INA232":
    case "INA233":
    case "INA234":
    case "INA236":
    case "INA237":
    case "INA237-Q1":
    case "INA238":
    case "INA238-Q1":
    case "INA239":
    case "INA239-Q1":
      return 36;
    case "INA740X":
      return 48;
    default:
      return 36;
  }
}

/** Fraction above expected I_max treated as out of safe range (shunt-dependent, conservative default) */
export function defaultAbsoluteMaxCurrent_A(I_max_expected_A: number): number {
  const base = Math.max(I_max_expected_A, 0.001);
  return Math.max(base * 1.5, base + 0.001);
}

/** Fraction above nominal power treated as abnormal (user may override in UI) */
export function defaultAbsoluteMaxPower_W(V_nominal_V: number, I_max_expected_A: number): number {
  return Math.max(1.5 * V_nominal_V * I_max_expected_A, 0.01);
}
