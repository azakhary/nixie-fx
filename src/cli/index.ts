import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  normalize,
  relative,
  resolve,
} from "node:path";
import {
  createDefaultParticleEffect,
  makeParticleEffectFileName,
  normalizeParticleEffect,
  type VfxTargetProfile,
} from "../engine/particles";
import { writeVfxExportFromProject } from "../export/nodeWriter";
import type {
  VfxExportBlocker,
  VfxValidationIssue,
  VfxValidationResult,
} from "../runtime/schema/validation";
import { validateVfxAuthoringEffect } from "../runtime/schema/validation";
import {
  assertProjectSettingsPaths,
  EDITOR_PROJECT_FILE_NAME,
  parseEditorProjectFile,
  type EditorProjectFile,
} from "../project";

export interface NixieFxCliEnvironment {
  cwd?: string;
  stdout?: (line: string) => void;
  stderr?: (line: string) => void;
}

interface LoadedProject {
  root: string;
  project: EditorProjectFile;
}

interface EffectSource {
  relativePath: string;
  value: unknown;
}

type CliCommand =
  | { kind: "help" }
  | {
      kind: "effect-create";
      projectPath: string;
      name: string;
      profile: VfxTargetProfile;
    }
  | { kind: "validate"; projectPath: string }
  | { kind: "export"; projectPath: string };

const TARGET_PROFILES: readonly VfxTargetProfile[] = [
  "pixi-ui-2d",
  "three-world-3d",
  "portable",
];

const HELP = `NixieFX runtime and authoring tools

Usage:
  nixie-fx effect create --project <folder> --name <name> [--profile <profile>]
  nixie-fx validate [project-folder]
  nixie-fx export [project-folder]

Profiles:
  pixi-ui-2d (default), three-world-3d, portable`;

export async function runNixieFxCli(
  argv: readonly string[],
  environment: NixieFxCliEnvironment = {},
): Promise<number> {
  const stdout = environment.stdout ?? console.log;
  const stderr = environment.stderr ?? console.error;
  const cwd = resolve(environment.cwd ?? process.cwd());

  try {
    const command = parseCliCommand(argv);
    if (command.kind === "help") {
      stdout(HELP);
      return 0;
    }

    const loaded = await loadProject(command.projectPath, cwd);
    if (command.kind === "effect-create") {
      return await createEffect(loaded, command, stdout);
    }
    if (command.kind === "validate") {
      return await validateProject(loaded, stdout, stderr);
    }
    return await exportProject(loaded, stdout, stderr);
  } catch (error) {
    stderr(`Error: ${errorMessage(error)}`);
    return 1;
  }
}

function parseCliCommand(argv: readonly string[]): CliCommand {
  if (
    argv.length === 0 ||
    argv[0] === "help" ||
    argv[0] === "--help" ||
    argv[0] === "-h"
  ) {
    return { kind: "help" };
  }

  if (argv[0] === "effect") {
    if (argv[1] !== "create") {
      throw new Error('Expected "nixie-fx effect create"');
    }
    const parsed = parseOptions(argv.slice(2), ["project", "name", "profile"]);
    if (parsed.positionals.length > 0) {
      throw new Error(`Unexpected argument "${parsed.positionals[0]}"`);
    }
    const name = parsed.options.name?.trim();
    if (!name) throw new Error("--name is required");
    const rawProfile = parsed.options.profile ?? "pixi-ui-2d";
    if (!isTargetProfile(rawProfile)) {
      throw new Error(
        `Unknown profile "${rawProfile}". Expected ${TARGET_PROFILES.join(", ")}`,
      );
    }
    return {
      kind: "effect-create",
      projectPath: parsed.options.project ?? ".",
      name,
      profile: rawProfile,
    };
  }

  if (argv[0] === "validate" || argv[0] === "export") {
    const parsed = parseOptions(argv.slice(1), ["project"]);
    if (parsed.positionals.length > 1) {
      throw new Error(`Unexpected argument "${parsed.positionals[1]}"`);
    }
    if (parsed.options.project && parsed.positionals[0]) {
      throw new Error(
        "Pass the project as a positional path or --project, not both",
      );
    }
    return {
      kind: argv[0],
      projectPath: parsed.options.project ?? parsed.positionals[0] ?? ".",
    };
  }

  throw new Error(`Unknown command "${argv[0]}". Run nixie-fx --help.`);
}

