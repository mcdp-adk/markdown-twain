// Opens a throwaway VS Code with the built extension and the sample document.
// Usage: pnpm dev-host [theme], for example `pnpm dev-host "Default Light Modern"`.
// Run through `pnpm dev-host`, which builds the extension first.

import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const DEFAULT_THEME = "Default Dark Modern";

const root = resolve(import.meta.dirname, "..");
const theme = process.argv[2] || DEFAULT_THEME;

// A fresh user data dir each run, so SecretStorage starts empty.
const tempDir = mkdtempSync(join(tmpdir(), "markdown-twain-dev-host-"));
const userDataDir = join(tempDir, "user-data");
const extensionsDir = join(tempDir, "extensions");
mkdirSync(join(userDataDir, "User"), { recursive: true });
mkdirSync(extensionsDir);

const settings = JSON.parse(readFileSync(join(root, "scripts", "dev-host", "settings.json"), "utf8"));
settings["workbench.colorTheme"] = theme;
writeFileSync(join(userDataDir, "User", "settings.json"), `${JSON.stringify(settings, null, 2)}\n`);

// When this runs inside VS Code's own terminal or extension host, the variable
// leaks in and would make Code.exe start as plain Node.
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const args = [
  "--new-window",
  `--user-data-dir=${userDataDir}`,
  `--extensions-dir=${extensionsDir}`,
  `--extensionDevelopmentPath=${root}`,
  join(root, "sample", "sample.md"),
];

console.log(`Temp dir: ${tempDir}`);
console.log(`Theme: ${theme}`);

// Detached, so this script returns while the window stays open.
const options = { env, detached: true, stdio: "ignore", windowsHide: true };
// `code` is a .cmd script on Windows, which needs a shell to run. The name
// stays unquoted: a quoted "code" breaks the script's lookup of Code.exe.
const child =
  process.platform === "win32"
    ? spawn(["code", ...args.map((arg) => `"${arg}"`)].join(" "), {
        ...options,
        shell: true,
      })
    : spawn("code", args, options);
child.unref();
child.on("error", (error) => {
  console.error(`Couldn't run \`code\`; is it on PATH? ${error.message}`);
  process.exitCode = 1;
});
