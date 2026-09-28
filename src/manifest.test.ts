import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { CUSTOM_PROVIDER_ID, PROVIDER_PRESETS, REASONING_EFFORTS } from "./core/providers.ts";
import { targetLanguageEnum } from "./core/target-language.ts";

// Vitest runs from the repo root.
const manifest = JSON.parse(readFileSync("package.json", "utf8"));

it("has the Target language enum from the table (run `pnpm sync:languages`)", () => {
  const setting = manifest.contributes.configuration.properties["markdownTwain.targetLanguage"];
  const { enum: values, enumItemLabels } = setting;
  expect({ enum: values, enumItemLabels }).toEqual(targetLanguageEnum());
});

it("makes the Target language an application setting that defaults to auto", () => {
  const setting = manifest.contributes.configuration.properties["markdownTwain.targetLanguage"];
  expect(setting).toMatchObject({ scope: "application", default: "auto" });
});

it.each([
  ["markdownTwain.provider", "openai"],
  ["markdownTwain.customBaseUrl", ""],
  ["markdownTwain.customApiKeyEnv", ""],
  ["markdownTwain.model", ""],
  ["markdownTwain.reasoningEffort", "default"],
])("makes %s an application setting that defaults to %j", (name, defaultValue) => {
  const setting = manifest.contributes.configuration.properties[name];
  expect(setting).toMatchObject({ scope: "application", default: defaultValue });
});

it("offers every Provider preset and the Custom provider", () => {
  const setting = manifest.contributes.configuration.properties["markdownTwain.provider"];
  expect(setting.enum).toEqual([...PROVIDER_PRESETS.map((preset) => preset.id), CUSTOM_PROVIDER_ID]);
  expect(setting.enumItemLabels).toEqual([...PROVIDER_PRESETS.map((preset) => preset.label), "Custom"]);
});

it("offers every Reasoning effort", () => {
  const setting = manifest.contributes.configuration.properties["markdownTwain.reasoningEffort"];
  expect(setting.enum).toEqual(REASONING_EFFORTS);
});