function parseOptions(
  argv: readonly string[],
  allowed: readonly string[],
): {
  options: Record<string, string>;
  positionals: string[];
} {
  const allowedOptions = new Set(allowed);
  const options: Record<string, string> = {};
  const positionals: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument.startsWith("--")) {
      positionals.push(argument);
      continue;
    }

    const name = argument.slice(2);
    if (!allowedOptions.has(name)) {
      throw new Error(`Unknown option "${argument}"`);
    }
    if (Object.prototype.hasOwnProperty.call(options, name)) {
      throw new Error(`Option "${argument}" was provided more than once`);
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`Option "${argument}" requires a value`);
    }
    options[name] = value;
    index += 1;
  }
  return { options, positionals };
}

async function loadProject(
  projectArgument: string,
  cwd: string,
): Promise<LoadedProject> {
  const candidate = resolve(cwd, projectArgument);
  const filePath =
    basename(candidate) === EDITOR_PROJECT_FILE_NAME
      ? candidate
      : join(candidate, EDITOR_PROJECT_FILE_NAME);

  let json: string;
  try {
    json = await readFile(filePath, "utf8");
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      throw new Error(`No ${EDITOR_PROJECT_FILE_NAME} found at ${filePath}`);
    }
    throw error;
  }

  const project = parseEditorProjectFile(json);
  assertProjectSettingsPaths(project.settings);
  return { root: dirname(filePath), project };
}

