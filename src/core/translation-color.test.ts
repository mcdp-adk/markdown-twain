import { describe, expect, it } from "vitest";
import { TRANSLATION_COLOR, translationColorProblem, withTranslationColor } from "./translation-color.ts";

describe("translationColorProblem", () => {
  it.each(["#d97706", "#D97706", "#fa0", "#fa08", "#d9770680", ""])("accepts %j", (input) => {
    expect(translationColorProblem(input)).toBeUndefined();
  });

  it.each(["orange", "d97706", "#d9770", "#ggg", "rgb(217, 119, 6)"])("rejects %j", (input) => {
    expect(translationColorProblem(input)).toBe("Enter a hex color such as #d97706.");
  });
});

describe("withTranslationColor", () => {
  it("sets the color and keeps the other customizations", () => {
    const customizations = {
      "editor.background": "#000000",
      "[Dark Modern]": { [TRANSLATION_COLOR]: "#fbbf24" },
    };
    expect(withTranslationColor(customizations, "#d97706")).toEqual({
      ...customizations,
      [TRANSLATION_COLOR]: "#d97706",
    });
  });

  it("sets the color when there are no customizations", () => {
    expect(withTranslationColor(undefined, "#d97706")).toEqual({ [TRANSLATION_COLOR]: "#d97706" });
  });

  it("removes the color when it's empty", () => {
    expect(
      withTranslationColor({ "editor.background": "#000000", [TRANSLATION_COLOR]: "#d97706" }, ""),
    ).toEqual({
      "editor.background": "#000000",
    });
  });

  it("leaves nothing when the removed color was the only customization", () => {
    expect(withTranslationColor({ [TRANSLATION_COLOR]: "#d97706" }, "")).toBeUndefined();
  });
});
