/**
 * Analysis windowing: crop finite (t,y) by recent duration (ms) then tail by max point count.
 */

export type AnalysisWindowOptions = {
  durationMs?: number;
  maxPoints?: number;
};

export type AnalysisWindowResult = {
  t: number[];
  y: number[];
  description: string;
};

export function applyAnalysisWindow(tIn: number[], yIn: number[], opts: AnalysisWindowOptions): AnalysisWindowResult {
  if (tIn.length !== yIn.length || tIn.length === 0) {
    return { t: [], y: [], description: "No finite samples" };
  }
  let t = tIn;
  let y = yIn;
  const note: string[] = [];

  const dur = opts.durationMs;
  if (typeof dur === "number" && dur > 0 && Number.isFinite(dur)) {
    const tEnd = t[t.length - 1]!;
    const tCut = tEnd - dur;
    const nt: number[] = [];
    const ny: number[] = [];
    for (let i = 0; i < t.length; i++) {
      if (t[i]! >= tCut) {
        nt.push(t[i]!);
        ny.push(y[i]!);
      }
    }
    t = nt;
    y = ny;
    if (t.length === 0) {
      return { t: [], y: [], description: `No samples in last ${dur} ms` };
    }
    note.push(`last ${dur} ms`);
  }

  const maxP = opts.maxPoints;
  if (typeof maxP === "number" && maxP > 0 && Number.isFinite(maxP) && t.length > maxP) {
    t = t.slice(-maxP);
    y = y.slice(-maxP);
    note.push(`tail ${maxP} pts`);
  }

  note.push(`n=${t.length}`);
  return { t, y, description: `Window: ${note.join(" · ")}` };
}
