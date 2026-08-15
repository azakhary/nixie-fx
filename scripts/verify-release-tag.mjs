import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const packageJson = JSON.parse(
  await readFile(resolve(import.meta.dirname, "../package.json"), "utf8"),
);
const tag = process.argv[2] ?? process.env.GITHUB_REF_NAME;
const expected = `v${packageJson.version}`;

if (tag !== expected) {
  throw new Error(
    `Release tag must be ${expected}; received ${tag ?? "none"}.`,
  );
}

process.stdout.write(`Release tag ${tag} matches package version.\n`);
