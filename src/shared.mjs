/**
 * Shared utilities for Fast Context search.
 *
 * Contains: getRepoMap, _parseAnswer, _excludePatternToRegex,
 * constants, and the Windsurf prompt builder.
 */

import { readdirSync, realpathSync, lstatSync, openSync, fstatSync, readSync, closeSync, constants } from "node:fs";
import { resolve, relative, join, sep, isAbsolute } from "node:path";
import treeNodeCli from "tree-node-cli";
import { resolveWithinRoot } from "./path-safety.mjs";

// ─── Constants ─────────────────────────────────────────────

/** Max safe tree size in bytes (server payload limit ~346KB, fixed overhead ~26KB) */
export const MAX_TREE_BYTES = 250 * 1024;

/** Injected after last effective search round to force an answer (Windsurf [TOOL_CALLS]/XML format) */
export const FINAL_FORCE_ANSWER =
  "You have no turns left. Now you MUST provide your final ANSWER, even if it's not complete.";

// ─── Helpers ───────────────────────────────────────────────

/**
 * Convert an exclude pattern (directory/file name or simple glob) to RegExp
 * for tree-node-cli's exclude option.
 * @param {string} pattern - e.g. "node_modules", "dist", "*.min.*"
 * @returns {RegExp}
 */
export function _excludePatternToRegex(pattern) {
  if (!/[*?]/.test(pattern)) {
    return new RegExp("^" + pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "$");
  }
  let regex = "^";
  for (const c of pattern) {
    if (c === "*") regex += ".*";
    else if (c === "?") regex += ".";
    else if (".+^${}()|[]\\".includes(c)) regex += "\\" + c;
    else regex += c;
  }
  return new RegExp(regex + "$");
}

/**
 * Get a directory tree of the project with adaptive depth fallback.
 *
 * Tries the requested depth first. If the tree output exceeds MAX_TREE_BYTES,
 * automatically falls back to lower depths until it fits.
 *
 * @param {string} projectRoot
 * @param {number} [targetDepth=3] - Desired tree depth (1-6)
 * @param {string[]} [excludePaths=[]] - Patterns to exclude from tree
 * @returns {{ tree: string, depth: number, sizeBytes: number, fellBack: boolean }}
 */
