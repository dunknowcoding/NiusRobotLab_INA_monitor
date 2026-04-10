import type { DcFilterContext, DcFilterPlugin } from "../../filterPluginSdk";
import { slewLimitFast } from "../../filterPluginSdk";
import manifest from "./manifest.json";

const plugin: DcFilterPlugin = {
  manifest: manifest as DcFilterPlugin["manifest"],
  filter(ctx: DcFilterContext): number[] {
    const step = ctx.options?.maxStep ?? 0;
    if (!(typeof step === "number") || step <= 0 || !Number.isFinite(step)) {
      return ctx.y.slice();
    }
    return slewLimitFast(ctx.y, step);
  }
};

export { plugin };
