/**
 * SerialTransport abstraction (P1): enumerate, open, line buffering, backpressure, reconnect.
 * Electron main uses `serialport` directly; this module is for tests and non-Electron hosts.
 */

export type SerialOpenOptions = {
  path: string;
  baudRate: number;
};

export interface SerialTransport {
  listPorts(): Promise<{ path: string; manufacturer?: string }[]>;
  open(opts: SerialOpenOptions): Promise<void>;
  close(): Promise<void>;
  write(data: string | Uint8Array): Promise<void>;
  /** Line or frame callback, fired after parsing in the implementation */
  onLine?(cb: (line: string) => void): void;
}
