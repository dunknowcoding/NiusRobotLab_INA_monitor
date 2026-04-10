import type { DcFilterContext, DcFilterPlugin } from "../../filterPluginSdk";
import { medianFilterFast } from "../../filterPluginSdk";
import manifest from "./manifest.json";

const plugin: DcFilterPlugin = {
  manifest: manifest as DcFilterPlugin["manifest"],
  filter(ctx: DcFilterContext): number[] {
    const w = Math.max(3, Math.floor(ctx.options?.window ?? 5));
    return medianFilterFast(ctx.y, w % 2 === 0 ? w + 1 : w);
  }
};

export { plugin };
