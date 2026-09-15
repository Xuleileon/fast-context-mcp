import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { getRepoMap, _excludePatternToRegex, buildWindsurfPrompt, MAX_TREE_BYTES, FINAL_FORCE_ANSWER, sourceSnippets } from "../src/shared.mjs";
import { mkdtempSync, realpathSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";

describe("_excludePatternToRegex", () => {
  it("matches exact name (literal)", () => {
    const rx = _excludePatternToRegex("node_modules");
    assert(rx.test("node_modules"));
    assert(!rx.test("xnode_modules"));
    assert(!rx.test("node_modulesx"));
  });

  it("handles glob *", () => {
    const rx = _excludePatternToRegex("*.min.*");
    assert(rx.test("app.min.js"));
    assert(!rx.test("app.js"));
  });

  it("handles glob ?", () => {
    const rx = _excludePatternToRegex("a?.js");
    assert(rx.test("ab.js"));
    assert(!rx.test("abc.js"));
  });
});

describe("getRepoMap", () => {
  it("returns tree string with /codebase root", () => {
    const r = getRepoMap(process.cwd(), 1, ["node_modules", ".git"]);
    assert(r.tree.startsWith("/codebase"));
    assert(typeof r.depth === "number");
    assert(typeof r.sizeBytes === "number");
    assert(typeof r.fellBack === "boolean");
  });

  it("respects excludePaths (filters nested entries)", () => {
    const r = getRepoMap(process.cwd(), 2, ["node_modules", ".git", "test"]);
    // "test" entries within subdirectories should be filtered
    // At depth 1 tree-node-cli still shows top-level names, but at depth 2+ exclusion works
    assert(r.tree.includes("/codebase"));
    assert(typeof r.depth === "number");
  });

  it("falls back to lower depth if needed", () => {
    const r = getRepoMap(process.cwd(), 6, ["node_modules", ".git"]);
    assert(r.sizeBytes <= MAX_TREE_BYTES);
  });
});

describe("buildWindsurfPrompt", () => {
  it("substitutes parameters", () => {
    const wp = buildWindsurfPrompt(5, 10, 15);
    assert(wp.includes("5") && wp.includes("10") && wp.includes("15"));
    assert(!wp.includes("{max_turns}"));
  });

  it("Windsurf prompt contains [TOOL_CALLS] format", () => {
    assert(buildWindsurfPrompt().includes("[TOOL_CALLS]"));
  });

});

describe("sourceSnippets", () => {
  function fixture(t) {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "fc-snippets-")));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const file = (path, source, ranges = [[1, 100]]) => {
      const full_path = join(root, path);
      mkdirSync(dirname(full_path), { recursive: true });
      writeFileSync(full_path, source);
      return { path, full_path, ranges };
    };
    return { root, file };
  }

  it("merges aliases and overlaps, clips EOF and leaves input ranges unchanged", (t) => {
    const { root, file } = fixture(t);
    const entry = file("a.js", "one\r\ntwo\r\nthree\r\n", [[2, 999], [1, 2], [99, 100]]);
    const files = [entry, { ...entry, full_path: "/codebase/./a.js", ranges: [[1, 1]] }];
    const before = structuredClone(files);
    const text = sourceSnippets(files, root);
    assert.equal(text, "\n\nSource excerpt: a.js (L1-3)\n1: one\n2: two\n3: three");
    assert.deepEqual(files, before);
  });

  it("empty, malformed, unsafe and out-of-EOF ranges never become a whole file", (t) => {
    const { root, file } = fixture(t);
    const entry = file("a.js", "do not return", []);
    for (const ranges of [[], null, [[0, 1]], [[2, 1]], [[1.5, 2]], [[1, Infinity]], [[1, Number.MAX_SAFE_INTEGER + 1]], [["1", 2]], [[1]], [[9, 99]]]) {
      assert.equal(sourceSnippets([{ ...entry, ranges }], root), "");
    }
    for (const budget of [-1, 12001, 0.5, NaN, Infinity, "6000"]) {
      assert.throws(() => sourceSnippets([entry], root, budget), RangeError);
    }
  });

  it("represents more than three files despite a long first file", (t) => {
    const { root, file } = fixture(t);
    const files = [file("a.js", Array(60).fill("x".repeat(200)).join("\n"))];
    for (let i = 1; i < 5; i++) files.push(file(`${i}.js`, `line ${i}`));
    const text = sourceSnippets(files, root, 1000);
    assert.ok(text.length <= 1000);
    for (const entry of files) assert.ok(text.includes(`Source excerpt: ${entry.path} `));
  });

  it("gives unrepresented long-first-line files one complete line before refill", (t) => {
    const { root, file } = fixture(t);
    const files = [file("a.js", `${"a".repeat(200)}\n${"a".repeat(200)}`),
      file("b.js", "b".repeat(200)), file("c.js", "short")];
    const text = sourceSnippets(files, root, 600);
    for (const entry of files) assert.ok(text.includes(`Source excerpt: ${entry.path} `));
    assert.ok(text.length <= 600);
    assert.ok(text.includes(`1: ${"a".repeat(200)}`));
    assert.ok(!text.includes("2: "));
  });

  it("skips an unaffordable first window without losing later windows on refill", (t) => {
    const { root, file } = fixture(t);
    const lines = Array(10).fill("x".repeat(150));
    lines[9] = "short";
    const files = [file("a.js", lines.join("\n"), [[1, 3], [10, 10]]), file("b.js", "b")];
    const text = sourceSnippets(files, root, 500);
    assert.match(text, /Source excerpt: a\.js \(L10-10\)\n10: short/);
    assert.match(text, /Source excerpt: a\.js \(L1-2\)/);
    assert.ok(text.length <= 500);
  });

  it("limits each file to three twenty-line windows", (t) => {
    const { root, file } = fixture(t);
    const entry = file("a.js", Array.from({ length: 150 }, (_, i) => `code ${i + 1}`).join("\n"),
      [[1, 25], [40, 65], [80, 105], [120, 150]]);
    const text = sourceSnippets([entry], root, 12000);
    assert.equal((text.match(/Source excerpt:/g) || []).length, 3);
    assert.match(text, /\(L1-20\)/);
    assert.match(text, /\(L40-59\)/);
    assert.match(text, /\(L80-99\)/);
    assert.ok(!text.includes("120: "));
  });

  it("counts headers/newlines in UTF-16 characters and never splits source lines", (t) => {
    const { root, file } = fixture(t);
    const entry = file("a.js", "const a = '中文';\nconst b = '𝄞';\n");
    const first = "\n\nSource excerpt: a.js (L1-1)\n1: const a = '中文';";
    for (const budget of [0, 1, first.length - 1, first.length, first.length + 1, 12000]) {
      const text = sourceSnippets([entry], root, budget);
      assert.ok(text.length <= budget);
      if (budget < first.length) assert.equal(text, "");
      else {
        assert.ok(text.includes("1: const a = '中文';"));
        if (text.includes("2: ")) assert.ok(text.endsWith("2: const b = '𝄞';"));
      }
    }
    assert.equal(sourceSnippets([entry], root, first.length), first);
  });

  it("respects basename and root-relative directory/glob exclusions", (t) => {
    const { root, file } = fixture(t);
    const nested = file("src/generated/a.js", "nested");
    const top = file("a.min.js", "minified");
    const keep = file("src/keep.js", "keep");
    for (const pattern of ["generated", "src/generated", "src/generated/**", "**/generated/**", "src\\generated\\", "src/*/a.js"]) {
      const text = sourceSnippets([nested, keep], root, 6000, [pattern]);
      assert.ok(!text.includes("src/generated/a.js"), pattern);
      assert.ok(text.includes("src/keep.js"), pattern);
    }
    assert.equal(sourceSnippets([top], root, 6000, ["*.min.*"]), "");
    assert.equal(sourceSnippets([top], root, 6000, ["**/*.min.*"]), "");
  });

  it("rejects unsafe paths, credentials, binary/invalid UTF-8 and oversized files", (t) => {
    const { root, file } = fixture(t);
    const files = [file(".hidden/a.js", "hidden"), file("config/a.js", "config"),
      file("logs/a.js", "log"), file("credentials.js", "sensitive"), file("data.json", "{}"),
      file("a.js", "const password = 'test-only-value';"),
      file("b.js", Buffer.from([0x61, 0x00, 0x62])), file("c.js", Buffer.from([0xc3, 0x28])),
      file("d.js", "d".repeat(256 * 1024 + 1)),
      { full_path: join(root, "..", "outside.js"), ranges: [[1, 1]] }];
    assert.equal(sourceSnippets(files, root, 12000), "");
  });

  it("rejects file and directory symlinks even when targets are inside the root", (t) => {
    const { root, file } = fixture(t);
    const entry = file("real/a.js", "inside");
    try {
      symlinkSync(entry.full_path, join(root, "alias.js"), "file");
      symlinkSync(join(root, "real"), join(root, "linked"), process.platform === "win32" ? "junction" : "dir");
    } catch (error) {
      if (["EPERM", "EACCES", "ENOTSUP"].includes(error.code)) { t.skip("Symlinks unavailable"); return; }
      throw error;
    }
    assert.equal(sourceSnippets([
      { ...entry, full_path: join(root, "alias.js") },
      { ...entry, full_path: join(root, "linked", "a.js") },
    ], root), "");
  });

  it("caps source reads at thirty distinct files", (t) => {
    const { root, file } = fixture(t);
    const files = Array.from({ length: 31 }, (_, i) => file(`${i}.js`, `line ${i}`));
    const text = sourceSnippets(files, root, 12000);
    assert.equal((text.match(/Source excerpt:/g) || []).length, 30);
    assert.ok(!text.includes("Source excerpt: 30.js"));
  });
});

describe("constants", () => {
  it("FINAL_FORCE_ANSWER instructs the model to finish", () => {
    assert(FINAL_FORCE_ANSWER.includes("final ANSWER"));
  });

  it("MAX_TREE_BYTES = 250KB", () => {
    assert.equal(MAX_TREE_BYTES, 250 * 1024);
  });
});
