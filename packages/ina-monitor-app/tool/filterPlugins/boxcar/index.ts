import type { DcFilterContext, DcFilterPlugin } from "../../filterPluginSdk";
import { boxcarMeanFast } from "../../filterPluginSdk";
import manifest from "./manifest.json";

const plugin: DcFilterPlugin = {
  manifest: manifest as DcFilterPlugin["manifest"],
  filter(ctx: DcFilterContext): number[] {
    const w = Math.max(1, Math.floor(ctx.options?.window ?? 5));
    return boxcarMeanFast(ctx.y, w);
  }
};

export { plugin };
