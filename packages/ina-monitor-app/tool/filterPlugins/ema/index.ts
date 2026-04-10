import type { DcFilterContext, DcFilterPlugin } from "../../filterPluginSdk";
import { alphaFromSpan, emaFast } from "../../filterPluginSdk";
import manifest from "./manifest.json";

const plugin: DcFilterPlugin = {
  manifest: manifest as DcFilterPlugin["manifest"],
  filter(ctx: DcFilterContext): number[] {
    const aOpt = ctx.options?.alpha;
    if (typeof aOpt === "number" && aOpt > 0 && aOpt <= 1) return emaFast(ctx.y, aOpt);
    const span = Math.max(1, Math.floor(ctx.options?.window ?? 8));
    return emaFast(ctx.y, alphaFromSpan(span));
  }
};

export { plugin };
