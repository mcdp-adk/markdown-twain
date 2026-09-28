import { describe, expect, it } from "vitest";
import { LANGUAGES } from "./languages.ts";
import { languageLabel, resolveAutoTargetLanguage, targetLanguageEnum } from "./target-language.ts";

describe("resolveAutoTargetLanguage", () => {
  it.each([
    ["zh-cn", "zh-Hans"],
    ["zh-tw", "zh-Hant"],
    ["zh-hk", "zh-Hant"],
    ["pt-br", "pt"],
    ["en", "en"],
    ["fa-AF", "fa-AF"],
    ["ja", "ja"],
  ])("resolves %s to %s", (displayLanguage, tag) => {
    expect(resolveAutoTargetLanguage(displayLanguage)).toEqual({
      ok: true,
      language: LANGUAGES.find((language) => language.tag === tag),
    });
  });

  it.each(["qps-ploc", "", "not a tag"])("fails on %j and carries the tag", (displayLanguage) => {
    expect(resolveAutoTargetLanguage(displayLanguage)).toEqual({
      ok: false,
      tag: displayLanguage,
    });
  });
});

describe("languageLabel", () => {
  it("shows the English and native names", () => {
    expect(languageLabel({ tag: "ja", englishName: "Japanese", nativeName: "日本語" })).toBe(
      "Japanese (日本語)",
    );
  });

  it("shows only the English name when the native name is missing", () => {
    expect(languageLabel({ tag: "fuv", englishName: "Nigerian Fulfulde" })).toBe("Nigerian Fulfulde");
  });

  it("shows only the English name when the native name is the same", () => {
    expect(languageLabel({ tag: "en", englishName: "English", nativeName: "English" })).toBe("English");
  });
});

describe("targetLanguageEnum", () => {
  it("lists auto first, then every language in table order", () => {
    const { enum: values, enumItemLabels } = targetLanguageEnum();
    expect(values).toEqual(["auto", ...LANGUAGES.map((language) => language.tag)]);
    expect(enumItemLabels[0]).toBe("Follow VS Code display language");
    expect(enumItemLabels).toHaveLength(values.length);
    expect(enumItemLabels[values.indexOf("zh-Hans")]).toBe("Simplified Chinese (简体中文)");
  });
});

describe("LANGUAGES", () => {
  it("has 179 unique, canonical tags", () => {
    const tags = LANGUAGES.map((language) => language.tag);
    expect(tags).toHaveLength(179);
    expect(new Set(tags).size).toBe(179);
    for (const tag of tags) expect(Intl.getCanonicalLocales(tag)).toEqual([tag]);
  });
});
