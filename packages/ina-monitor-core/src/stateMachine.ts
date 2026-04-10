import { PriorityQueue } from "./priorityQueue.js";
import type { FaultEvent, MeasurementFrame } from "./model.js";
import { createFaultDetector, type ProtectionConfig, type SoftAlarms } from "./faults.js";

export type MonitorState =
  | { name: "Disconnected" }
  | { name: "ConnectedIdle" }
  | { name: "Monitoring" }
  | { name: "FaultLatched"; fault: FaultEvent };

export type ControlCommand =
  | { kind: "CONNECT" }
  | { kind: "DISCONNECT" }
  | { kind: "START" }
  | { kind: "STOP" }
  | { kind: "RESET_FAULT" };

export type RouterTask =
  | { kind: "CONTROL"; cmd: ControlCommand }
  | { kind: "FRAME"; frame: MeasurementFrame }
  | { kind: "TICK"; t_ms: number };

export type MonitorOutputs = {
  state: MonitorState;
  faults: FaultEvent[];
  /** Soft alarms: UI only, data stream continues */
  softAlarms: SoftAlarms;
  lastFrames: MeasurementFrame[];
  droppedTasks: number;
};

export type MonitorEngine = {
  enqueueControl: (cmd: ControlCommand) => void;
  enqueueFrame: (frame: MeasurementFrame) => void;
  tick: (t_ms?: number) => void;
  stepUntilIdle: (budget?: number) => void;
  snapshot: () => MonitorOutputs;
};

export function createMonitorEngine(opts: {
  protection: ProtectionConfig;
  frameBufferSize: number;
  taskQueueCapacity: number;
}): MonitorEngine {
  let state: MonitorState = { name: "Disconnected" };
  const faults: FaultEvent[] = [];
  let softAlarms: SoftAlarms = {};
  const lastFrames: MeasurementFrame[] = [];
  let droppedTasks = 0;

  const q = new PriorityQueue<RouterTask>({ capacity: opts.taskQueueCapacity });
  const detector = createFaultDetector(opts.protection);

  const pushFrame = (f: MeasurementFrame) => {
    lastFrames.push(f);
    while (lastFrames.length > opts.frameBufferSize) lastFrames.shift();
  };

  const enqueue = (prio: 0 | 1 | 2, task: RouterTask) => {
    const res = q.enqueue(prio, task);
    if (!res.accepted) droppedTasks++;
  };

  const enqueueControl = (cmd: ControlCommand) => {
    enqueue(0, { kind: "CONTROL", cmd });
  };

  const enqueueFrame = (frame: MeasurementFrame) => {
    enqueue(1, { kind: "FRAME", frame });
  };

  const tick = (t_ms = Date.now()) => {
    enqueue(2, { kind: "TICK", t_ms });
  };

  const handleControl = (cmd: ControlCommand) => {
    if (cmd.kind === "CONNECT") {
      if (state.name === "Disconnected") state = { name: "ConnectedIdle" };
      return;
    }
    if (cmd.kind === "DISCONNECT") {
      state = { name: "Disconnected" };
      return;
    }
    if (cmd.kind === "START") {
      if (state.name === "ConnectedIdle") state = { name: "Monitoring" };
      return;
    }
    if (cmd.kind === "STOP") {
      if (state.name === "Monitoring") state = { name: "ConnectedIdle" };
      return;
    }
    if (cmd.kind === "RESET_FAULT") {
      if (state.name === "FaultLatched") state = { name: "ConnectedIdle" };
      return;
    }
  };

  const handleFrame = (frame: MeasurementFrame) => {
    pushFrame(frame);

    if (state.name !== "Monitoring") return;

    const { fault, soft } = detector.evalFrame(frame);
    softAlarms = soft;

    if (!fault) return;

    const before = state.name;
    const actionsTaken: string[] = ["STOP", "DISCONNECT"];
    state = {
      name: "FaultLatched",
      fault: detector.toFaultEvent({
        decision: fault,
        frame,
        stateBefore: before,
        stateAfter: "FaultLatched",
        actionsTaken,
        lastFrames: [...lastFrames]
      })
    };
    faults.push(state.fault);
  };

  const stepOnce = () => {
    const item = q.dequeue();
    if (!item) return false;
    const task = item.value;
    if (task.kind === "CONTROL") handleControl(task.cmd);
    else if (task.kind === "FRAME") handleFrame(task.frame);
    else {
      void task;
    }
    return true;
  };

  const stepUntilIdle = (budget = 10_000) => {
    let n = 0;
    while (n < budget && stepOnce()) n++;
  };

  const snapshot = (): MonitorOutputs => ({
    state,
    faults: [...faults],
    softAlarms: { ...softAlarms },
    lastFrames: [...lastFrames],
    droppedTasks
  });

  return { enqueueControl, enqueueFrame, tick, stepUntilIdle, snapshot };
}
