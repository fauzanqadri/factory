/**
 * Skill loader. Node-only: it reads the filesystem, so it must never be reachable from the
 * workflow bundle or the package root. Only ./server.js imports and re-exports it.
 *
 * A skill is a folder with a SKILL.md. Only files reachable from SKILL.md load: relative
 * Markdown links resolve against the file that holds them, bare names such as `eval.md`
 * resolve against the skill root (then the referencing file's folder). Everything else in
 * the folder (evals/, agents/openai.yaml, stray files) is never read.
 */
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readFile, realpath, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import type { Registry } from "./registry.js";
import type { LoadedSkill, SkillDecl } from "./types.js";

export interface SkillLimits {
  /** Longest chain of references from SKILL.md. */
  maxDepth: number;
  maxFiles: number;
  maxFileBytes: number;
  maxSkillBytes: number;
  /** Sum of all skills attached to one stage: what is prepended to every turn of it. */
  maxStageBytes: number;
}

export const DEFAULT_SKILL_LIMITS: SkillLimits = {
  maxDepth: 5,
  maxFiles: 40,
  maxFileBytes: 64 * 1024,
  maxSkillBytes: 200 * 1024,
  maxStageBytes: 400 * 1024,
};

export interface LoadSkillsOptions {
  /** App root: `{ path }` sources and `skills.lock.json` resolve against it. */
  root: string;
  /** Default: "enforce" when the lockfile exists, otherwise "off". */
  lock?: "enforce" | "warn" | "off";
  lockPath?: string;
  limits?: Partial<SkillLimits>;
}

export interface LoadedSkills {
  skills: Map<string, LoadedSkill>;
  warnings: string[];
}

/** A skill that is unsafe or over a limit. Always fails worker start. */
export class SkillError extends Error {}

const TEXT_EXT = new Set([".md", ".txt"]);
const ENTRY = "SKILL.md";
const SCHEME = /^[a-z][a-z0-9+.-]*:/i;

// [text](target "title") and ![alt](target), plus reference definitions `[id]: target`.
const INLINE_LINK = /!?\[[^\]]*\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g;
const REF_LINK = /^[ ]{0,3}\[[^\]]+\]:\s*<?(\S+?)>?(?:\s|$)/gm;
// A bare file name in prose or backticks. Not preceded by a path or scheme character, so
// absolute paths, `~/x.md` and `owner/repo@skill` never match.
const BARE = /(?<![\w./\\@:~-])((?:[\w.-]+\/)*[\w-][\w.-]*\.(?:md|txt))(?![\w-])/gi;
const URL_RE = /[a-z][a-z0-9+.-]*:\/\/\S+/gi;
const OTHER_SKILL = /[\w.-]+\/[\w.-]+@([\w-]+(?:\.[\w-]+)*)/g;

const toPosix = (p: string) => p.split(path.sep).join("/");
const escapes = (rel: string) => rel === ".." || rel.startsWith(".." + path.sep) || path.isAbsolute(rel);
const hasTextExt = (p: string) => TEXT_EXT.has(path.extname(p).toLowerCase());

type ReadResult =
  | { kind: "ok"; abs: string; rel: string; content: string }
  | { kind: "missing" }
  | { kind: "skip"; reason: string };

/**
 * The one place a path becomes file content. Anything unsafe throws; a file that is merely
 * absent or not loadable by policy (dotfile, directory) comes back as missing/skip.
 */
