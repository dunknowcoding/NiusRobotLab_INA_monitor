import assert from "node:assert/strict";
import test from "node:test";
import {
  ina219CalibrationRegister,
  ina219CurrentLsbFromImax,
  ina219PowerLsb,
  ina3221BusVoltage_V,
  ina3221ShuntVoltage_V
} from "./conversion.js";

test("INA219 current LSB from Imax", () => {
  const lsb = ina219CurrentLsbFromImax(3.2);
  assert.ok(lsb > 0 && lsb < 0.001);
});

test("INA219 cal register in range", () => {
  const cal = ina219CalibrationRegister({ current_LSB_A: ina219CurrentLsbFromImax(3.2), rShunt_ohm: 0.1 });
  assert.ok(cal >= 1 && cal <= 0xfffe);
});

test("INA219 power LSB = 20 * current LSB", () => {
  const cl = 0.0001;
  assert.equal(ina219PowerLsb(cl), 20 * cl);
});

test("INA3221 shunt 1 LSB = 40µV", () => {
  assert.equal(ina3221ShuntVoltage_V(1), 40e-6);
});

test("INA3221 bus raw 0 -> 0V", () => {
  assert.equal(ina3221BusVoltage_V(0), 0);
});
