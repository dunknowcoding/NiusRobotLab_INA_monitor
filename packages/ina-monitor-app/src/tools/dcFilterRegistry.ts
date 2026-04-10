import type { DcFilterPlugin } from "../../tool/filterPluginSdk";

const modules = import.meta.glob("../../tool/filterPlugins/*/index.ts", { eager: true }) as Record<
  string,
  { plugin: DcFilterPlugin }
>;

function loadDcFilterPlugins(): DcFilterPlugin[] {
  const list: DcFilterPlugin[] = [];
  for (const m of Object.values(modules)) {
    if (m?.plugin?.manifest?.id) list.push(m.plugin);
  }
  return list.sort((a, b) => {
    const c = a.manifest.name.localeCompare(b.manifest.name, "zh-Hans-CN");
    if (c !== 0) return c;
    return a.manifest.id.localeCompare(b.manifest.id);
  });
}

export const DC_FILTER_PLUGINS: DcFilterPlugin[] = loadDcFilterPlugins();

export function filterPluginMap(plugins: DcFilterPlugin[]): Map<string, DcFilterPlugin> {
  return new Map(plugins.map((p) => [p.manifest.id, p]));
}
