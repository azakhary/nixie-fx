import { describe, expect, it } from "vitest";
import * as nodePath from "node:path";
import {
  basename,
  dirname,
  extname,
  isAbsolute,
  join,
  normalize,
  relative,
  resolve,
} from "./pathx";

describe("pathx parity with node:path (posix)", () => {
  const cases = [
    "/a/b/c",
    "/a/b/../c",
    "/a/./b/",
    "a/b/../../..",
    "a/../b",
    ".",
    "./foo",
    "foo/bar.json",
    "/a/b/c.material",
    "..",
    "../x",
  ];

  it("normalize matches", () => {
    for (const value of cases) {
      const expected =
        nodePath.posix.normalize(value).replace(/\/$/, "") || "/";
      const actual = normalize(value);
      const expectedTrimmed =
        expected === "/" ? "/" : expected.replace(/\/$/, "");
      expect(actual, `normalize(${value})`).toBe(
        expectedTrimmed === "" ? "." : expectedTrimmed,
      );
    }
  });

  it("basename/dirname/extname match", () => {
    for (const value of cases) {
      expect(basename(value), `basename(${value})`).toBe(
        nodePath.posix.basename(value),
      );
      expect(extname(value), `extname(${value})`).toBe(
        nodePath.posix.extname(value),
      );
    }
    expect(dirname("/a/b/c")).toBe("/a/b");
    expect(dirname("/a")).toBe("/");
    expect(dirname("a/b")).toBe("a");
    expect(dirname("a")).toBe(".");
  });

  it("resolve matches for absolute bases", () => {
    expect(resolve("/root", "a/b")).toBe("/root/a/b");
    expect(resolve("/root", "./a", "../b")).toBe("/root/b");
    expect(resolve("/root", "/other", "x")).toBe("/other/x");
    expect(resolve("/root/a", "..")).toBe("/root");
    expect(resolve("/web/proj", "out/vfx")).toBe("/web/proj/out/vfx");
  });

  it("relative matches", () => {
    const pairs: [string, string][] = [
      ["/a/b", "/a/b/c/d"],
      ["/a/b", "/a/x"],
      ["/a/b", "/a/b"],
      ["/a/b/c", "/a"],
      ["/web/p/out", "/web/p/effects"],
    ];
    for (const [from, to] of pairs) {
      expect(relative(from, to), `relative(${from}, ${to})`).toBe(
        nodePath.posix.relative(from, to),
      );
    }
  });

  it("join and isAbsolute behave", () => {
    expect(join("a", "b", "c.json")).toBe("a/b/c.json");
    expect(join("/a", "b")).toBe("/a/b");
    expect(isAbsolute("/a")).toBe(true);
    expect(isAbsolute("a/b")).toBe(false);
    expect(isAbsolute("C:\\x")).toBe(true);
    expect(normalize("a\\b\\c")).toBe("a/b/c");
  });
});
