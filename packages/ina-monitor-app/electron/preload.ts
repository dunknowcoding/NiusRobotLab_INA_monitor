/**
 * Must compile to CommonJS via tsconfig.electron-preload.json.
 * Electron loads preload with require() under the default sandbox; ESM top-level import can prevent
 * the script from running, leaving window.inaApi undefined (UI then says to use the Electron window).
 */
import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";

export type SerialPortInfo = {
  path: string;
  manufacturer?: string;
  serialNumber?: string;
  vendorId?: string;
  productId?: string;
};

/** One INA3221 channel object inside a single JSONL line */
export type SerialSampleChannel = {
  bus_V?: number;
  current_A?: number;
  power_W?: number;
};

/** One JSONL line from INA219 bridge + path from main process */
export type SerialSamplePayload = {
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
  /** INA3221: three channels; current/power per channel, optional bus per channel */
  channels?: SerialSampleChannel[];
  type?: string;
  msg?: string;
};

/** Renderer can branch on this; absent when opening localhost in a normal browser */
contextBridge.exposeInMainWorld("__INA_MONITOR_SHELL__", "electron" as const);

contextBridge.exposeInMainWorld("inaApi", {
  listSerialPorts: async (): Promise<SerialPortInfo[]> => {
    return await ipcRenderer.invoke("serial:listPorts");
  },
  serialOpen: async (opts: { path: string; baudRate?: number }): Promise<{ ok: true }> => {
    return await ipcRenderer.invoke("serial:open", opts);
  },
  serialClose: async (path: string): Promise<{ ok: true }> => {
    return await ipcRenderer.invoke("serial:close", path);
  },
  serialWrite: async (opts: { path: string; data: string }): Promise<{ ok: true }> => {
    return await ipcRenderer.invoke("serial:write", opts);
  },
  subscribeSerialSample: (cb: (payload: SerialSamplePayload) => void): (() => void) => {
    const handler = (_event: IpcRendererEvent, payload: SerialSamplePayload) => cb(payload);
    ipcRenderer.on("serial:sample", handler);
    return () => ipcRenderer.removeListener("serial:sample", handler);
  }
});
