export const VFX_ASSET_REDIRECTS_FILE = ".vfx-asset-redirects.json";

export interface VfxAssetRedirect {
  from: string;
  to: string;
  at: number;
}

export interface VfxAssetRedirectMap {
  version: 1;
  redirects: VfxAssetRedirect[];
}

export function createEmptyAssetRedirectMap(): VfxAssetRedirectMap {
  return { version: 1, redirects: [] };
}

export function normalizeAssetRedirectMap(value: unknown): VfxAssetRedirectMap {
  if (!isRecord(value) || !Array.isArray(value.redirects)) {
    return createEmptyAssetRedirectMap();
  }
  const redirects = value.redirects
    .map(normalizeAssetRedirect)
    .filter((redirect): redirect is VfxAssetRedirect => redirect !== null);
  return { version: 1, redirects };
}

export function recordAssetRedirect(
  map: VfxAssetRedirectMap,
  from: string,
  to: string,
  at = Date.now(),
): VfxAssetRedirectMap {
  const normalizedFrom = normalizeAssetRedirectPath(from);
  const normalizedTo = normalizeAssetRedirectPath(to);
  if (!normalizedFrom || !normalizedTo || normalizedFrom === normalizedTo) {
    return normalizeAssetRedirectMap(map);
  }

  const redirects = normalizeAssetRedirectMap(map)
    .redirects.filter((redirect) => redirect.from !== normalizedFrom)
    .map((redirect) =>
      redirect.to === normalizedFrom
        ? { ...redirect, to: normalizedTo, at }
        : redirect,
    );
  redirects.push({ from: normalizedFrom, to: normalizedTo, at });
  return { version: 1, redirects };
}

export function resolveAssetRedirectPath(
  path: string,
  map: VfxAssetRedirectMap,
): string {
  let current = normalizeAssetRedirectPath(path) || path;
  const redirects = new Map(
    normalizeAssetRedirectMap(map).redirects.map((redirect) => [
      redirect.from,
      redirect.to,
    ]),
  );
  const seen = new Set<string>();
  for (let i = 0; i < 32; i++) {
    if (seen.has(current)) return current;
    seen.add(current);
    const next = redirects.get(current);
    if (!next) return current;
    current = next;
  }
  return current;
}

export function rewriteAssetRedirectPaths(
  value: unknown,
  map: VfxAssetRedirectMap,
): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => rewriteAssetRedirectPaths(item, map));
  }
  if (!value || typeof value !== "object") return value;
  const source = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(source)) {
    if (typeof child === "string" && (key === "texture" || key === "tex")) {
      out[key] = resolveAssetRedirectPath(child, map);
      continue;
    }
    if (
      typeof child === "string" &&
      key === "default" &&
      source.type === "texture"
    ) {
      out[key] = resolveAssetRedirectPath(child, map);
      continue;
    }
    out[key] = rewriteAssetRedirectPaths(child, map);
  }
  if (
    (source.type === "texture" ||
      source.type === "mesh" ||
      source.type === "material") &&
    typeof source.path === "string"
  ) {
    out.path = resolveAssetRedirectPath(source.path, map);
  }
  return out;
}

function normalizeAssetRedirect(value: unknown): VfxAssetRedirect | null {
  if (!isRecord(value)) return null;
  const from = normalizeAssetRedirectPath(value.from);
  const to = normalizeAssetRedirectPath(value.to);
  const at =
    typeof value.at === "number" && Number.isFinite(value.at) ? value.at : 0;
  if (!from || !to || from === to) return null;
  return { from, to, at };
}

function normalizeAssetRedirectPath(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\/+|\/+$/g, "");
  return trimmed || null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
