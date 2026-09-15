import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdtempSync, rmSync, realpathSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildCacheKey, getCachedResult, setCachedResult, clearCache, computeMtimeHash } from "../src/cache.mjs";
import { setEnv } from "./helpers/env.mjs";

describe("buildCacheKey", () => {
  it("produces deterministic 64-char hex", () => {
    const k = buildCacheKey({ query: "q", model: "m", maxTurns: 3, maxResults: 10, treeDepth: 3, repoMapHash: "t", mtimeHash: "h" });
    assert.equal(k.length, 64);
    assert.equal(k, buildCacheKey({ query: "q", model: "m", maxTurns: 3, maxResults: 10, treeDepth: 3, repoMapHash: "t", mtimeHash: "h" }));
  });

  it("different query → different key", () => {
    const k1 = buildCacheKey({ query: "a", model: "m", maxTurns: 3, maxResults: 10, treeDepth: 3, repoMapHash: "t", mtimeHash: "h" });
    const k2 = buildCacheKey({ query: "b", model: "m", maxTurns: 3, maxResults: 10, treeDepth: 3, repoMapHash: "t", mtimeHash: "h" });
    assert.notEqual(k1, k2);
  });

  it("different mtimeHash → different key", () => {
    const k1 = buildCacheKey({ query: "q", model: "m", maxTurns: 3, maxResults: 10, treeDepth: 3, repoMapHash: "t", mtimeHash: "h1" });
    const k2 = buildCacheKey({ query: "q", model: "m", maxTurns: 3, maxResults: 10, treeDepth: 3, repoMapHash: "t", mtimeHash: "h2" });
    assert.notEqual(k1, k2);
  });

  it("keys include canonical project roots and maxCommands even for identical fingerprints", (t) => {
    const root = mkdtempSync(join(tmpdir(), "fc-key-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const params = { query: "q", model: "m", maxTurns: 3, maxResults: 10, treeDepth: 3, mtimeHash: "same", projectRoot: root, maxCommands: 8 };
    assert.equal(buildCacheKey(params), buildCacheKey({ ...params, projectRoot: realpathSync(root) }));
    assert.notEqual(buildCacheKey(params), buildCacheKey({ ...params, projectRoot: join(root, "other") }));
    assert.notEqual(buildCacheKey(params), buildCacheKey({ ...params, maxCommands: 4 }));
  });

  it("excludePaths affects key", () => {
    const k1 = buildCacheKey({ query: "q", model: "m", maxTurns: 3, maxResults: 10, treeDepth: 3, repoMapHash: "t", excludePaths: ["a"] });
    const k2 = buildCacheKey({ query: "q", model: "m", maxTurns: 3, maxResults: 10, treeDepth: 3, repoMapHash: "t", excludePaths: ["b"] });
    assert.notEqual(k1, k2);
  });
});

describe("getCachedResult / setCachedResult", () => {
  let env;
  beforeEach(() => {
    clearCache();
    env = setEnv({ FC_CACHE_DISABLED: undefined, FC_CACHE_TTL_MS: undefined, FC_CACHE_MAX_ENTRIES: undefined });
  });
  afterEach(() => {
    clearCache();
    env.restore();
  });

  it("returns null on miss", () => {
    assert.equal(getCachedResult("nope"), null);
  });

  it("round-trips a stored result", () => {
    setCachedResult("k", { files: [{ path: "x" }] });
    const r = getCachedResult("k");
    assert.equal(r.files[0].path, "x");
  });

  it("isolates stored and returned arrays from caller mutations", () => {
    const result = { files: [{ path: "x", ranges: [[1, 2]] }], rg_patterns: ["abc"], _meta: { treeDepth: 3 } };
    setCachedResult("k", result);
    result.files[0].ranges[0][0] = 99;
    result.files.push({ path: "extra" });
    const first = getCachedResult("k");
    first.files[0].ranges.push([9, 10]);
    first.rg_patterns.push("def");
    first._meta.treeDepth = 1;
    const next = getCachedResult("k");
    assert.deepEqual(next.files, [{ path: "x", ranges: [[1, 2]] }]);
    assert.deepEqual(next.rg_patterns, ["abc"]);
    assert.equal(next._meta.treeDepth, 3);
  });

  it("checks returned file sizes/mtimes even outside the global fingerprint", (t) => {
    const root = mkdtempSync(join(tmpdir(), "fc-cache-stat-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const path = join(root, "a.js");
    writeFileSync(path, "old");
    utimesSync(path, 1600000000, 1600000000);
    const hash = computeMtimeHash(root, ["a.js"]);
    const result = { files: [{ full_path: path, ranges: [[1, 1]] }] };
    setCachedResult("k", result);
    assert.ok(getCachedResult("k"));
    writeFileSync(path, "larger");
    utimesSync(path, 1600000000, 1600000000);
    assert.equal(computeMtimeHash(root, ["a.js"]), hash);
    assert.equal(getCachedResult("k"), null, "size-only change invalidates");
    setCachedResult("k", result);
    utimesSync(path, 1600000001, 1600000001);
    assert.equal(getCachedResult("k"), null, "mtime-only change invalidates");
    setCachedResult("k", result);
    rmSync(path);
    assert.equal(getCachedResult("k"), null, "removed file invalidates");
  });

  it("FC_CACHE_DISABLED=true disables", () => {
    process.env.FC_CACHE_DISABLED = "true";
    setCachedResult("k", { a: 1 });
    assert.equal(getCachedResult("k"), null);
  });

  it("FC_CACHE_DISABLED=yes disables", () => {
    process.env.FC_CACHE_DISABLED = "yes";
    setCachedResult("k", { a: 1 });
    assert.equal(getCachedResult("k"), null);
  });

  it("FC_CACHE_TTL_MS=0 disables", () => {
    process.env.FC_CACHE_TTL_MS = "0";
    setCachedResult("k", { a: 1 });
    assert.equal(getCachedResult("k"), null);
  });

  it("TTL expiry evicts entry", async () => {
    process.env.FC_CACHE_TTL_MS = "1";
    setCachedResult("k", { a: 1 });
    await new Promise(r => setTimeout(r, 10));
    assert.equal(getCachedResult("k"), null);
  });

  it("max entries cap evicts oldest", () => {
    process.env.FC_CACHE_MAX_ENTRIES = "2";
    setCachedResult("a", { n: 1 });
    setCachedResult("b", { n: 2 });
    setCachedResult("c", { n: 3 });
    assert.equal(getCachedResult("a"), null);
    assert.notEqual(getCachedResult("c"), null);
  });
});

describe("computeMtimeHash", () => {
  it("changes when file content changes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fc-mtime-"));
    const f = join(dir, "x.js");
    writeFileSync(f, "v1");
    const h1 = computeMtimeHash(dir, []);
    await new Promise(r => setTimeout(r, 15));
    writeFileSync(f, "v2");
    const h2 = computeMtimeHash(dir, []);
    assert.notEqual(h1, h2);
    rmSync(dir, { recursive: true });
  });

  it("respects excludePaths", () => {
    const dir = mkdtempSync(join(tmpdir(), "fc-excl-"));
    writeFileSync(join(dir, "a.js"), "a");
    writeFileSync(join(dir, "b.js"), "b");
    const hAll = computeMtimeHash(dir, []);
    const hExcl = computeMtimeHash(dir, ["b.js"]);
    assert.notEqual(hAll, hExcl);
    rmSync(dir, { recursive: true });
  });
});