export function getRepoMap(projectRoot, targetDepth = 3, excludePaths = []) {
  const rootPattern = new RegExp(projectRoot.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g");
  const dirName = projectRoot.split("/").pop() || projectRoot.split("\\").pop() || projectRoot;
  const excludeRegexes = excludePaths.length ? excludePaths.map(_excludePatternToRegex) : [];

  for (let L = targetDepth; L >= 1; L--) {
    try {
      const opts = { maxDepth: L };
      if (excludeRegexes.length) opts.exclude = excludeRegexes;
      const stdout = treeNodeCli(projectRoot, opts);
      let treeStr = stdout.replace(rootPattern, "/codebase");
      const lines = treeStr.split("\n");
      if (lines[0] === dirName) {
        lines[0] = "/codebase";
        treeStr = lines.join("\n");
      }
      const sizeBytes = Buffer.byteLength(treeStr, "utf-8");
      if (sizeBytes <= MAX_TREE_BYTES) {
        return { tree: treeStr, depth: L, sizeBytes, fellBack: L < targetDepth };
      }
    } catch {
      // tree failed at this level, try lower
    }
  }

  // Ultimate fallback: simple ls
  try {
    let entries = readdirSync(projectRoot).sort();
    if (excludeRegexes.length) {
      entries = entries.filter((e) => !excludeRegexes.some((rx) => rx.test(e)));
    }
    const treeStr = ["/codebase", ...entries.map((e) => `├── ${e}`)].join("\n");
    return { tree: treeStr, depth: 0, sizeBytes: Buffer.byteLength(treeStr, "utf-8"), fellBack: true };
  } catch {
    const treeStr = "/codebase\n(empty or inaccessible)";
    return { tree: treeStr, depth: 0, sizeBytes: treeStr.length, fellBack: true };
  }
}

/**
 * Parse answer XML into structured file + range data.
 * @param {string} xmlText
 * @param {string} projectRoot
 * @returns {{ files: Array }}
 */
export function _parseAnswer(xmlText, projectRoot) {
  const files = [];
  const fileRegex = /<file\s+path=(["'])([^"']+)\1>([\s\S]*?)<\/file>/g;
  let fm;
  while ((fm = fileRegex.exec(xmlText)) !== null) {
    const vpath = fm[2];
    let rel = vpath.replace(/^\/codebase[\/\\]?/, "");
    rel = rel.replace(/^[\/\\]+/, "");

    let fullPath;
    try {
      fullPath = resolveWithinRoot(projectRoot, vpath);
    } catch {
      continue;
    }

    const ranges = [];
    const rangeRegex = /<range>(\d+)-(\d+)<\/range>/g;
    let rm;
    while ((rm = rangeRegex.exec(fm[3])) !== null) {
      ranges.push([parseInt(rm[1], 10), parseInt(rm[2], 10)]);
    }
    files.push({ path: rel, full_path: fullPath, ranges });
  }
  return { files };
}

/**
 * Read bounded, fresh source excerpts from structured locator results.
 * Filtering affects excerpts only; caller-owned files and ranges are never changed.
 * @param {Array} files
 * @param {string} projectRoot
 * @param {number} [budget=6000] - Total rendered characters, including headers/newlines
 * @param {string[]} [excludePaths=[]] - Basename or root-relative simple glob patterns
 * @returns {string}
 */
export function sourceSnippets(files, projectRoot, budget = 6000, excludePaths = []) {
  if (!Number.isSafeInteger(budget) || budget < 0 || budget > 12000) {
    throw new RangeError("snippetChars must be an integer from 0 to 12000");
  }
  if (!budget || !Array.isArray(files) || !files.length) return "";
  let root;
  try { root = realpathSync(projectRoot); } catch { return ""; }
  const lexicalRoot = resolve(projectRoot);
  const excludes = excludePaths.map((pattern) => {
    const normalized = pattern.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
    const patterns = [normalized];
    // A leading **/ also matches at the root, as in common exclude globs.
    if (normalized.startsWith("**/")) patterns.push(normalized.slice(3));
    return { rooted: normalized.includes("/"), regexes: patterns.map(_excludePatternToRegex) };
  });
  const candidatesByPath = new Map();
  let reads = 0;
  for (const file of files) {
    const ranges = Array.isArray(file?.ranges) ? file.ranges.filter((range) =>
      Array.isArray(range) && range.length === 2 && Number.isSafeInteger(range[0]) &&
      Number.isSafeInteger(range[1]) && range[0] >= 1 && range[1] >= range[0]
    ).map(([start, end]) => ({ start, end })) : [];
    if (!ranges.length) continue;
    try {
      const lexicalTarget = resolveWithinRoot(projectRoot, file.full_path);
      const rel = relative(lexicalRoot, lexicalTarget);
      if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) continue;
      const parts = rel.split(sep);
      const relativePath = parts.join("/");
      if (/[\x00-\x1f\x7f:]/.test(relativePath) || parts.some((part) => part.startsWith(".") || /^(?:node_modules|vendor|credentials?|secrets?|private|config|logs?)$/i.test(part)) ||
          /(?:secret|credential|token|password|\.pem$|\.key$)/i.test(relativePath)) continue;
      if (!/\.(?:[cm]?[jt]sx?|py|go|rs|java|cs|cpp|c|h|hpp|rb|php|swift|kt|scala|vue|svelte|css|scss|html)$/i.test(relativePath)) continue;
      const prefixes = parts.map((_, i) => parts.slice(0, i + 1).join("/"));
      if (excludes.some(({ rooted, regexes }) =>
        (rooted ? prefixes : parts).some((part) => regexes.some((rx) => rx.test(part)))
      )) continue;
      const target = resolveWithinRoot(root, relativePath);
      let cursor = root;
      let unsafe = false;
      for (const part of parts) {
        cursor = join(cursor, part);
        if (lstatSync(cursor).isSymbolicLink()) { unsafe = true; break; }
      }
      if (unsafe || !lstatSync(target).isFile()) continue;
      const canonical = realpathSync(target);
      const key = process.platform === "win32" ? canonical.toLowerCase() : canonical;
      if (key !== (process.platform === "win32" ? target.toLowerCase() : target)) continue;
      if (candidatesByPath.has(key)) {
        candidatesByPath.get(key).ranges.push(...ranges);
        continue;
      }
      if (reads >= 30) continue;
      // Count attempts too, so unreadable/unsafe content cannot bypass the read cap.
      reads++;
      const candidate = { relative: relativePath, ranges, lines: [] };
      candidatesByPath.set(key, candidate);
      const fd = openSync(target, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
      let data;
      try {
        const before = fstatSync(fd);
        if (!before.isFile() || before.size > 256 * 1024) continue;
        const buffer = Buffer.alloc(before.size);
        let size = 0;
        while (size < buffer.length) {
          const count = readSync(fd, buffer, size, buffer.length - size, size);
          if (!count) break;
          size += count;
        }
        const after = fstatSync(fd);
        if (size !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs) continue;
        data = buffer.subarray(0, size);
      } finally { closeSync(fd); }
      if (data.some((byte) => byte < 9 || (byte > 10 && byte < 13) || (byte > 13 && byte < 32) || byte === 127)) continue;
      const source = new TextDecoder("utf-8", { fatal: true }).decode(data);
      // Skip entire files with likely credentials, not just the requested lines.
      if (/(?:api[_ -]?key|secret|password|passwd|token|access[_ -]?token|refresh[_ -]?token|authorization|cookie|密码|密钥|令牌)\s*["']?\s*[:=：]\s*["'`][^"'`]+["'`]|\bBearer\s+[A-Za-z0-9._~+/-]{8,}|-----BEGIN [^-]*PRIVATE KEY-----|\b(?:sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9]{12,}|github_pat_[A-Za-z0-9_]+|npm_[A-Za-z0-9]{20,}|AKIA[A-Z0-9]{16})\b|\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+|:\/\/[^\s/]+:[^\s/]+@/i.test(source)) continue;
      candidate.lines = source ? source.split(/\r\n|\n|\r/) : [];
      if (/[\r\n]$/.test(source)) candidate.lines.pop();
    } catch { /* Missing, unreadable, unsafe or non-text files are not excerpts. */ }
  }
  const candidates = [];
  for (const { relative, ranges, lines } of candidatesByPath.values()) {
    const merged = [];
    for (const { start, end } of ranges.sort((a, b) => a.start - b.start || a.end - b.end)) {
      if (start > lines.length) continue;
      const clippedEnd = Math.min(end, lines.length);
      const previous = merged.at(-1);
      if (previous && start <= previous.end + 1) previous.end = Math.max(previous.end, clippedEnd);
      else merged.push({ start, end: clippedEnd });
    }
    const windows = merged.slice(0, 3).map(({ start, end }) => ({ start, count: 0,
      lines: lines.slice(start - 1, Math.min(end, start + 19)).map((line, i) => `${start + i}: ${line}`),
    }));
    if (windows.length) candidates.push({ relative, windows });
  }
  const render = (file, window, count) => count
    ? `\n\nSource excerpt: ${file.relative} (L${window.start}-${window.start + count - 1})\n${window.lines.slice(0, count).join("\n")}` : "";
  // Grow selections in place: refill must not erase previously selected windows.
  const fill = (file, allowance, firstOnly = false) => {
    let spent = 0;
    for (const window of file.windows) {
      while (window.count < window.lines.length) {
        const cost = render(file, window, window.count + 1).length - render(file, window, window.count).length;
        if (cost > allowance - spent) break;
        window.count++;
        spent += cost;
        if (firstOnly) return spent;
      }
    }
    return spent;
  };
  let remaining = budget;
  const share = candidates.length ? Math.floor(budget / candidates.length) : 0;
  for (const file of candidates) remaining -= fill(file, share);
  for (const file of candidates) {
    if (!file.windows.some((window) => window.count)) remaining -= fill(file, remaining, true);
  }
  for (const file of candidates) remaining -= fill(file, remaining);
  return candidates.flatMap((file) => file.windows.map((window) => render(file, window, window.count))).join("");
}

// ─── Prompt Builders ───────────────────────────────────────

/**
 * Build the Windsurf system prompt (detailed, [TOOL_CALLS] format).
 * @param {number} maxTurns
 * @param {number} maxCommands
 * @param {number} maxResults
 * @returns {string}
 */
export function buildWindsurfPrompt(maxTurns = 3, maxCommands = 8, maxResults = 10) {
  return WINDSURF_PROMPT_TEMPLATE
    .replaceAll("{max_turns}", String(maxTurns))
    .replaceAll("{max_commands}", String(maxCommands))
    .replaceAll("{max_results}", String(maxResults));
}

// ─── Prompt Templates ──────────────────────────────────────

const WINDSURF_PROMPT_TEMPLATE = `You are an expert software engineer, responsible for providing context \
to another engineer to solve a code issue in the current codebase. \
The user will present you with a description of the issue, and it is \
your job to provide a series of file paths with associated line ranges \
that contain ALL the information relevant to understand and correctly \
address the issue.

# IMPORTANT:
- A relevant file does not mean only the files that must be modified to \
solve the task. It means any file that contains information relevant to \
planning and implementing the fix, such as the definitions of classes \
and functions that are relevant to the pieces of code that will have to \
be modified.
- You should include enough context around the relevant lines to allow \
the engineer to understand the task correctly. You must include ENTIRE \
semantic blocks (functions, classes, definitions, etc). For example:
If addressing the issue requires modifying a method within a class, then \
you should include the entire class definition, not just the lines around \
the method we want to modify.
- NEVER truncate these blocks unless they are very large (hundreds of \
lines or more, in which case providing only a relevant portion of the \
block is acceptable).
- Your job is to essentially alleviate the job of the other engineer by \
giving them a clean starting context from which to start working. More \
precisely, you should minimize the number of files the engineer has to \
read to understand and solve the task correctly (while not providing \
irrelevant code snippets).

# ENVIRONMENT
- Working directory: /codebase. Make sure to run commands in this \
directory, not \`.
- Tool access: use the restricted_exec tool ONLY
- Allowed sub-commands (schema-enforced):
  - rg: Search for patterns in files using ripgrep
    - Required: pattern (string), path (string)
    - Optional: include (array of globs), exclude (array of globs)
  - readfile: Read contents of a file with optional line range
    - Required: file (string)
    - Optional: start_line (int), end_line (int) — 1-indexed, inclusive
  - tree: Display directory structure as a tree
    - Required: path (string)
    - Optional: levels (int)

# THINKING RULES
- Think step-by-step. Plan, reason, and reflect before each tool call.
- Use tool calls liberally and purposefully to ground every conclusion \
in real code, not assumptions.
- If a command fails, rethink and try something different; do not \
complain to the user.

# FAST-SEARCH DEFAULTS (optimize rg/tree on large repos)
- Start NARROW, then widen only if needed. Prefer searching likely code \
roots first (e.g., \`src/\`, \`lib/\`, \`app/\`, \`packages/\`, \`services/\`) \
instead of \`/codebase\`.
- Prefer fixed-string search for literals: escape patterns or keep regex \
simple. Use smart case; avoid case-insensitive unless necessary.
- Prefer file-type filters and globs (in include) over full-repo scans.
- Default EXCLUDES for speed (apply via the exclude array): \
node_modules, .git, dist, build, coverage, .venv, venv, target, out, \
.cache, __pycache__, vendor, deps, third_party, logs, data, *.min.*
- Skip huge files where possible; when opening files, prefer reading \
only relevant ranges with readfile.
- Limit directory traversal with tree levels to quickly orient before \
deeper inspection.

# SOME EXAMPLES OF WORKFLOWS
- MAP – Use \`tree\` with small levels; \`rg\` on likely roots to grasp \
structure and hotspots.
- ANCHOR – \`rg\` for problem keywords and anchor symbols; restrict by \
language globs via include.
- TRACE – Follow imports with targeted \`rg\` in narrowed roots; open \
files with \`readfile\` scoped to entire semantic blocks.
- VERIFY – Confirm each candidate path exists by reading or additional \
searches; drop false positives (tests, vendored, generated) unless they \
must change.

# TOOL USE GUIDELINES
- You must use a SINGLE restricted_exec call in your answer, that lets \
you execute at most {max_commands} commands in a single turn. Each command must be \
an object with a \`type\` field of \`rg\`, \`readfile\`, or \`tree\` and the appropriate fields for that type.
- Example restricted_exec usage:
[TOOL_CALLS]restricted_exec[ARGS]{{
  "command1": {{
    "type": "rg",
    "pattern": "Controller",
    "path": "/codebase/slime",
    "include": ["**/*.py"],
    "exclude": ["**/node_modules/**", "**/.git/**", "**/dist/**", \
"**/build/**", "**/.venv/**", "**/__pycache__/**"]
  }},
  "command2": {{
    "type": "readfile",
    "file": "/codebase/slime/train.py",
    "start_line": 1,
    "end_line": 200
  }},
  "command3": {{
    "type": "tree",
    "path": "/codebase/slime/",
    "levels": 2
  }}
}}
- You have at most {max_turns} turns to interact with the environment by calling \
tools, so issuing multiple commands at once is necessary and encouraged \
to speed up your research.
- Each command result may be truncated to 50 lines; prefer multiple \
targeted reads/searches to build complete context.
- DO NOT EVER USE MORE THAN {max_commands} commands in a single turn, or you will \
be penalized.

# ANSWER FORMAT (strict format, including tags)
- You will output an XML structure with a root element "ANSWER" \
containing "file" elements. Each "file" element will have a "path" \
attribute and contain "range" elements.
- You will output this as your final response.
- The line ranges must be inclusive.

Output example inside the "answer" tool argument:
<ANSWER>
  <file path="/codebase/info_theory/formulas/entropy.py">
    <range>10-60</range>
    <range>150-210</range>
  </file>
  <file path="/codebase/info_theory/data_structures/bits.py">
    <range>1-40</range>
    <range>110-170</range>
  </file>
</ANSWER>


Remember: Prefer narrow, fixed-string, and type-filtered searches with \
aggressive excludes and size/depth limits. Widen scope only as needed. \
Use the restricted tools available to you, and output your answer in \
exactly the specified format.

# NO RESULTS POLICY
If after thorough searching you are confident that NO relevant files exist \
for the given query (e.g., the function/class/concept does not exist in the \
codebase), you MUST return an empty ANSWER:
<ANSWER></ANSWER>
Do NOT return irrelevant files (such as entry points or config files) just \
to provide some output. An empty answer is always better than a misleading one.

# RESULT COUNT
Aim to return at most {max_results} files in your answer. Focus on the most \
relevant files first. If fewer files are relevant, return fewer.
`;
