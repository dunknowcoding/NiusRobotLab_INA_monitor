import type { ChipId } from "@niusrobotlab/ina-monitor-core";

/**
 * Chip pick list for the UI. Must stay aligned with `ChipId` in `@niusrobotlab/ina-monitor-core`.
 * When adding a model: update core `model.ts` first, then add the option here.
 */
export const CHIP_UI_GROUPS: { label: string; chips: readonly ChipId[] }[] = [
  {
    label: "Multi-channel",
    chips: ["INA3221", "INA3221-Q1"]
  },
  {
    label: "Single-channel — common",
    chips: ["INA219", "INA226", "INA228", "INA237", "INA238", "INA239", "INA740X"]
  },
  {
    label: "Single-channel — full list",
    chips: [
      "INA220",
      "INA220-Q1",
      "INA2227",
      "INA226-Q1",
      "INA228-Q1",
      "INA229",
      "INA229-Q1",
      "INA230",
      "INA231",
      "INA232",
      "INA233",
      "INA234",
      "INA236",
      "INA237-Q1",
      "INA238-Q1",
      "INA239-Q1",
      "INA4230",
      "INA4235"
    ]
  },
  {
    label: "Other",
    chips: ["UNKNOWN"]
  }
] as const;

export function chipOptionLabel(id: ChipId): string {
  if (id === "INA3221" || id === "INA3221-Q1") return `${id} (3ch)`;
  if (id === "UNKNOWN") return "UNKNOWN (placeholder)";
  return id;
}
