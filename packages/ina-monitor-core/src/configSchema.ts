/**
 * Basic/Advanced config schema placeholder (P1): align with firmware register writes, validation, and UI forms.
 */

export type ConfigFieldType = "number" | "enum" | "boolean";

export type ConfigField = {
  key: string;
  label: string;
  type: ConfigFieldType;
  min?: number;
  max?: number;
  step?: number;
  enumValues?: string[];
};

export type ConfigSchema = {
  chipFamily: string;
  fields: ConfigField[];
};