async function readSafe(realRoot: string, abs: string, maxBytes: number, ctx: string): Promise<ReadResult> {
  if (abs.includes("\0")) throw new SkillError(`${ctx}: reference contains a NUL byte`);
  const rel = path.relative(realRoot, abs);
  if (rel === "" || escapes(rel)) throw new SkillError(`${ctx}: reference leaves the skill folder`);
  if (!hasTextExt(rel)) return { kind: "skip", reason: "not a .md/.txt file" };
  const segs = rel.split(path.sep);
  if (segs.some((s) => s.startsWith("."))) return { kind: "skip", reason: "hidden file or folder" };

  // Walk down from the (real) root: no component may be a symlink.
  let cur = realRoot;
  let last: Awaited<ReturnType<typeof lstat>> | undefined;
  for (const s of segs) {
    cur = path.join(cur, s);
    try { last = await lstat(cur); }
    catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTDIR") return { kind: "missing" };
      throw e;
    }
    if (last.isSymbolicLink()) throw new SkillError(`${ctx}: ${toPosix(rel)} goes through a symlink`);
  }
  if (last!.isDirectory()) return { kind: "skip", reason: "is a directory" };
  if (!last!.isFile()) throw new SkillError(`${ctx}: ${toPosix(rel)} is not a regular file`);

  // Open without following links or blocking, then check the handle, not the path.
  const fh = await open(abs, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const st = await fh.stat();
    if (!st.isFile()) throw new SkillError(`${ctx}: ${toPosix(rel)} is not a regular file`);
    if (st.size > maxBytes) throw new SkillError(`${ctx}: ${toPosix(rel)} is ${st.size} bytes, over the ${maxBytes} byte file limit`);
    const buf = Buffer.alloc(maxBytes + 1);
    const { bytesRead } = await fh.read(buf, 0, maxBytes + 1, 0);
    if (bytesRead > maxBytes) throw new SkillError(`${ctx}: ${toPosix(rel)} grew past the ${maxBytes} byte file limit`);
    const real = await realpath(abs); // canonical spelling (case-insensitive file systems)
    return { kind: "ok", abs: real, rel: toPosix(path.relative(realRoot, real)), content: buf.subarray(0, bytesRead).toString("utf8") };
  } finally {
    await fh.close();
  }
}

const exists = (abs: string) => lstat(abs).then(() => true, () => false);

function decode(s: string): string {
  try { return decodeURIComponent(s); } catch { return s; }
}