async function createEffect(
  loaded: LoadedProject,
  command: Extract<CliCommand, { kind: "effect-create" }>,
  stdout: (line: string) => void,
): Promise<number> {
  const created = createDefaultParticleEffect(command.name, command.name);
  if (command.profile === "portable") {
    for (const emitter of created.emitters) {
      emitter.render.depthTest = false;
      emitter.render.depthWrite = false;
      emitter.render.depthInk = false;
    }
  }
  const effect = normalizeParticleEffect({
    ...created,
    targetProfile: command.profile,
  });
  const effectsRoot = resolveConfiguredDirectory(
    loaded.root,
    loaded.project.settings.effectDataPath,
  );
  const fileName = makeParticleEffectFileName(effect);
  const target = resolve(effectsRoot, fileName);
  assertPathInside(
    effectsRoot,
    target,
    "Effect file path escapes effect data root",
  );

  await mkdir(effectsRoot, { recursive: true });
  try {
    await writeFile(target, `${JSON.stringify(effect, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
    });
  } catch (error) {
    if (errorCode(error) === "EEXIST") {
      throw new Error(`Effect file already exists: ${target}`);
    }
    throw error;
  }

  stdout(`Created ${target}`);
  return 0;
}

async function validateProject(
  loaded: LoadedProject,
  stdout: (line: string) => void,
  stderr: (line: string) => void,
): Promise<number> {
  const effectsRoot = resolveConfiguredDirectory(
    loaded.root,
    loaded.project.settings.effectDataPath,
  );
  const sources = await readEffectSources(effectsRoot);
  let errorCount = 0;
  let warningCount = 0;

  for (const source of sources) {
    const validation = validateVfxAuthoringEffect(source.value);
    errorCount +=
      validation.errors.length + unmatchedBlockers(validation).length;
    warningCount += validation.warnings.length;
    emitValidation(validation, stdout, stderr, source.relativePath);
  }

  const summary = `Validated ${sources.length} effect${sources.length === 1 ? "" : "s"}: ${errorCount} error${errorCount === 1 ? "" : "s"}, ${warningCount} warning${warningCount === 1 ? "" : "s"}.`;
  if (errorCount > 0) {
    stderr(summary);
    return 1;
  }
  stdout(summary);
  return 0;
}

async function exportProject(
  loaded: LoadedProject,
  stdout: (line: string) => void,
  stderr: (line: string) => void,
): Promise<number> {
  const settings = loaded.project.settings;
  const result = await writeVfxExportFromProject({
    projectRoot: loaded.root,
    effectDataPath: settings.effectDataPath,
    assetRootPath: settings.assetRootPath,
    outputPath: settings.outputPath,
    allowExternalOutput: settings.allowExternalOutput,
    materialsFolder: settings.materialsFolder,
  });
  emitValidation(result.validation, stdout, stderr);

  if (!result.ok) {
    stderr(
      `Export blocked with ${result.validation.errors.length + unmatchedBlockers(result.validation).length} error(s). Diagnostics: ${result.writtenFiles[0]?.path ?? result.outputPath}`,
    );
    return 1;
  }

  stdout(
    `Exported ${result.effectCount} effect${result.effectCount === 1 ? "" : "s"} to ${result.outputPath}.`,
  );
  return 0;
}

async function readEffectSources(effectsRoot: string): Promise<EffectSource[]> {
  const sources: EffectSource[] = [];

  const walk = async (directory: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (errorCode(error) === "ENOENT") return;
      throw error;
    }

    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const absolutePath = resolve(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(absolutePath);
        continue;
      }
      if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".json")) {
        continue;
      }

      let value: unknown;
      try {
        value = JSON.parse(await readFile(absolutePath, "utf8")) as unknown;
      } catch {
        continue;
      }
      if (!hasParticleEffectEnvelope(value)) continue;
      sources.push({
        relativePath: relative(effectsRoot, absolutePath).replace(/\\/g, "/"),
        value,
      });
    }
  };

  await walk(effectsRoot);
  return sources.sort((left, right) =>
    left.relativePath.localeCompare(right.relativePath, undefined, {
      numeric: true,
    }),
  );
}

function hasParticleEffectEnvelope(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (value.app === "vfx-editor" && value.kind === "particle-effect")
    return true;
  return !("kind" in value) && Array.isArray(value.emitters);
}

function emitValidation(
  validation: VfxValidationResult,
  stdout: (line: string) => void,
  stderr: (line: string) => void,
  file?: string,
): void {
  for (const issue of validation.warnings) {
    stdout(formatIssue("warning", issue, file));
  }
  // Backend-semantics notes (F4): informational only — shown segregated from
  // warnings and never counted, so a clean effect still summarizes as clean.
  for (const issue of validation.infos) {
    stdout(formatNote(issue, file));
  }
  for (const issue of validation.errors) {
    stderr(formatIssue("error", issue, file));
  }
  for (const blocker of unmatchedBlockers(validation)) {
    stderr(formatIssue("error", blocker, file));
  }
}

function unmatchedBlockers(
  validation: VfxValidationResult,
): VfxExportBlocker[] {
  const issueKeys = new Set(
    [...validation.errors, ...validation.warnings].map(validationKey),
  );
  return validation.blockers.filter(
    (blocker) => !issueKeys.has(validationKey(blocker)),
  );
}

function formatIssue(
  severity: "error" | "warning",
  issue: VfxValidationIssue | VfxExportBlocker,
  file?: string,
): string {
  const location = [file, issue.path].filter(Boolean).join(":");
  return `${severity} [${issue.code}]${location ? ` ${location}` : ""}: ${issue.message}`;
}

function formatNote(issue: VfxValidationIssue, file?: string): string {
  const location = [file, issue.path].filter(Boolean).join(":");
  const scope = issue.backend ? ` (${issue.backend} note)` : " (note)";
  return `note [${issue.code}]${scope}${location ? ` ${location}` : ""}: ${issue.message}`;
}

function validationKey(issue: VfxValidationIssue | VfxExportBlocker): string {
  return `${issue.code}\u0000${issue.path}\u0000${issue.message}`;
}

function resolveConfiguredDirectory(
  projectRoot: string,
  rawPath: string,
): string {
  const trimmed = rawPath.trim();
  const expanded =
    trimmed === "~"
      ? homedir()
      : trimmed.startsWith("~/")
        ? resolve(homedir(), trimmed.slice(2))
        : trimmed;
  return isAbsolute(expanded)
    ? normalize(expanded)
    : resolve(projectRoot, expanded);
}

function assertPathInside(root: string, target: string, message: string): void {
  const path = relative(root, target);
  if (path.startsWith("..") || isAbsolute(path)) throw new Error(message);
}

function isTargetProfile(value: string): value is VfxTargetProfile {
  return TARGET_PROFILES.some((profile) => profile === value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorCode(error: unknown): string | undefined {
  return isRecord(error) && typeof error.code === "string"
    ? error.code
    : undefined;
}
