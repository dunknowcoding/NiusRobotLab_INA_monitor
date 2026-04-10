import assert from "node:assert/strict";
import test from "node:test";
import { createFaultDetector, defaultProtectionConfig } from "./faults.js";
import type { MeasurementFrame } from "./model.js";

test("detector: undervoltage soft after sustained low V", () => {
  const cfg = defaultProtectionConfig({ sampleRate_Hz: 10, I_max_expected_A: 1, V_nominal_V: 5 });
  const d = createFaultDetector(cfg);
  const frame = (v: number): MeasurementFrame => ({
    version: 1,
    chip: "INA219",
    seq: 0,
    t_host_ms: 0,
    channelModel: { kind: "single" },
    signals: { busVoltage_V: v, current_A: 0, power_W: 0 }
  });
  for (let i = 0; i < 4; i++) assert.equal(d.evalFrame(frame(4)).soft.voltage, undefined);
  const r = d.evalFrame(frame(4));
  assert.equal(r.soft.voltage, "under");
  assert.equal(r.fault, undefined);
});

test("detector: near-zero bus does not trigger undervoltage soft", () => {
  const cfg = defaultProtectionConfig({ sampleRate_Hz: 10, I_max_expected_A: 1, V_nominal_V: 3.3 });
  const d = createFaultDetector(cfg);
  const frame = (v: number): MeasurementFrame => ({
    version: 1,
    chip: "INA3221",
    seq: 0,
    t_host_ms: 0,
    channelModel: { kind: "multi", channelCount: 3 },
    shared: { busVoltage_V: v },
    channels: [{ current_A: 0, power_W: 0 }, { current_A: 0, power_W: 0 }, { current_A: 0, power_W: 0 }]
  });
  for (let i = 0; i < 30; i++) {
    const r = d.evalFrame(frame(0.02));
    assert.equal(r.soft.voltage, undefined);
    assert.equal(r.fault, undefined);
  }
});

test("detector disabled yields no decision", () => {
  const cfg = { ...defaultProtectionConfig({ I_max_expected_A: 1, V_nominal_V: 5 }), enabled: false };
  const d = createFaultDetector(cfg);
  const f: MeasurementFrame = {
    version: 1,
    chip: "INA219",
    seq: 0,
    t_host_ms: 0,
    channelModel: { kind: "single" },
    signals: { busVoltage_V: 100, current_A: 100, power_W: 100 }
  };
  const r = d.evalFrame(f);
  assert.equal(r.fault, undefined);
  assert.deepEqual(r.soft, {});
});

test("detector: absolute overcurrent fault", () => {
  const cfg = defaultProtectionConfig({ I_max_expected_A: 1, V_nominal_V: 5, chip: "INA219" });
  const d = createFaultDetector(cfg);
  const f: MeasurementFrame = {
    version: 1,
    chip: "INA219",
    seq: 0,
    t_host_ms: 0,
    channelModel: { kind: "single" },
    signals: { busVoltage_V: 5, current_A: 10, power_W: 50 }
  };
  const r1 = d.evalFrame(f);
  assert.equal(r1.fault?.faultCode, undefined);
  const r2 = d.evalFrame({ ...f, seq: 1 });
  assert.equal(r2.fault?.faultCode, "ABSOLUTE_OVERCURRENT");
});