/** Minimal frontmatter: top-level `key: value` lines, with `>`/`|` or empty values taking the indented lines below. */
export function parseFrontmatter(text: string): Record<string, string> {
  const m = text.replace(/^﻿/, "").match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  const out: Record<string, string> = {};
  if (!m) return out;
  const lines = m[1]!.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const kv = lines[i]!.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!kv) continue;
    let value = kv[2]!.trim();
    if (value === "" || value === ">" || value === "|" || value === ">-" || value === "|-") {
      const parts: string[] = [];
      while (i + 1 < lines.length && /^\s+\S/.test(lines[i + 1]!)) parts.push(lines[++i]!.trim());
      value = parts.join(" ");
    }
    out[kv[1]!] = value.replace(/^(["'])(.*)\1$/, "$2");
  }
  return out;
}

type Ref = { kind: "link" | "bare"; ref: string };

function extractRefs(text: string): Ref[] {
  const refs: Ref[] = [];
  for (const re of [INLINE_LINK, REF_LINK]) {
    for (const m of text.matchAll(re)) refs.push({ kind: "link", ref: m[1]! });
  }
  // Links and URLs are handled above; blank them so their targets don't double-match as bare names.
  const prose = text.replace(INLINE_LINK, " ").replace(REF_LINK, " ").replace(URL_RE, " ");
  for (const m of prose.matchAll(BARE)) refs.push({ kind: "bare", ref: m[1]! });
  return refs;
}

async function resolveRoot(decl: SkillDecl, appRoot: string): Promise<string> {
  const { source } = decl;
  let dir: string;
  let boundary: string | undefined;
  if ("path" in source) {
    dir = path.resolve(appRoot, source.path);
  } else {
    let pkgJson: string;
    try { pkgJson = createRequire(path.join(appRoot, "noop.js")).resolve(`${source.package}/package.json`); }
    catch { throw new SkillError(`skill "${decl.name}": cannot resolve package "${source.package}" (is it installed, and does it export ./package.json?)`); }
    const pkgDir = path.dirname(pkgJson);
    const meta = JSON.parse(await readFile(pkgJson, "utf8")) as { skill?: unknown };
    const sub = typeof meta.skill === "string" ? meta.skill : "skill";
    dir = path.resolve(pkgDir, sub);
    boundary = await realpath(pkgDir);
  }
  let real: string;
  try { real = await realpath(dir); }
  catch { throw new SkillError(`skill "${decl.name}": folder ${dir} does not exist`); }
  if (boundary && escapes(path.relative(boundary, real))) throw new SkillError(`skill "${decl.name}": the package's skill folder is outside the package`);
  return real;
}

async function loadOne(decl: SkillDecl, appRoot: string, limits: SkillLimits, warn: (m: string) => void, registered: Set<string>): Promise<LoadedSkill> {
  const realRoot = await resolveRoot(decl, appRoot);
  const label = `skill "${decl.name}"`;
  const files = new Map<string, string>();
  let total = 0;
  const unresolved = new Set<string>();
  const queue: Array<{ abs: string; depth: number; from: string; required: boolean }> = [
    { abs: path.join(realRoot, ENTRY), depth: 0, from: "the skill", required: true },
    ...(decl.options.include ?? []).map((f) => ({ abs: path.resolve(realRoot, f), depth: 1, from: "include", required: true })),
  ];

  while (queue.length) {
    const item = queue.shift()!;
    const ctx = `${label} (${item.from})`;
    const r = await readSafe(realRoot, item.abs, limits.maxFileBytes, ctx);
    if (r.kind !== "ok") {
      const name = toPosix(path.relative(realRoot, item.abs));
      if (item.required) throw new SkillError(`${ctx}: ${name} ${r.kind === "missing" ? "does not exist" : `cannot be loaded (${r.reason})`}`);
      if (!unresolved.has(name)) { unresolved.add(name); warn(`${label}: ${item.from} references ${name}, which ${r.kind === "missing" ? "does not exist" : `is not loaded (${r.reason})`}`); }
      continue;
    }
    if (files.has(r.rel)) continue;
    if (files.size >= limits.maxFiles) throw new SkillError(`${label}: more than ${limits.maxFiles} files are reachable`);
    total += Buffer.byteLength(r.content);
    if (total > limits.maxSkillBytes) throw new SkillError(`${label}: reachable files exceed ${limits.maxSkillBytes} bytes (at ${r.rel})`);
    files.set(r.rel, r.content);

    for (const m of r.content.matchAll(OTHER_SKILL)) {
      const other = m[1]!;
      if (other !== decl.name && !registered.has(other)) warn(`${label}: ${r.rel} mentions skill "${other}", which is not registered here`);
    }

    const refs = extractRefs(r.content);
    const fileDir = path.dirname(r.abs);
    for (const { kind, ref } of refs) {
      let target = decode(ref);
      if (kind === "link") {
        if (target.startsWith("#") || target.startsWith("//") || SCHEME.test(target)) continue;
        target = target.replace(/[#?].*$/, "");
        if (target === "" || !hasTextExt(target)) continue;
        if (path.isAbsolute(target)) throw new SkillError(`${label} (${r.rel}): absolute path ${ref} is not allowed`);
        enqueue(path.resolve(fileDir, target), r.rel);
      } else {
        if (!hasTextExt(target)) continue;
        const candidates = [...new Set([path.resolve(realRoot, target), path.resolve(fileDir, target)])];
        for (const c of candidates) if (escapes(path.relative(realRoot, c))) throw new SkillError(`${label} (${r.rel}): ${ref} leaves the skill folder`);
        const found: string[] = [];
        for (const c of candidates) if (await exists(c)) found.push(c);
        if (found.length === 0) {
          if (!unresolved.has(target)) { unresolved.add(target); warn(`${label}: ${r.rel} mentions ${target}, which does not exist`); }
          continue;
        }
        if (found.length > 1) warn(`${label}: ${r.rel} mentions ${target}, which exists in more than one folder; using the one at the skill root`);
        enqueue(found[0]!, r.rel);
      }
    }

    function enqueue(abs: string, from: string) {
      if (item.depth + 1 > limits.maxDepth) throw new SkillError(`${label}: ${from} references ${toPosix(path.relative(realRoot, abs))}, deeper than the ${limits.maxDepth} level limit`);
      queue.push({ abs, depth: item.depth + 1, from, required: false });
    }
  }

  const entry = files.get(ENTRY)!;
  const fm = parseFrontmatter(entry);
  if (fm.name !== decl.name) throw new SkillError(`${label}: SKILL.md frontmatter name is ${fm.name === undefined ? "missing" : `"${fm.name}"`}, expected "${decl.name}"`);

  const ordered = [...files.entries()].sort(([a], [b]) => (a === ENTRY ? -1 : b === ENTRY ? 1 : a < b ? -1 : a > b ? 1 : 0));
  const hash = createHash("sha256");
  for (const [p, c] of [...files.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) hash.update(p).update("\0").update(c).update("\0");
  return {
    name: decl.name,
    description: fm.description ?? "",
    hash: hash.digest("hex"),
    files: ordered.map(([p, content]) => ({ path: p, content })),
  };
}

interface LockFile {
  skills: Record<string, { source: SkillDecl["source"]; hash: string }>;
}

const lockPathFor = (o: LoadSkillsOptions) => o.lockPath ?? path.join(o.root, "skills.lock.json");

async function readLock(file: string): Promise<LockFile | undefined> {
  try { return JSON.parse(await readFile(file, "utf8")) as LockFile; }
  catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new SkillError(`cannot read ${file}: ${(e as Error).message}`);
  }
}

/** Write `skills.lock.json` for the loaded skills (used by tests and the future `skill add` CLI). */
export async function writeLock(registry: Registry, loaded: LoadedSkills, file: string): Promise<void> {
  const lock: LockFile = { skills: {} };
  for (const d of registry.getSkillDecls()) lock.skills[d.name] = { source: d.source, hash: loaded.skills.get(d.name)!.hash };
  await writeFile(file, JSON.stringify(lock, null, 2) + "\n");
}

/** Load every registered skill; throws SkillError on anything unsafe, over a limit, or not matching the lockfile. */
export async function loadSkills(registry: Registry, options: LoadSkillsOptions): Promise<LoadedSkills> {
  const limits = { ...DEFAULT_SKILL_LIMITS, ...options.limits };
  const warnings: string[] = [];
  const warn = (m: string) => warnings.push(m);
  const decls = registry.getSkillDecls();
  const registered = new Set(decls.map((d) => d.name));
  const skills = new Map<string, LoadedSkill>();
  for (const d of decls) skills.set(d.name, await loadOne(d, options.root, limits, warn, registered));

  return verifyAndFinish(registry, options, limits, skills, warnings);
}

async function verifyAndFinish(registry: Registry, options: LoadSkillsOptions, limits: SkillLimits, skills: Map<string, LoadedSkill>, warnings: string[]): Promise<LoadedSkills> {
  // Per-stage budget: what each turn of the stage carries.
  for (const s of registry.getStages()) {
    const bytes = (s.skills ?? []).reduce((n, k) => n + (skills.get(k)?.files.reduce((m, f) => m + Buffer.byteLength(f.content), 0) ?? 0), 0);
    if (bytes > limits.maxStageBytes) throw new SkillError(`stage "${s.name}": its skills total ${bytes} bytes, over the ${limits.maxStageBytes} byte stage budget`);
  }

  const file = lockPathFor(options);
  const lock = await readLock(file);
  const mode = options.lock ?? (lock ? "enforce" : "off");
  if (mode !== "off") {
    const problems: string[] = [];
    if (!lock) problems.push(`${file} does not exist`);
    for (const [name, sk] of skills) {
      const entry = lock?.skills[name];
      if (!entry) problems.push(`skill "${name}" is not in the lockfile`);
      else if (entry.hash !== sk.hash) problems.push(`skill "${name}" changed since it was locked (lock ${entry.hash.slice(0, 12)}, now ${sk.hash.slice(0, 12)})`);
    }
    if (problems.length) {
      if (mode === "enforce") throw new SkillError(`skills do not match ${file}:\n- ${problems.join("\n- ")}`);
      for (const p of problems) warnings.push(`lockfile: ${p}`);
    }
  }
  return { skills, warnings };
}
