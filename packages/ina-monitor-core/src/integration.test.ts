import assert from "node:assert/strict";
import test from "node:test";
import { createMonitorEngine } from "./stateMachine.js";
import { defaultProtectionConfig } from "./faults.js";
import type { MeasurementFrame } from "./model.js";

test("engine: connect start frame short-circuit path", () => {
  const eng = createMonitorEngine({
    protection: defaultProtectionConfig({ I_max_expected_A: 1, V_nominal_V: 5 }),
    frameBufferSize: 16,
    taskQueueCapacity: 64
  });
  eng.enqueueControl({ kind: "CONNECT" });
  eng.enqueueControl({ kind: "START" });
  eng.stepUntilIdle(100);
  const f: MeasurementFrame = {
    version: 1,
    chip: "INA219",
    seq: 1,
    t_host_ms: 1,
    channelModel: { kind: "single" },
    signals: { busVoltage_V: 5, current_A: 10, power_W: 50 }
  };
  eng.enqueueFrame(f);
  eng.enqueueFrame({ ...f, seq: 2 });
  eng.stepUntilIdle(5000);
  const snap = eng.snapshot();
  assert.equal(snap.state.name, "FaultLatched");
});
