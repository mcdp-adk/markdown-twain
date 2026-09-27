import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
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
