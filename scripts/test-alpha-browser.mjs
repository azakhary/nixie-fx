// Headed GPU regression; reads pixel values only, without capturing QA media.
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "tsup";
import { chromium } from "playwright";

const outDir = await mkdtemp(join(tmpdir(), "nixie-alpha-"));
let browser;
try {
  await build({
    config: false,
    entry: ["tests/rendering/alpha-browser.ts"],
    outDir,
    format: ["iife"],
    platform: "browser",
    noExternal: [/.*/],
    silent: true,
  });
  browser = await chromium.launch({ headless: false });
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  await page.setContent(
    "<!doctype html><title>Nixie alpha GPU regression</title>",
  );
  await page.addScriptTag({
    content: await readFile(join(outDir, "alpha-browser.global.js"), "utf8"),
  });
  await page.waitForFunction(() => window.alphaRegressionResult, undefined, {
    timeout: 60000,
  });
  const result = await page.evaluate(() => window.alphaRegressionResult);
  console.log(JSON.stringify({ ...result, errors }, null, 2));
  if (result.failures.length || errors.length) process.exitCode = 1;
} finally {
  await browser?.close();
  await rm(outDir, { recursive: true, force: true });
}
