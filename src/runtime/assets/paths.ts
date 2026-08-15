export const DEFAULT_VFX_TEXTURE_ASSET_EXTENSIONS = [
  ".png",
  ".jpg",
  ".jpeg",
  ".webp",
  ".avif",
  ".gif",
] as const;

export const DEFAULT_VFX_MESH_ASSET_EXTENSIONS = [
  ".glb",
  ".gltf",
  ".json",
] as const;

export type VfxAssetPathIssueReason =
  | "not-string"
  | "empty"
  | "url"
  | "absolute"
  | "backslash"
  | "traversal"
  | "unsupported-extension";

export interface VfxAssetPathValidationOptions {
  supportedExtensions?: readonly string[];
}

export interface VfxAssetPathValidationResult {
  valid: boolean;
  path: string | null;
  reason?: VfxAssetPathIssueReason;
  message?: string;
}

export function normalizeVfxAssetPath(path: string): string {
  return path
    .trim()
    .replace(/\/+/g, "/")
    .replace(/^\.\/+/, "");
}

export function validateVfxTextureAssetPath(
  value: unknown,
  options: VfxAssetPathValidationOptions = {},
): VfxAssetPathValidationResult {
  return validateVfxAssetPath(value, {
    supportedExtensions:
      options.supportedExtensions ?? DEFAULT_VFX_TEXTURE_ASSET_EXTENSIONS,
    noun: "Texture",
  });
}

export function validateVfxMeshAssetPath(
  value: unknown,
  options: VfxAssetPathValidationOptions = {},
): VfxAssetPathValidationResult {
  return validateVfxAssetPath(value, {
    supportedExtensions:
      options.supportedExtensions ?? DEFAULT_VFX_MESH_ASSET_EXTENSIONS,
    noun: "Mesh",
  });
}

function validateVfxAssetPath(
  value: unknown,
  options: {
    supportedExtensions: readonly string[];
    noun: "Texture" | "Mesh";
  },
): VfxAssetPathValidationResult {
  if (typeof value !== "string") {
    return invalidAssetPath(
      "not-string",
      `${options.noun} asset reference must be a project-relative string path.`,
    );
  }

  const rawPath = value.trim();
  if (!rawPath) {
    return invalidAssetPath(
      "empty",
      `${options.noun} asset reference is empty.`,
    );
  }

  if (/^[a-z][a-z0-9+.-]*:/i.test(rawPath) || rawPath.startsWith("//")) {
    return invalidAssetPath(
      "url",
      `${options.noun} asset reference must not be a URL.`,
    );
  }

  if (
    rawPath.startsWith("/") ||
    rawPath.startsWith("~") ||
    /^[a-z]:[\\/]/i.test(rawPath)
  ) {
    return invalidAssetPath(
      "absolute",
      `${options.noun} asset reference must be relative to the project asset root.`,
    );
  }

  if (rawPath.includes("\\")) {
    return invalidAssetPath(
      "backslash",
      `${options.noun} asset reference must use forward slashes.`,
    );
  }

  const normalized = normalizeVfxAssetPath(rawPath);
  const parts = normalized.split("/");
  if (
    normalized === "." ||
    normalized === ".." ||
    parts.some((part) => part === "..")
  ) {
    return invalidAssetPath(
      "traversal",
      `${options.noun} asset reference must stay inside the project asset root.`,
    );
  }

  const extension = extensionOf(normalized);
  const supportedExtensions = options.supportedExtensions;
  if (
    !extension ||
    !supportedExtensions.some(
      (supported) => supported.toLowerCase() === extension,
    )
  ) {
    return invalidAssetPath(
      "unsupported-extension",
      `${options.noun} asset extension must be one of ${supportedExtensions.join(", ")}.`,
    );
  }

  return { valid: true, path: normalized };
}

function invalidAssetPath(
  reason: VfxAssetPathIssueReason,
  message: string,
): VfxAssetPathValidationResult {
  return { valid: false, path: null, reason, message };
}

function extensionOf(path: string): string | null {
  const name = path.split("/").pop() ?? "";
  const dotIndex = name.lastIndexOf(".");
  if (dotIndex <= 0 || dotIndex === name.length - 1) return null;
  return name.slice(dotIndex).toLowerCase();
}
