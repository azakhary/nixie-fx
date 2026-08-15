export const EDITOR_PROJECT_FILE_NAME = "vfx-editor.prj";
export const EDITOR_PROJECT_APP_ID = "vfx-editor";
export const DEFAULT_PROJECT_EFFECTS_PATH = ".";
export const DEFAULT_PROJECT_OUTPUT_PATH = "out/vfx";
export const DEFAULT_PROJECT_ASSET_ROOT_PATH = ".";
export const DEFAULT_PROJECT_MATERIALS_FOLDER = "materials";

export interface EditorProjectSettings {
  effectDataPath: string;
  outputPath: string;
  assetRootPath: string;
  materialsFolder: string;
  allowExternalOutput: boolean;
  lastEffectFile?: string;
}

export type EditorProjectPathSettingKey =
  "effectDataPath" | "outputPath" | "assetRootPath" | "materialsFolder";

export interface EditorProjectSettingsPathIssue {
  key: EditorProjectPathSettingKey;
  label: string;
  message: string;
}

export interface ProjectSettingsPathValidationOptions {
  allowExternal?: boolean;
}

export const EDITOR_PROJECT_PATH_SETTING_LABELS: Record<
  EditorProjectPathSettingKey,
  string
> = {
  effectDataPath: "Effect Data",
  outputPath: "Export Output",
  assetRootPath: "Asset Root",
  materialsFolder: "Materials Folder",
};

export function normalizeProjectSettings(
  value: unknown,
): EditorProjectSettings {
  const source = isRecord(value) ? value : {};
  const effectDataPath =
    readString(source.effectDataPath) ?? DEFAULT_PROJECT_EFFECTS_PATH;
  const outputPath =
    readString(source.outputPath) ?? DEFAULT_PROJECT_OUTPUT_PATH;
  const assetRootPath =
    readString(source.assetRootPath) ?? DEFAULT_PROJECT_ASSET_ROOT_PATH;
  const materialsFolder =
    readString(source.materialsFolder) ?? DEFAULT_PROJECT_MATERIALS_FOLDER;
  const allowExternalOutput = source.allowExternalOutput === true;
  const lastEffectFile = readString(source.lastEffectFile);

  return {
    effectDataPath,
    outputPath,
    assetRootPath,
    materialsFolder,
    allowExternalOutput,
    ...(lastEffectFile ? { lastEffectFile } : {}),
  };
}

export function normalizeProjectSettingsPath(value: string): string {
  return value.trim().replace(/\/+/g, "/").replace(/\/$/g, "") || ".";
}

export function validateProjectSettingsPath(
  value: string,
  label = "Project path",
  options: ProjectSettingsPathValidationOptions = {},
): string | null {
  const trimmed = value.trim();
  if (!trimmed) return `${label} is required.`;
  if (trimmed === ".") return null;
  if (trimmed.includes("\\")) {
    return `${label} must use forward slashes.`;
  }
  const looksLikeWindowsDrive = /^[a-zA-Z]:\//.test(trimmed);
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(trimmed) && !looksLikeWindowsDrive) {
    return `${label} cannot be a URL or protocol path.`;
  }

  if (options.allowExternal) return null;

  if (trimmed.startsWith("/") || /^[a-zA-Z]:/.test(trimmed)) {
    return `${label} must be relative to the project folder.`;
  }
  if (trimmed === "~" || trimmed.startsWith("~/")) {
    return `${label} must be relative to the project folder.`;
  }

  const segments = trimmed.split("/").filter(Boolean);
  if (segments.length === 0) return `${label} is required.`;
  if (segments.some((segment) => segment === "." || segment === "..")) {
    return `${label} cannot contain . or .. segments.`;
  }
  return null;
}

export function validateProjectSettingsPaths(
  settings: Pick<
    EditorProjectSettings,
    | "effectDataPath"
    | "outputPath"
    | "assetRootPath"
    | "materialsFolder"
    | "allowExternalOutput"
  >,
): EditorProjectSettingsPathIssue[] {
  return PROJECT_SETTINGS_PATH_KEYS.flatMap((key) => {
    const label = EDITOR_PROJECT_PATH_SETTING_LABELS[key];
    if (key === "materialsFolder" && settings[key].trim() === ".") {
      return [
        {
          key,
          label,
          message: `${label} must be a folder under the asset root.`,
        },
      ];
    }
    const message = validateProjectSettingsPath(settings[key], label, {
      allowExternal:
        key === "effectDataPath" ||
        key === "assetRootPath" ||
        (key === "outputPath" && settings.allowExternalOutput),
    });
    return message ? [{ key, label, message }] : [];
  });
}

export function assertProjectSettingsPaths(
  settings: Pick<
    EditorProjectSettings,
    | "effectDataPath"
    | "outputPath"
    | "assetRootPath"
    | "materialsFolder"
    | "allowExternalOutput"
  >,
): void {
  const issues = validateProjectSettingsPaths(settings);
  if (issues.length > 0) throw new Error(issues[0].message);
}

const PROJECT_SETTINGS_PATH_KEYS: readonly EditorProjectPathSettingKey[] = [
  "effectDataPath",
  "outputPath",
  "assetRootPath",
  "materialsFolder",
];

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
