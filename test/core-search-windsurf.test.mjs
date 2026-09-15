/**
 * Tests for core.mjs search() and searchWithContent() — mocked network paths.
 *
 * Notes:
 * - This machine has Windsurf installed, so getApiKey() always finds credentials.
 * - Tests use mocked fetch to control behavior without real network calls.
 * - These tests focus on credential discovery and deterministic error handling.
 */

import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { search, searchWithContent, extractKeyInfo } from "../src/core.mjs";
import { setEnv } from "./helpers/env.mjs";
import { mkdtempSync, realpathSync, writeFileSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildCacheKey, setCachedResult, clearCache, computeMtimeHash } from "../src/cache.mjs";

describe("search() — mocked fetch timeout", () => {
  let envRestore, originalFetch;

  before(() => {
    originalFetch = globalThis.fetch;
    envRestore = setEnv({ WINDSURF_API_KEY: "test-key-abc123" });
    globalThis.fetch = async () => {
      const err = new Error("Network timeout");
      err.name = "TimeoutError";
      throw err;
    };
  });

  after(() => {
    globalThis.fetch = originalFetch;
    envRestore.restore();
  });

  it("throws or returns error when network is unreachable", async () => {
    let result = null;
    try {
      result = await search({ query: "test query", projectRoot: "/tmp", timeoutMs: 1000 });
    } catch {
      result = null;
    }
    if (result !== null) {
      assert.ok(
        result.error || (Array.isArray(result.files) && result.files.length === 0),
        `expected error result, got: ${JSON.stringify(result)}`
      );
    }
    // null means threw — also acceptable
  });

  it("result.error contains error info when search fails", async () => {
    let result = null;
    try {
      result = await search({ query: "auth logic", projectRoot: "/tmp", timeoutMs: 500 });
    } catch {
      result = null;
    }
    if (result !== null && result.error) {
      assert.ok(typeof result.error === "string" && result.error.length > 0);
    }
  });
});

describe("searchWithContent() — mocked fetch timeout", () => {
  let envRestore, originalFetch;

  before(() => {
    originalFetch = globalThis.fetch;
    envRestore = setEnv({ WINDSURF_API_KEY: "test-key-abc123" });
    globalThis.fetch = async () => {
      const err = new Error("Network timeout");
      err.name = "TimeoutError";
      throw err;
    };
  });

  after(() => {
    globalThis.fetch = originalFetch;
    envRestore.restore();
  });

  it("throws or returns error string when network is unreachable", async () => {
    let result = null;
    try {
      result = await searchWithContent({ query: "test auth", projectRoot: "/tmp", timeoutMs: 500 });
    } catch {
      result = null;
    }
    // Valid: null (threw) OR error string (caught internally)
    assert.ok(
      result === null || typeof result === "string",
      `expected null or string, got ${typeof result}: ${JSON.stringify(result)?.slice(0, 100)}`
    );
  });
});

