/**
 * Browser-safe path helpers with node:path (posix) semantics for the subset the
 * editor needs. Shared by the dev-server middleware, the export writer, and the
 * web (File System Access) backend, so path math behaves identically in Node
 * and in the browser/service worker. Windows drive-letter absolutes are
 * tolerated on input (dev server on Windows); all output uses forward slashes.
 */

const DRIVE_RE = /^[a-zA-Z]:[\\/]/;

function toSlashes(path: string): string {
  return path.replace(/\\/g, "/");
}

export function isAbsolute(path: string): boolean {
  return path.startsWith("/") || DRIVE_RE.test(toSlashes(path));
}

/** Root prefix of an absolute path: "/" or "C:/". Empty for relative paths. */
function rootPrefix(path: string): string {
  const slashed = toSlashes(path);
  if (DRIVE_RE.test(slashed)) return slashed.slice(0, 3);
  if (slashed.startsWith("/")) return "/";
  return "";
}

/**
 * Resolves "." and ".." segments like node's normalize(). Keeps leading ".."
 * segments for relative paths; strips them (clamps at root) for absolute ones.
 */
export function normalize(path: string): string {
  const slashed = toSlashes(path);
  const root = rootPrefix(slashed);
  const body = slashed.slice(root.length);
  const out: string[] = [];
  for (const segment of body.split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      if (out.length > 0 && out[out.length - 1] !== "..") {
        out.pop();
        continue;
      }
      if (!root) {
        out.push("..");
        continue;
      }
      continue; // absolute paths clamp at their root
    }
    out.push(segment);
  }
  const joined = out.join("/");
  if (root) return joined ? `${root}${joined}` : root;
  return joined || ".";
}

export function join(...parts: string[]): string {
  const filtered = parts.filter((part) => part.length > 0);
  if (filtered.length === 0) return ".";
  return normalize(filtered.join("/"));
}

/** node-path-like resolve: right-most absolute segment wins. */
export function resolve(...parts: string[]): string {
  let combined = "";
  for (const part of parts) {
    if (!part) continue;
    combined = isAbsolute(part)
      ? part
      : combined
        ? `${combined}/${part}`
        : part;
  }
  if (!combined) return "/";
  // The editor never resolves purely relative stacks against a cwd; anchor at
  // "/" so behavior is deterministic in the browser.
  if (!isAbsolute(combined)) combined = `/${combined}`;
  return normalize(combined);
}

export function dirname(path: string): string {
  const normalized = normalize(path);
  const root = rootPrefix(normalized);
  const body = normalized.slice(root.length);
  const index = body.lastIndexOf("/");
  if (index === -1) return root || ".";
  const parent = body.slice(0, index);
  return root ? `${root}${parent}` : parent || ".";
}

export function basename(path: string): string {
  const slashed = toSlashes(path).replace(/\/+$/g, "");
  const index = slashed.lastIndexOf("/");
  const base = index === -1 ? slashed : slashed.slice(index + 1);
  return DRIVE_RE.test(`${base}/`) ? "" : base;
}

export function extname(path: string): string {
  const base = basename(path);
  if (base === "..") return "";
  const index = base.lastIndexOf(".");
  if (index <= 0) return "";
  return base.slice(index);
}

/**
 * Relative path from `from` to `to` (both treated as normalized absolutes).
 * Mirrors node:path.relative for same-root paths; cross-drive input returns
 * `to` unchanged (matching node's win32 behavior closely enough for guards).
 */
export function relative(from: string, to: string): string {
  const fromNorm = normalize(isAbsolute(from) ? from : `/${from}`);
  const toNorm = normalize(isAbsolute(to) ? to : `/${to}`);
  const fromRoot = rootPrefix(fromNorm);
  const toRoot = rootPrefix(toNorm);
  if (fromRoot.toLowerCase() !== toRoot.toLowerCase()) return toNorm;
  const fromParts = fromNorm.slice(fromRoot.length).split("/").filter(Boolean);
  const toParts = toNorm.slice(toRoot.length).split("/").filter(Boolean);
  let common = 0;
  while (
    common < fromParts.length &&
    common < toParts.length &&
    fromParts[common] === toParts[common]
  ) {
    common += 1;
  }
  const ups = fromParts.length - common;
  const downs = toParts.slice(common);
  const segments = [...Array<string>(ups).fill(".."), ...downs];
  return segments.join("/");
}
