/// <reference types="vite/client" />

type SerialPortInfo = {
  path: string;
  manufacturer?: string;
  serialNumber?: string;
  vendorId?: string;
  productId?: string;
};

type SerialSampleChannel = {
  bus_V?: number;
  current_A?: number;
  power_W?: number;
};

type SerialSamplePayload = {
  path: string;
  v?: number;
  chip?: string;
  addr?: string;
  seq?: number;
  t_ms?: number;
  bus_V?: number;
  shunt_uV?: number;
  current_A?: number;
  power_W?: number;
  channels?: SerialSampleChannel[];
  type?: string;
  msg?: string;
};

declare global {
  interface Window {
    /** Set by Electron preload only; undefined in a plain browser tab */
    __INA_MONITOR_SHELL__?: "electron";
    inaApi?: {
      listSerialPorts: () => Promise<SerialPortInfo[]>;
      serialOpen: (opts: { path: string; baudRate?: number }) => Promise<{ ok: true }>;
      serialClose: (path: string) => Promise<{ ok: true }>;
      serialWrite: (opts: { path: string; data: string }) => Promise<{ ok: true }>;
      subscribeSerialSample: (cb: (payload: SerialSamplePayload) => void) => () => void;
    };
  }
}

export {};