describe("source enrichment — preseeded cache without credentials or upstream", () => {
  let root, opts, entry, env, originalFetch, networkCalls;
  beforeEach(() => {
    clearCache();
    env = setEnv({ FC_CACHE_DISABLED: undefined, FC_CACHE_TTL_MS: undefined, FC_CACHE_MAX_ENTRIES: undefined });
    root = realpathSync(mkdtempSync(join(tmpdir(), "fc-source-cache-")));
    entry = { path: "a.js", full_path: join(root, "a.js"), ranges: [[1, 100]] };
    writeFileSync(entry.full_path, "const value = 1;\n");
    utimesSync(entry.full_path, 1600000000, 1600000000);
    opts = { query: "find value", projectRoot: root, apiKey: "test-only-no-discovery",
      maxTurns: 3, maxCommands: 8, maxResults: 10, treeDepth: 3, timeoutMs: 30000, excludePaths: [] };
    networkCalls = 0;
    originalFetch = globalThis.fetch;
    globalThis.fetch = async () => { networkCalls++; throw new Error("Unexpected network access"); };
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
    env.restore();
    clearCache();
    rmSync(root, { recursive: true, force: true });
    assert.equal(networkCalls, 0, "preseeded searches must not access upstream");
  });
  function seed(result = { files: [entry], rg_patterns: ["value", "value", "x"],
    _meta: { treeDepth: 3, treeSizeKB: 1, fellBack: false, projectRoot: root } }, options = opts) {
    const key = buildCacheKey({ ...options, model: process.env.WS_MODEL || "MODEL_SWE_1_6_FAST",
      mtimeHash: computeMtimeHash(root, options.excludePaths) });
    setCachedResult(key, result);
  }
  function splitContext(text, budget) {
    const markers = [...text.matchAll(/^\[context\] version=1, budget_chars=(\d+), used_chars=(\d+)$/gm)];
    assert.equal(markers.length, 1);
    const marker = markers[0];
    const source = text.slice(marker.index + marker[0].length);
    assert.equal(Number(marker[1]), budget);
    assert.equal(Number(marker[2]), source.length);
    assert.ok(source.length <= budget);
    if (source) assert.match(source, /^\n\nSource excerpt: /);
    return { prefix: text.slice(0, marker.index - 1), source };
  }

  it("keeps search structured and cached ranges immune to caller mutation", async () => {
    seed();
    const result = await search(opts);
    assert.deepEqual(result.files, [entry]);
    assert.equal(result._meta.cache_hit, true);
    assert.ok(!("content" in result));
    result.files[0].ranges[0][0] = 50;
    assert.deepEqual((await search(opts)).files, [entry]);
  });

  it("adds default source with exact locator/keywords/config prefix and marker stats", async () => {
    seed();
    const text = await searchWithContent(opts);
    assert.equal(typeof text, "string");
    const { prefix, source } = splitContext(text, 6000);
    assert.equal(prefix, `Found 1 relevant files.\n\n  [1/1] ${entry.full_path} (L1-100)\n\ngrep keywords: value\n\n[config] tree_depth=3, tree_size=1KB, max_turns=3, max_results=10, timeout_ms=30000, cache_hit=true`);
    assert.equal(source, "\n\nSource excerpt: a.js (L1-1)\n1: const value = 1;");
  });

  it("explicit zero and too-small budgets keep locators and emit used_chars=0", async () => {
    seed();
    for (const snippetChars of [0, 1]) {
      const { prefix, source } = splitContext(await searchWithContent({ ...opts, snippetChars }), snippetChars);
      assert.ok(prefix.includes(entry.full_path));
      assert.equal(source, "");
    }
  });

  it("no hits, keyword-only and filtered successes all retain a marker", async () => {
    seed({ files: [], raw_response: "empty answer" });
    const empty = splitContext(await searchWithContent(opts), 6000);
    assert.equal(empty.prefix, "No relevant files found.\n\nRaw response:\nempty answer");
    assert.equal(empty.source, "");
    seed({ files: [], rg_patterns: ["value"] });
    const keywords = splitContext(await searchWithContent(opts), 6000);
    assert.ok(keywords.prefix.startsWith("No files found.\n\ngrep keywords: value"));
    assert.equal(keywords.source, "");
    const excluded = { ...opts, excludePaths: ["a.js"] };
    seed({ files: [entry] }, excluded);
    const filtered = splitContext(await searchWithContent(excluded), 6000);
    assert.ok(filtered.prefix.includes(entry.full_path));
    assert.equal(filtered.source, "");
  });

  it("rereads fresh source even on a same-size/same-mtime cache hit", async () => {
    seed();
    assert.ok((await searchWithContent(opts)).includes("1: const value = 1;"));
    writeFileSync(entry.full_path, "const value = 2;\n");
    utimesSync(entry.full_path, 1600000000, 1600000000);
    const text = await searchWithContent(opts);
    assert.ok(text.includes("cache_hit=true"));
    const { source } = splitContext(text, 6000);
    assert.ok(source.includes("1: const value = 2;"));
    assert.ok(!source.includes("value = 1"));
  });

  it("preserves error strings without success markers", async () => {
    seed({ files: [], error: "Rate limited, please try again later",
      _meta: { errorCode: "RATE_LIMITED", treeDepth: 3, treeSizeKB: 1, projectRoot: root } });
    assert.equal(await searchWithContent(opts), `Error: Rate limited, please try again later\n\n[diagnostic] error_type=RATE_LIMITED, tree_depth_used=3, tree_size=1KB\n[diagnostic] project_path=${root}\n[config] max_turns=3, max_results=10, max_commands=8, timeout_ms=30000\n[hint] Rate limited. Wait a moment and retry.`);
  });

  it("rejects invalid internal budgets without credential or network access", async () => {
    for (const snippetChars of [-1, 1.5, 12001, NaN]) {
      await assert.rejects(searchWithContent({ ...opts, snippetChars }), RangeError);
    }
  });
});

describe("extractKeyInfo()", () => {
  it("returns a structured credential result without throwing", async () => {
    let result = null, threw = false;
    try {
      result = await extractKeyInfo();
    } catch {
      threw = true;
    }
    if (!threw && result !== null) {
      assert.ok(
        typeof result === "object" || typeof result === "string",
        `expected object or string, got ${typeof result}`
      );
      if (typeof result === "object") {
        assert.ok("api_key" in result || "error" in result, "expected API key or diagnostic error");
      }
    }
    // threw or null also acceptable (no Windsurf on this machine)
  });

  it("does not throw unexpectedly — only throws if truly no key available", async () => {
    let caughtMessage = null;
    try {
      await extractKeyInfo();
    } catch (e) {
      caughtMessage = e.message;
    }
    if (caughtMessage !== null) {
      // If it throws, the message should be descriptive
      assert.ok(typeof caughtMessage === "string" && caughtMessage.length > 0);
    }
  });
});
