// The translation color: the contributed theme color, which users override in
// `workbench.colorCustomizations`. Set Translation Color writes that override.

export const TRANSLATION_COLOR = "markdownTwain.translationForeground";

const HEX_COLOR = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

/** Why `input` can't be the translation color, or undefined when it can; empty stands for the default. */
export function translationColorProblem(input: string): string | undefined {
  return input === "" || HEX_COLOR.test(input) ? undefined : "Enter a hex color such as #d97706.";
}

/**
 * The color customizations with the translation color set to `color`, or removed when it's empty.
 * Undefined when no customization is left.
 */
export function withTranslationColor(
  customizations: Record<string, unknown> | undefined,
  color: string,
): Record<string, unknown> | undefined {
  const { [TRANSLATION_COLOR]: _, ...rest } = customizations ?? {};
  const next = color === "" ? rest : { ...rest, [TRANSLATION_COLOR]: color };
  return Object.keys(next).length > 0 ? next : undefined;
}
