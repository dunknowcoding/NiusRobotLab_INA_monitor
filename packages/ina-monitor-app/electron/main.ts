import { app, BrowserWindow, ipcMain } from "electron";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { SerialPort } from "serialport";
import fs from "node:fs";

/** Next to compiled main.js so monorepo app.getAppPath() does not point at repo root for preload */
const ELECTRON_DIR = path.dirname(fileURLToPath(import.meta.url));
const PRELOAD_PATH = path.join(ELECTRON_DIR, "preload.js");

if (!fs.existsSync(PRELOAD_PATH)) {
  console.error("[ina-monitor] Preload script missing:", PRELOAD_PATH);
} else {
  console.log("[ina-monitor] Preload:", PRELOAD_PATH);
}

const isDev = process.env.NODE_ENV !== "production";

/** Windows: normalize to COMx and strip \\.\ prefix so renderer paths match sample payloads */
function canonicalSerialPath(p: string): string {
  let s = p.trim();
  if (process.platform === "win32") {
    const low = s.toLowerCase();
    if (low.startsWith("\\\\.\\") || low.startsWith("//./")) {
      s = s.slice(4);
    }
    if (/^com\d+$/i.test(s)) {
      return s.toUpperCase();
    }
  }
  return s;
}

/** Open serial ports by path (e.g. COM6). Line-buffered JSONL from INA219 bridge. */
const openSerialPorts = new Map<string, SerialPort>();
const lineBuffers = new Map<string, string>();

function broadcastSerialSample(portPath: string, payload: Record<string, unknown>) {
  const data = { path: portPath, ...payload };
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send("serial:sample", data);
  }
}

async function closeSerialPort(portPath: string): Promise<void> {
  const port = openSerialPorts.get(portPath);
  if (!port) return;
  await new Promise<void>((resolve, reject) => {
    port.close((err) => (err ? reject(err) : resolve()));
  });
  openSerialPorts.delete(portPath);
  lineBuffers.delete(portPath);
}

/** Default 16:9 (1600×900); min 1280×720 so three-column layout stays usable */
const WIN_W = 1600;
const WIN_H = 900;

function createWindow() {
  const win = new BrowserWindow({
    width: WIN_W,
    height: WIN_H,
    minWidth: 1280,
    minHeight: 720,
    title: "INA Monitor Tool — NiusRobotLab",
    webPreferences: {
      // P0: keep it simple; preload can be added when serial bridge is introduced.
      nodeIntegration: false,
      contextIsolation: true,
      preload: PRELOAD_PATH
    }
  });

  win.center();

  if (isDev) {
    win.loadURL("http://localhost:5173");
    win.webContents.openDevTools({ mode: "detach" });
  } else {
    const indexPath = path.join(ELECTRON_DIR, "..", "dist-renderer", "index.html");
    win.loadURL(pathToFileURL(indexPath).toString());
  }
}

app.whenReady().then(() => {
  ipcMain.handle("serial:listPorts", async () => {
    const ports = await SerialPort.list();
    return ports.map((p) => ({
      path: p.path,
      manufacturer: p.manufacturer,
      serialNumber: p.serialNumber,
      vendorId: p.vendorId,
      productId: p.productId
    }));
  });

  ipcMain.handle("serial:open", async (_evt, opts: { path: string; baudRate?: number }) => {
    const baudRate = opts.baudRate ?? 115200;
    const portPath = canonicalSerialPath(opts.path);
    if (!portPath) throw new Error("serial:open requires path");

    await closeSerialPort(portPath);

    const port = new SerialPort({ path: portPath, baudRate, autoOpen: false });
    await new Promise<void>((resolve, reject) => {
      port.open((err) => (err ? reject(err) : resolve()));
    });

    lineBuffers.set(portPath, "");
    port.on("data", (chunk: Buffer) => {
      let buf = lineBuffers.get(portPath) ?? "";
      buf += chunk.toString("utf8");
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        try {
          const obj = JSON.parse(line) as Record<string, unknown>;
          // Forward all protocol lines (v===1). Renderer filters INFO / measurements / ERR; ACK/PONG are ignored there.
          if (obj.v === 1) {
            broadcastSerialSample(portPath, obj);
          }
        } catch {
          // ignore non-JSON lines
        }
      }
      lineBuffers.set(portPath, buf);
    });

    port.on("error", (err) => {
      console.error("[serial]", portPath, err);
    });

    openSerialPorts.set(portPath, port);
    return { ok: true as const };
  });

  ipcMain.handle("serial:close", async (_evt, portPath: string) => {
    await closeSerialPort(canonicalSerialPath(portPath));
    return { ok: true as const };
  });

  ipcMain.handle("serial:write", async (_evt, opts: { path: string; data: string }) => {
    const port = openSerialPorts.get(canonicalSerialPath(opts.path));
    if (!port) throw new Error(`Port not open: ${opts.path}`);
    await new Promise<void>((resolve, reject) => {
      port.write(opts.data, (err) => (err ? reject(err) : resolve()));
    });
    await new Promise<void>((resolve, reject) => {
      port.drain((err) => (err ? reject(err) : resolve()));
    });
    return { ok: true as const };
  });

  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

