import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const listed = execFileSync(
  "git",
  ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
  { cwd: root },
).toString("utf8");
const paths = listed.split("\0").filter(Boolean);
const forbiddenText = [
  ["@rockbite", "vfx-runtime"].join("/"),
  ["rockbite", "vfx-editor"].join("/"),
  ["", "Users", ""].join("/"),
  ["src", "editor", ""].join("/"),
  ["NPM", "TOKEN"].join("_"),
];
const secretPatterns = [
  /npm_[A-Za-z0-9]{20,}/,
  /gh[pousr]_[A-Za-z0-9]{20,}/,
  /AKIA[0-9A-Z]{16}/,
  /-----BEGIN (?:RSA |OPENSSH |EC |PGP )?PRIVATE KEY-----/,
];
const violations = [];

for (const path of paths) {
  const buffer = await readFile(resolve(root, path));
  if (buffer.includes(0)) continue;
  const source = buffer.toString("utf8");
  for (const token of forbiddenText) {
    if (source.includes(token)) violations.push(`${path}: forbidden ${token}`);
  }
  for (const pattern of secretPatterns) {
    if (pattern.test(source)) violations.push(`${path}: possible secret`);
  }
}

if (violations.length > 0) {
  throw new Error(`Public source audit failed:\n${violations.join("\n")}`);
}

process.stdout.write(
  `NixieFX public source audit passed (${paths.length} files).\n`,
);
