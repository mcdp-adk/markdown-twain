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

it("offers one mode-aware title button on the focused Markdown preview", () => {
  const modes = ["originalOnly", "bilingual", "translationOnly"];
  const titles = ["Original Only", "Bilingual", "Translation Only"];
  const preview =
    "(activeWebviewPanelId == 'markdown.preview' || activeCustomEditorId == 'vscode.markdown.preview.editor')";

  for (const [index, mode] of modes.entries()) {
    const command = `markdownTwain.pickDisplayMode.${mode}`;
    expect(manifest.contributes.commands).toContainEqual({
      command,
      title: `markdown-twain: ${titles[index]}`,
      icon: "$(globe)",
    });
    expect(manifest.contributes.menus["editor/title"]).toContainEqual({
      command,
      when: `${preview} && markdownTwain.displayMode == ${mode}`,
      group: "navigation@1",
    });
    expect(manifest.contributes.menus.commandPalette).toContainEqual({ command, when: "false" });
  }
  expect(Object.keys(manifest.contributes.menus)).toEqual(["commandPalette", "editor/title"]);
});

it("offers the Display mode picker and Translation Only in the Command Palette", () => {
  expect(manifest.contributes.commands).toEqual(
    expect.arrayContaining([
      { command: "markdownTwain.pickDisplayMode", title: "Pick Display Mode", category: "markdown-twain" },
      {
        command: "markdownTwain.showTranslationOnly",
        title: "Show Translation Only",
        category: "markdown-twain",
      },
    ]),
  );
});
