import type { DcAnalysisPlugin } from "../../tool/pluginSdk";

const modules = import.meta.glob("../../tool/plugins/*/index.ts", { eager: true }) as Record<
  string,
  { plugin: DcAnalysisPlugin }
>;

function loadDcPlugins(): DcAnalysisPlugin[] {
  const list: DcAnalysisPlugin[] = [];
  for (const m of Object.values(modules)) {
    if (m?.plugin?.manifest?.id) list.push(m.plugin);
  }
  return list.sort((a, b) => {
    const c = a.manifest.name.localeCompare(b.manifest.name, "en");
    if (c !== 0) return c;
    return a.manifest.id.localeCompare(b.manifest.id);
  });
}

/** Eager scan of tool/plugins at UI bundle load */
export const DC_ANALYSIS_PLUGINS: DcAnalysisPlugin[] = loadDcPlugins();
