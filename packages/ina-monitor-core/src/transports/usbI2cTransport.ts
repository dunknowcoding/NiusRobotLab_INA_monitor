/**
 * USB-to-I2C transport abstraction (P0: interface + mock; P2: concrete adapters).
 */

export type I2cXferResult = { ok: true; data: Uint8Array } | { ok: false; error: string };

export interface UsbI2cTransport {
  /** Open device (vid/pid or serial depends on implementation) */
  open(): Promise<void>;
  close(): Promise<void>;
  writeRead(addr7: number, writeBuf: Uint8Array, readLen: number): Promise<I2cXferResult>;
}

/** Placeholder when no hardware is present */
export class MockUsbI2cTransport implements UsbI2cTransport {
  async open(): Promise<void> {
    /* noop */
  }

  async close(): Promise<void> {
    /* noop */
  }

  async writeRead(_addr7: number, _writeBuf: Uint8Array, readLen: number): Promise<I2cXferResult> {
    return { ok: true, data: new Uint8Array(readLen) };
  }
}
