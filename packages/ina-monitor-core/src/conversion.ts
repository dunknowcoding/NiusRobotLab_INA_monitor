/**
 * Common scaling and calibration (INA219 family; see chip datasheet for specifics).
 */

/** INA219: typical Calibration register form */
export function ina219CalibrationRegister(args: {
  current_LSB_A: number;
  rShunt_ohm: number;
}): number {
  const cal = Math.floor(0.04096 / (args.current_LSB_A * args.rShunt_ohm));
  return Math.min(0xfffe, Math.max(1, cal));
}

/** Derive Current_LSB (A/LSB) from expected maximum current */
export function ina219CurrentLsbFromImax(imax_A: number): number {
  return imax_A / 32768;
}

/** Power register LSB vs Current_LSB (INA219 datasheet: 20×) */
export function ina219PowerLsb(currentLsb_A: number): number {
  return 20 * currentLsb_A;
}

/** INA3221: shunt voltage register LSB = 40 µV (default PGA) */
export function ina3221ShuntVoltage_V(rawS16: number): number {
  return rawS16 * 40e-6;
}

/** INA3221: bus voltage register (13 valid bits after >>3, LSB = 8 mV) */
export function ina3221BusVoltage_V(rawU16: number): number {
  const v = (rawU16 >> 3) & 0x1fff;
  return v * 8e-3;
}
