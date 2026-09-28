import { LANGUAGES, type Language } from "./languages.ts";

export const AUTO = "auto";
const AUTO_LABEL = "Follow VS Code display language";

export type AutoResolution =
  | { ok: true; language: Language }
  /** `tag` is the display language as given, which isn't in the table. */
  | { ok: false; tag: string };

/** `English name (native name)`, or the English name alone when the native name is missing or the same. */
export function languageLabel(language: Language): string {
  const { englishName, nativeName } = language;
  return nativeName && nativeName !== englishName ? `${englishName} (${nativeName})` : englishName;
}

/** The setting's `enum` and `enumItemLabels`, as `pnpm sync:languages` writes them into the manifest. */
export function targetLanguageEnum(): { enum: string[]; enumItemLabels: string[] } {
  return {
    enum: [AUTO, ...LANGUAGES.map((language) => language.tag)],
    enumItemLabels: [AUTO_LABEL, ...LANGUAGES.map(languageLabel)],
  };
}

/** The Target language setting's language: the tag itself, or `auto` resolved from `displayLanguage`. */
export function resolveTargetLanguage(setting: string, displayLanguage: string): AutoResolution {
  if (setting === AUTO) return resolveAutoTargetLanguage(displayLanguage);
  const language = LANGUAGES.find((entry) => entry.tag === setting);
  return language ? { ok: true, language } : { ok: false, tag: setting };
}

/**
 * Resolves `auto` from VS Code's display language (`vscode.env.language`):
 * the full tag, then language + script from `Intl.Locale#maximize()`, then the
 * language only.
 */
export function resolveAutoTargetLanguage(displayLanguage: string): AutoResolution {
  let locale: Intl.Locale;
  try {
    locale = new Intl.Locale(Intl.getCanonicalLocales(displayLanguage)[0] ?? "");
  } catch {
    return { ok: false, tag: displayLanguage };
  }
  const { language, script } = locale.maximize();
  const candidates = [locale.toString(), script && `${language}-${script}`, language];
  for (const candidate of candidates) {
    const match = LANGUAGES.find((entry) => entry.tag === candidate);
    if (match) return { ok: true, language: match };
  }
  return { ok: false, tag: displayLanguage };
}
