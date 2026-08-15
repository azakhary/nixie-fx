import {
  EDITOR_PROJECT_APP_ID,
  normalizeProjectSettings,
  type EditorProjectSettings,
} from "./settings";

export const EDITOR_PROJECT_KIND = "project";
export const EDITOR_PROJECT_VERSION = 1;

export interface EditorProjectFile {
  app: typeof EDITOR_PROJECT_APP_ID;
  kind: typeof EDITOR_PROJECT_KIND;
  version: typeof EDITOR_PROJECT_VERSION;
  id: string;
  name: string;
  settings: EditorProjectSettings;
  createdAt: string;
  updatedAt: string;
}

/**
 * Decode the canonical `vfx-editor.prj` envelope without performing I/O.
 * Optional settings are filled exactly as the editor fills them today.
 */
export function normalizeEditorProjectFile(value: unknown): EditorProjectFile {
  if (!isRecord(value)) throw new Error("Project file is not valid JSON");
  if (
    value.app !== EDITOR_PROJECT_APP_ID ||
    value.kind !== EDITOR_PROJECT_KIND
  ) {
    throw new Error(`Project file is not a ${EDITOR_PROJECT_APP_ID} project`);
  }
  if (value.version !== EDITOR_PROJECT_VERSION) {
    throw new Error("Unsupported project file version");
  }

  const id = readString(value.id);
  const name = readString(value.name);
  const createdAt = readString(value.createdAt);
  const updatedAt = readString(value.updatedAt);
  if (!id || !name || !createdAt || !updatedAt) {
    throw new Error("Project file is missing required metadata");
  }

  if (!isRecord(value.settings)) {
    throw new Error("Project file is missing settings");
  }
  if (!readString(value.settings.effectDataPath)) {
    throw new Error("Project file is missing settings.effectDataPath");
  }

  return {
    app: EDITOR_PROJECT_APP_ID,
    kind: EDITOR_PROJECT_KIND,
    version: EDITOR_PROJECT_VERSION,
    id,
    name,
    settings: normalizeProjectSettings(value.settings),
    createdAt,
    updatedAt,
  };
}

export function parseEditorProjectFile(json: string): EditorProjectFile {
  let value: unknown;
  try {
    value = JSON.parse(json) as unknown;
  } catch {
    throw new Error("Project file is not valid JSON");
  }
  return normalizeEditorProjectFile(value);
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
