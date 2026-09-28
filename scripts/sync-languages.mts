// Writes the Target language setting's `enum` and `enumItemLabels` into
// package.json from the language table. Run through `pnpm sync:languages`.
// Node runs this TypeScript directly (type stripping, Node 22.18 or later).

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { targetLanguageEnum } from "../src/core/target-language.ts";

const manifestPath = resolve(import.meta.dirname, "..", "package.json");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const setting = manifest.contributes.configuration.properties["markdownTwain.targetLanguage"];

Object.assign(setting, targetLanguageEnum());
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
