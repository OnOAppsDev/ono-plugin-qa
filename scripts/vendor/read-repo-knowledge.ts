/**
 * read-repo-knowledge.ts
 *
 * Deterministic reader for the repository-knowledge manifest at
 * `<target-root>/.ono/repo-knowledge.json`, produced by the sibling
 * ono-project-inspector plugin. See docs/repo-knowledge-contract.md for the
 * schema and the obligations this plugin accepts as a consumer.
 *
 * This is the ONLY component in this plugin that parses the manifest. Commands,
 * skills, and agents receive its normalized output via the
 * `repo-knowledge-consumer` skill and never read the file themselves — so the
 * contract lives in exactly one place and structured facts are never parsed by
 * an LLM.
 *
 * CRITICAL: this helper ALWAYS exits 0 and ALWAYS prints a valid JSON object,
 * including when the manifest is absent, malformed, or written by a newer
 * schema. A missing manifest is a normal state, not an error — that is what
 * keeps every command byte-for-byte backward compatible on a repository that
 * was never inspected. Callers branch on `available`, never on the exit code.
 *
 * Runtime: Node >= 23.6 (`node scripts/read-repo-knowledge.ts`) or Bun. No
 * external deps, and it does NOT rely on CLAUDE_PLUGIN_ROOT or
 * CLAUDE_PROJECT_DIR.
 *
 * Node emits an ExperimentalWarning on stderr for direct .ts execution, so the
 * `--no-warnings` flag is part of the canonical invocation below — without it,
 * a caller that merges stderr into stdout (e.g. `2>&1`) would be handed
 * non-JSON, defeating the always-valid-JSON guarantee above.
 *
 * Stage B adds the consumer side of the generic surface and capability model
 * (producer 0.11.0): surfaces, shared code, surface-scoped conventions, capabilities and
 * first-degree capability relationships. They are reported as `extendedCategories`, apart
 * from the seven base categories, so an older manifest yields exactly the output it always
 * did. Queries resolve one surface, one capability and its DIRECT relationships, and the
 * surfaces/capabilities a set of paths falls under — by deterministic identity only, never
 * by similarity, and never beyond the first degree. Stale facts are re-checked against the
 * current source; the current source always wins.
 *
 * Usage:
 *   node --no-warnings scripts/read-repo-knowledge.ts [target-root]   (default: CWD)
 *        [--surface <id>] [--capability <id-or-name>] [--path <repo-relative path>]... [--verify]
 */

import { readFileSync, existsSync, realpathSync } from "fs";
import { createHash } from "crypto";
import { execFileSync } from "child_process";
import { join, resolve, sep } from "path";

/** Highest contract version this plugin understands. A higher one is treated as absent. */
export const MAX_SUPPORTED_SCHEMA_VERSION = 1;

const CLAUDE_WORKTREE_MARKER = `${sep}.claude${sep}worktrees${sep}`;

/** Every category in contract v1, in a stable order. */
const ALL_CATEGORIES = [
  "stack",
  "commands",
  "structure",
  "inventory",
  "conventions",
  "integrations",
  "auditTopics",
] as const;

/** Which source document backs each category, for stale-artifact attribution. */
const CATEGORY_SOURCE: Record<string, string> = {
  stack: "CLAUDE.md",
  commands: "CLAUDE.md",
  structure: "CLAUDE.md",
  inventory: "docs/project/components.md",
  conventions: "docs/project/patterns.md",
  integrations: "docs/project/integrations.md",
  auditTopics: "AUDIT.md",
};

/**
 * Stage 4B. Paths the producer owns, exactly as docs/repo-knowledge-contract.md
 * § "Producer-side source drift" lists them (pinned by repo-knowledge-staleness.test.ts).
 * A change confined to these is the inspector's own bookkeeping, never source drift.
 */
export const INSPECTOR_OWNED_PATHS = [
  ".ono/**",
  "CLAUDE.md",
  "AUDIT.md",
  "CLAUDE.md.bak",
  "AUDIT.md.bak",
  "docs/project/**",
  "audits/**",
] as const;

function isInspectorOwned(rel: string): boolean {
  return INSPECTOR_OWNED_PATHS.some((p) => (p.endsWith("/**") ? rel.startsWith(p.slice(0, -2)) : rel === p));
}

/**
 * Stage 4B. Mirrors the producer's build/dependency/CI manifest signal (Stage 4A
 * `inspection-state.ts`): a change to one can move what CLAUDE.md records as stack
 * and commands, so the analysis-backed categories must be verified on use.
 */
const ANALYSIS_MANIFEST_BASENAMES = new Set([
  "package.json", "pnpm-workspace.yaml", "lerna.json", "nx.json", "turbo.json",
  "Podfile", "Package.swift", "Cartfile", "project.pbxproj",
  "build.gradle", "build.gradle.kts", "settings.gradle", "settings.gradle.kts",
  "pom.xml", "Cargo.toml", "go.mod", "pyproject.toml", "setup.py", "setup.cfg",
  "requirements.txt", "Pipfile", "Gemfile", "pubspec.yaml", "composer.json",
  "Makefile", "Dockerfile", "docker-compose.yml", "docker-compose.yaml",
  ".gitlab-ci.yml", "Jenkinsfile",
  // Stage A: files that declare targets / surfaces / flavors / packaging — Xcode project
  // generators, Android app manifests, RN/Expo app config, Smart TV app descriptors.
  "project.yml", "Project.swift", "Workspace.swift", "AndroidManifest.xml",
  "app.json", "eas.json", "config.xml", "appinfo.json",
]);

function isAnalysisManifest(rel: string): boolean {
  const base = rel.split("/").pop() ?? rel;
  return (
    ANALYSIS_MANIFEST_BASENAMES.has(base) ||
    /\.csproj$/.test(base) ||
    /\.(xcscheme|xcconfig)$/.test(base) ||
    /^(app\.config|vite\.config|webpack\.config|next\.config)\.(js|cjs|mjs|ts)$/.test(base) ||
    rel.startsWith(".github/workflows/") ||
    rel.startsWith(".circleci/")
  );
}

/** Source-backed categories, split by which inspection stage regenerates them. */
const ANALYSIS_BACKED = ["stack", "commands", "structure"];
const DOCS_BACKED = ["inventory", "conventions", "integrations"];

const MAX_LISTED_FILES = 50;

const REFRESH_RECOMMENDATION =
  "Run /inspect and choose Refresh Project Knowledge to regenerate source-backed knowledge.";

export type SourceDriftStatus = "COMPLETE" | "REFRESH_RECOMMENDED" | "BASELINE_UNKNOWN";

export interface SourceDrift {
  /** The producer's Stage 4A vocabulary, derived here the same way (it is never persisted). */
  status: SourceDriftStatus;
  knowledgeHead: string | null;
  currentHead: string | null;
  reason: string;
  changedSourceCount: number;
  /** Sorted; capped at 50 — changedSourceCount is the full count. */
  changedSourceFiles: string[];
  analysisSignals: string[];
  /**
   * Stage B. Change-surface attribution over the FULL changed-file list, as the producer
   * computes it: the recorded surfaces, capabilities and relationships whose source roots or
   * evidence contain a changed file. A hint for verify-on-use, never a verdict.
   */
  affectedSurfaces: string[];
  affectedCapabilities: string[];
  affectedRelationships: string[];
}

type Unavailable = "absent" | "unparseable" | "invalid" | "schema-too-new" | "worktree" | "root-not-found";
type Freshness = "fresh" | "stale-head" | "stale-artifacts" | "unknown";

export interface KnowledgeResult {
  available: boolean;
  reason: Unavailable | null;
  schemaVersion: number | null;
  producedBy: { plugin: string; version: string } | null;
  generatedAt: string | null;
  freshness: Freshness | null;
  staleDetail: string | null;
  /** Categories the consumer may reuse — as-is (`trustedCategories`) or as a starting point (`verifyOnUse`). */
  usableCategories: string[];
  /** Stage 4B. Usable categories that are authoritative as-is. */
  trustedCategories: string[];
  /**
   * Stage 4B. Usable categories that source drift may have moved: reuse them as a starting
   * point only, verify each fact actually used against the current repository, and derive
   * it live when verification fails. Never authoritative as-is.
   */
  verifyOnUse: string[];
  /** Stage 4B. Source drift since `fingerprint.knowledgeHead`; null when knowledge is unavailable. */
  sourceDrift: SourceDrift | null;
  /** Stage 4B. `/inspect` → Refresh Project Knowledge when source drift is possible; otherwise null. */
  refreshRecommendation: string | null;
  /** Categories the consumer MUST derive itself. */
  deriveLive: string[];
  /** The manifest, verbatim, when available. Never partially rewritten. */
  knowledge: Record<string, any> | null;
  /** Always true — a reminder that platformHints is never authoritative (contract obligation 8). */
  platformHintsAreAdvisory: true;
  /**
   * Stage B. The additive surface and capability categories, reported apart from the seven
   * base categories so an older manifest's output is unchanged. `trusted` | `verifyOnUse`
   * | `deriveLive`, with the reason.
   */
  extendedCategories: { surfaces: ExtendedCategory; capabilities: ExtendedCategory };
  /** Validated surfaces, or null when the category is derive-live. */
  surfaces: Surface[] | null;
  sharedCode: SharedCode[] | null;
  capabilities: Capability[] | null;
  /** Structurally valid first-degree relationships, or null when capabilities are derive-live. */
  capabilityRelationships: Relationship[] | null;
  /** Relationships rejected individually (unknown type, missing endpoint, no evidence) — derive live. */
  invalidRelationships: Array<{ id: string; reason: string }>;
  /** Always true — surfaces scope a confirmation, never replace it (contract obligation 9). */
  surfacesAreAdvisory: true;
  /** One line for a command to show the developer. */
  summary: string;
}

export type ExtendedStatus = "trusted" | "verifyOnUse" | "deriveLive";
export interface ExtendedCategory {
  status: ExtendedStatus;
  reason: string;
}

export interface Surface {
  id: string;
  platform: string | null;
  formFactor: string | null;
  buildSelector: string | null;
  sourceRoots: string[];
  sharedWith: string[];
  packaging: string | null;
  minimumRuntime: string | null;
  evidence: string[];
}
export interface SharedCode {
  root: string;
  sharedBy: string[];
  mechanism: string | null;
  evidence: string[];
}
export interface NamedRef {
  name: string;
  anchor: string | null;
}
export interface Capability {
  id: string;
  name: string | null;
  anchor: string;
  surfaceScope: string;
  surfaces: string[];
  sourceRoots: Array<{ path: string; surface: string | null }>;
  entryPoints: string[];
  components: NamedRef[];
  services: string[];
  routes: string[];
  dataDependencies: NamedRef[];
  stateOwnership: string[];
  tests: string[];
  evidence: string[];
  relationships: string[];
}
export interface Relationship {
  id: string;
  from: string;
  type: string;
  to: string;
  evidenceKind: string;
  evidence: string[];
  anchor: string;
}

/** Contract v1's relationship vocabulary. Anything else is rejected, never guessed at. */
export const RELATIONSHIP_TYPES = [
  "depends_on", "used_by", "contains", "navigates_to", "shares_component_with",
  "shares_state_with", "reads_from", "writes_to", "covered_by", "related_to",
] as const;
export const EVIDENCE_KINDS = [
  "import", "navigation-route", "shared-component", "shared-state", "shared-service",
  "shared-data-source", "test", "repository-doc",
] as const;

const DERIVE_LIVE_UNAVAILABLE: ExtendedCategory = { status: "deriveLive", reason: "Repository knowledge is unavailable." };

function unavailable(reason: Unavailable, summary: string, schemaVersion: number | null = null): KnowledgeResult {
  return {
    available: false,
    reason,
    schemaVersion,
    producedBy: null,
    generatedAt: null,
    freshness: null,
    staleDetail: null,
    usableCategories: [],
    trustedCategories: [],
    verifyOnUse: [],
    sourceDrift: null,
    refreshRecommendation: null,
    deriveLive: [...ALL_CATEGORIES],
    knowledge: null,
    platformHintsAreAdvisory: true,
    extendedCategories: { surfaces: DERIVE_LIVE_UNAVAILABLE, capabilities: DERIVE_LIVE_UNAVAILABLE },
    surfaces: null,
    sharedCode: null,
    capabilities: null,
    capabilityRelationships: null,
    invalidRelationships: [],
    surfacesAreAdvisory: true,
    summary,
  };
}

function git(targetRoot: string, args: string[]): string | null {
  try {
    return execFileSync("git", args, {
      cwd: targetRoot,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

function currentHead(targetRoot: string): string | null {
  return git(targetRoot, ["rev-parse", "HEAD"]) || null;
}

/**
 * Stage 4B. Derives source drift since the knowledge-authoring HEAD exactly as the
 * producer's Stage 4A `detect` does: diff `knowledgeHead..HEAD`, ignore Inspector-owned
 * paths, and flag build/dependency manifests and top-level entries as analysis signals.
 */
function computeSourceDrift(targetRoot: string, knowledgeHead: string | null, head: string | null, model: KnowledgeModel = EMPTY_MODEL): SourceDrift {
  const base = {
    knowledgeHead, currentHead: head, changedSourceCount: 0, changedSourceFiles: [] as string[], analysisSignals: [] as string[],
    affectedSurfaces: [] as string[], affectedCapabilities: [] as string[], affectedRelationships: [] as string[],
  };
  const unknown = (reason: string): SourceDrift => ({ ...base, status: "BASELINE_UNKNOWN", reason });

  if (!knowledgeHead) {
    return unknown("No knowledge-authoring HEAD recorded (fingerprint.knowledgeHead absent or null). Freshness of source-backed knowledge cannot be established.");
  }
  if (!head) return unknown("Current git HEAD cannot be determined.");
  if (git(targetRoot, ["cat-file", "-e", `${knowledgeHead}^{commit}`]) === null) {
    return unknown(`Recorded knowledgeHead ${knowledgeHead.slice(0, 12)} is not in this repository's history (rewritten or shallow).`);
  }
  if (knowledgeHead === head) {
    return { ...base, status: "COMPLETE", reason: "Knowledge was generated at the current HEAD." };
  }

  const diff = git(targetRoot, ["diff", "--name-only", "--no-renames", knowledgeHead, head]);
  if (diff === null) return unknown("git diff between knowledgeHead and HEAD failed.");
  const changed = Array.from(new Set(diff.split("\n").filter((l) => l.length > 0)))
    .filter((rel) => !isInspectorOwned(rel))
    .sort();
  if (changed.length === 0) {
    return { ...base, status: "COMPLETE", reason: "Only Inspector-owned artifacts changed since knowledge was generated." };
  }

  const topAt = (rev: string): Set<string> =>
    new Set((git(targetRoot, ["ls-tree", "--name-only", rev]) ?? "").split("\n").filter(Boolean));
  const topBefore = topAt(knowledgeHead);
  const topNow = topAt(head);
  const signals = new Set<string>();
  for (const rel of changed) {
    if (isAnalysisManifest(rel)) signals.add(`build/dependency manifest changed: ${rel}`);
    const top = rel.split("/")[0];
    if (!topBefore.has(top)) signals.add(`top-level entry added: ${top}`);
    else if (!topNow.has(top)) signals.add(`top-level entry removed: ${top}`);
  }
  const attribution = attribute(changed, model);
  for (const sig of attribution.surfaceSignals) signals.add(sig);

  return {
    ...base,
    status: "REFRESH_RECOMMENDED",
    reason: `${changed.length} source file(s) changed since knowledge was generated.`,
    changedSourceCount: changed.length,
    changedSourceFiles: changed.slice(0, MAX_LISTED_FILES),
    analysisSignals: Array.from(signals).sort(),
    affectedSurfaces: attribution.affectedSurfaces,
    affectedCapabilities: attribution.affectedCapabilities,
    affectedRelationships: attribution.affectedRelationships,
  };
}

/* ------------------------------------------------ Stage B: the surface & capability model */

interface KnowledgeModel {
  surfaces: Surface[];
  sharedCode: SharedCode[];
  capabilities: Capability[];
  relationships: Relationship[];
}
const EMPTY_MODEL: KnowledgeModel = { surfaces: [], sharedCode: [], capabilities: [], relationships: [] };

/** The producer's `isUnder`, verbatim in behaviour: a root ending in `/` is a prefix. */
export function isUnder(rel: string, root: string): boolean {
  if (root.endsWith("/")) return rel.startsWith(root);
  return rel === root || rel.startsWith(`${root}/`);
}

/** An evidence ref is `path` or `path::token`. */
export function parseEvidenceRef(ref: string): { path: string; token: string | null } {
  const i = ref.indexOf("::");
  return i < 0 ? { path: ref.trim(), token: null } : { path: ref.slice(0, i).trim(), token: ref.slice(i + 2) };
}

/**
 * Stage B. Which recorded surfaces, capabilities and relationships a set of changed files
 * falls under — the producer's attribution, over the manifest's own data.
 */
function attribute(changed: string[], m: KnowledgeModel) {
  const touches = (refs: string[]) => refs.some((ref) => changed.some((rel) => isUnder(rel, parseEvidenceRef(ref).path)));
  const surfaceEvidence = [...m.surfaces.flatMap((s) => s.evidence), ...m.sharedCode.flatMap((c) => c.evidence)].map((r) => parseEvidenceRef(r).path);
  const surfaceSignals = changed.filter((rel) => surfaceEvidence.some((p) => isUnder(rel, p))).map((rel) => `surface evidence changed: ${rel}`);
  const affectedSurfaces = new Set<string>();
  for (const s of m.surfaces) if (touches([...s.sourceRoots, ...s.evidence])) affectedSurfaces.add(s.id);
  for (const c of m.sharedCode) if (touches([c.root])) c.sharedBy.forEach((id) => affectedSurfaces.add(id));
  const affectedCapabilities = m.capabilities
    .filter((c) => touches(capabilityRefs(c)))
    .map((c) => c.id);
  const affectedRelationships = m.relationships.filter((r) => touches(r.evidence)).map((r) => r.id);
  return {
    surfaceSignals,
    affectedSurfaces: [...affectedSurfaces].sort(),
    affectedCapabilities: affectedCapabilities.sort(),
    affectedRelationships: affectedRelationships.sort(),
  };
}

function capabilityRefs(c: Capability): string[] {
  return [...c.sourceRoots.map((r) => r.path), ...c.entryPoints, ...c.services, ...c.routes, ...c.stateOwnership, ...c.tests, ...c.evidence];
}

const isStr = (v: unknown): v is string => typeof v === "string";
const isStrOrNull = (v: unknown): boolean => v === null || typeof v === "string";
const strList = (v: unknown): v is string[] => Array.isArray(v) && v.every(isStr);
const namedList = (v: unknown): boolean =>
  Array.isArray(v) && v.every((x) => x && typeof x === "object" && isStr(x.name) && isStrOrNull(x.anchor));

function surfaceErrors(m: any): string[] {
  const errors: string[] = [];
  if (!Array.isArray(m.surfaces)) errors.push("surfaces is not an array");
  else m.surfaces.forEach((x: any, i: number) => {
    if (!x || typeof x !== "object" || !isStr(x.id)) return void errors.push(`surfaces[${i}].id is not a string`);
    for (const f of ["platform", "formFactor", "buildSelector", "packaging", "minimumRuntime"]) if (!isStrOrNull(x[f])) errors.push(`surfaces[${i}].${f}`);
    for (const f of ["sourceRoots", "sharedWith", "evidence"]) if (!strList(x[f])) errors.push(`surfaces[${i}].${f} is not a string list`);
  });
  if (m.sharedCode !== undefined) {
    if (!Array.isArray(m.sharedCode)) errors.push("sharedCode is not an array");
    else m.sharedCode.forEach((x: any, i: number) => {
      if (!x || typeof x !== "object" || !isStr(x.root) || !strList(x.sharedBy) || !strList(x.evidence) || !isStrOrNull(x.mechanism)) {
        errors.push(`sharedCode[${i}] is malformed`);
      }
    });
  }
  return errors;
}

function capabilityErrors(m: any): string[] {
  const errors: string[] = [];
  if (!Array.isArray(m.capabilities)) return ["capabilities is not an array"];
  m.capabilities.forEach((x: any, i: number) => {
    if (!x || typeof x !== "object" || !isStr(x.id) || !isStr(x.anchor) || !isStrOrNull(x.name)) return void errors.push(`capabilities[${i}] identity is malformed`);
    for (const f of ["surfaces", "entryPoints", "services", "routes", "stateOwnership", "tests", "evidence", "relationships"]) {
      if (!strList(x[f])) errors.push(`capabilities[${i}].${f} is not a string list`);
    }
    if (!Array.isArray(x.sourceRoots) || !x.sourceRoots.every((r: any) => r && isStr(r.path) && isStrOrNull(r.surface))) errors.push(`capabilities[${i}].sourceRoots`);
    for (const f of ["components", "dataDependencies"]) if (!namedList(x[f])) errors.push(`capabilities[${i}].${f}`);
  });
  if (m.capabilityRelationships !== undefined && !Array.isArray(m.capabilityRelationships)) errors.push("capabilityRelationships is not an array");
  return errors;
}

/** Each relationship is judged on its own: an invalid edge is rejected, never the whole map. */
function splitRelationships(raw: unknown[], capIds: Set<string>): { valid: Relationship[]; invalid: Array<{ id: string; reason: string }> } {
  const valid: Relationship[] = [];
  const invalid: Array<{ id: string; reason: string }> = [];
  raw.forEach((x: any, i: number) => {
    const id = x && isStr(x.id) ? x.id : `capabilityRelationships[${i}]`;
    const reason =
      !x || typeof x !== "object" || !isStr(x.from) || !isStr(x.to) || !isStr(x.type) || !isStr(x.anchor) ? "malformed" :
      !(RELATIONSHIP_TYPES as readonly string[]).includes(x.type) ? `unknown relationship type "${x.type}"` :
      !isStr(x.evidenceKind) || !(EVIDENCE_KINDS as readonly string[]).includes(x.evidenceKind) ? `unknown evidence kind "${x.evidenceKind}"` :
      !strList(x.evidence) || x.evidence.length === 0 ? "no evidence — a relationship must be proven by a concrete source edge" :
      !capIds.has(x.from) || !capIds.has(x.to) ? `endpoint not a recorded capability (${x.from} → ${x.to})` :
      null;
    if (reason === null) valid.push({ id, from: x.from, type: x.type, to: x.to, evidenceKind: x.evidenceKind, evidence: [...x.evidence], anchor: x.anchor });
    else invalid.push({ id, reason });
  });
  return { valid, invalid: invalid.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)) };
}

/** The additive model as far as it validates. A malformed category contributes nothing. */
function extractModel(m: any): { model: KnowledgeModel; surfaceProblems: string[]; capabilityProblems: string[]; invalid: Array<{ id: string; reason: string }> } {
  const surfaceProblems = m.surfaces === undefined ? [] : surfaceErrors(m);
  const capabilityProblems = m.capabilities === undefined ? [] : capabilityErrors(m);
  const surfaces: Surface[] = m.surfaces !== undefined && surfaceProblems.length === 0 ? m.surfaces : [];
  const sharedCode: SharedCode[] = surfaces.length > 0 && Array.isArray(m.sharedCode) ? m.sharedCode : [];
  const capabilities: Capability[] = m.capabilities !== undefined && capabilityProblems.length === 0 ? m.capabilities : [];
  const split = capabilities.length > 0 && Array.isArray(m.capabilityRelationships)
    ? splitRelationships(m.capabilityRelationships, new Set(capabilities.map((c) => c.id)))
    : { valid: [], invalid: [] };
  return { model: { surfaces, sharedCode, capabilities, relationships: split.valid }, surfaceProblems, capabilityProblems, invalid: split.invalid };
}

function extendedCategory(
  field: "surfaces" | "capabilities",
  m: any,
  problems: string[],
  changedArtifacts: string[],
  drift: SourceDrift,
): ExtendedCategory {
  const backing = field === "surfaces" ? "CLAUDE.md" : "docs/project/capabilities.md";
  if (m[field] === undefined) {
    return { status: "deriveLive", reason: `${field} absent — the manifest was produced by an older producer (before 0.11.0); treated as coverage unknown.` };
  }
  const coverage = m.coverage?.[field];
  if (coverage !== "populated" && coverage !== "partial") return { status: "deriveLive", reason: `coverage.${field} is ${coverage ?? "absent"}.` };
  if (problems.length > 0) return { status: "deriveLive", reason: `${field} failed structural validation (${problems.join("; ")}).` };
  if (changedArtifacts.includes(backing)) {
    return { status: "deriveLive", reason: `${backing} changed since the manifest was written. Run /inspect-sync (or /inspect) to re-index it.` };
  }
  const drifted =
    field === "surfaces"
      ? drift.status === "BASELINE_UNKNOWN" || (drift.status === "REFRESH_RECOMMENDED" && drift.analysisSignals.length > 0)
      : drift.status !== "COMPLETE";
  if (drifted) {
    return {
      status: "verifyOnUse",
      reason: `Source changed since the knowledge was generated (${drift.reason}) — verify each ${field === "surfaces" ? "surface" : "capability and relationship"} used against the current source.`,
    };
  }
  return { status: "trusted", reason: `coverage.${field} is ${coverage}, and nothing it depends on has moved.` };
}

/** Stage 4B. The source-backed categories a drift verdict can have moved. */
function affectedCategories(drift: SourceDrift): string[] {
  if (drift.status === "BASELINE_UNKNOWN") return [...ANALYSIS_BACKED, ...DOCS_BACKED];
  if (drift.status === "COMPLETE") return [];
  return drift.analysisSignals.length > 0 ? [...ANALYSIS_BACKED, ...DOCS_BACKED] : [...DOCS_BACKED];
}

function sha256OfFile(targetRoot: string, rel: string): string | null {
  const p = join(targetRoot, rel);
  if (!existsSync(p)) return null;
  return createHash("sha256").update(readFileSync(p, "utf-8"), "utf-8").digest("hex");
}

const VALID_COVERAGE_VALUES = new Set(["populated", "partial", "unknown"]);
const STACK_LIST_FIELDS = ["languages", "frameworks", "platformHints", "runtimeTooling", "packageManagers"] as const;
const COMMAND_FIELDS = ["install", "run", "test", "build"] as const;
const AUDIT_TOPIC_STRING_FIELDS = ["topic", "slug", "status", "file"] as const;

/**
 * Structural validation. Mirrors the producer's validateManifest but goes
 * further: it also guards every shape a downstream consumer will dereference
 * without a null check (e.g. `knowledge.stack.languages`), so a manifest that
 * is internally inconsistent (coverage claims a category is populated but the
 * category itself is missing or malformed) is rejected here rather than
 * crashing whichever command trusted `usableCategories`.
 */
function structuralErrors(m: any): string[] {
  const errors: string[] = [];
  if (!m || typeof m !== "object") return ["manifest is not an object"];
  if (!m.producedBy?.plugin) errors.push("producedBy.plugin missing");
  if (typeof m.generatedAt !== "string") errors.push("generatedAt missing");
  if (!m.fingerprint || typeof m.fingerprint.artifacts !== "object") errors.push("fingerprint.artifacts missing");
  const kh = m.fingerprint?.knowledgeHead;
  if (kh !== undefined && kh !== null && typeof kh !== "string") errors.push("fingerprint.knowledgeHead must be a string or null");

  if (!m.coverage || typeof m.coverage !== "object") {
    errors.push("coverage missing");
  } else {
    for (const [key, value] of Object.entries(m.coverage)) {
      if (!VALID_COVERAGE_VALUES.has(value as string)) {
        errors.push(`coverage.${key} is not one of populated|partial|unknown`);
      }
    }
  }

  if (!m.stack || typeof m.stack !== "object") {
    errors.push("stack missing or not an object");
  } else {
    for (const field of STACK_LIST_FIELDS) {
      if (!Array.isArray(m.stack[field])) errors.push(`stack.${field} is not an array`);
    }
  }

  if (!m.commands || typeof m.commands !== "object") {
    errors.push("commands missing or not an object");
  } else {
    for (const field of COMMAND_FIELDS) {
      const value = m.commands[field];
      if (value !== null && typeof value !== "string") errors.push(`commands.${field} is not a string or null`);
    }
  }

  if (!m.structure || typeof m.structure !== "object") errors.push("structure missing or not an object");

  if (!m.documents || typeof m.documents !== "object") {
    errors.push("documents missing");
  } else {
    for (const [key, doc] of Object.entries(m.documents as Record<string, any>)) {
      if (!doc || typeof doc !== "object") {
        errors.push(`documents.${key} is not an object`);
        continue;
      }
      if (typeof doc.path !== "string") errors.push(`documents.${key}.path is not a string`);
      if (typeof doc.exists !== "boolean") errors.push(`documents.${key}.exists is not a boolean`);
      if (!Array.isArray(doc.anchors)) errors.push(`documents.${key}.anchors is not an array`);
    }
  }

  if (!Array.isArray(m.auditTopics)) {
    errors.push("auditTopics is not an array");
  } else {
    m.auditTopics.forEach((entry: any, i: number) => {
      if (!entry || typeof entry !== "object") {
        errors.push(`auditTopics[${i}] is not an object`);
        return;
      }
      for (const field of AUDIT_TOPIC_STRING_FIELDS) {
        if (typeof entry[field] !== "string") errors.push(`auditTopics[${i}].${field} is not a string`);
      }
    });
  }

  return errors;
}

export function readRepoKnowledge(targetRootInput: string): KnowledgeResult {
  const targetRootAbs = resolve(targetRootInput);
  if (!existsSync(targetRootAbs)) {
    return unavailable("root-not-found", `Target root not found: ${targetRootAbs}. Deriving all repository knowledge live.`);
  }
  const targetRoot = realpathSync(targetRootAbs);

  // A manifest read from an ephemeral agent worktree would mislead every
  // consumer, so refuse it the same way the producer does.
  if (targetRoot.includes(CLAUDE_WORKTREE_MARKER)) {
    return unavailable(
      "worktree",
      "Target root is inside .claude/worktrees — refusing to read repository knowledge from an agent worktree. Deriving all repository knowledge live."
    );
  }

  const manifestRel = join(".ono", "repo-knowledge.json");
  const manifestPath = join(targetRoot, manifestRel);
  if (!existsSync(manifestPath)) {
    return unavailable(
      "absent",
      "Repository knowledge is not available (no .ono/repo-knowledge.json). Deriving all repository knowledge live — running /inspect with the Ono Project Inspector would let this plugin reuse approved knowledge instead."
    );
  }

  let parsed: any;
  try {
    parsed = JSON.parse(readFileSync(manifestPath, "utf-8"));
  } catch (err) {
    return unavailable("unparseable", `.ono/repo-knowledge.json is not valid JSON (${(err as Error).message}). Deriving all repository knowledge live.`);
  }

  const schemaVersion = typeof parsed?.repoKnowledgeSchemaVersion === "number" ? parsed.repoKnowledgeSchemaVersion : null;
  if (schemaVersion === null) {
    return unavailable("invalid", ".ono/repo-knowledge.json has no repoKnowledgeSchemaVersion. Deriving all repository knowledge live.");
  }
  if (schemaVersion > MAX_SUPPORTED_SCHEMA_VERSION) {
    return unavailable(
      "schema-too-new",
      `.ono/repo-knowledge.json uses contract schema v${schemaVersion}; this plugin supports up to v${MAX_SUPPORTED_SCHEMA_VERSION}. Deriving all repository knowledge live — upgrade ono-mobile-dev-plugin to consume it.`,
      schemaVersion
    );
  }

  const errors = structuralErrors(parsed);
  if (errors.length) {
    return unavailable("invalid", `.ono/repo-knowledge.json failed structural validation (${errors.join("; ")}). Deriving all repository knowledge live.`, schemaVersion);
  }

  // --- Freshness ---
  const recordedHead: string | null = parsed.fingerprint.gitHead ?? null;
  const head = currentHead(targetRoot);

  const changedArtifacts: string[] = [];
  for (const [rel, recordedHash] of Object.entries(parsed.fingerprint.artifacts as Record<string, string | null>)) {
    if (sha256OfFile(targetRoot, rel) !== recordedHash) changedArtifacts.push(rel);
  }
  changedArtifacts.sort();

  let freshness: Freshness;
  let staleDetail: string | null = null;
  if (changedArtifacts.length > 0) {
    freshness = "stale-artifacts";
    staleDetail = `Changed since the manifest was written: ${changedArtifacts.join(", ")}. Categories backed by these documents are derived live. Run /inspect-sync (or /inspect) to refresh.`;
  } else if (recordedHead === null || head === null) {
    freshness = "unknown";
    staleDetail = "Freshness could not be established (no git HEAD recorded, or git unavailable). Using the manifest as-is.";
  } else if (recordedHead !== head) {
    freshness = "stale-head";
    staleDetail = `HEAD moved since the manifest was written (recorded ${recordedHead.slice(0, 8)}, current ${head.slice(0, 8)}), but every indexed document is unchanged.`;
  } else {
    freshness = "fresh";
  }

  // --- Source drift since the knowledge was generated (Stage 4B) ---
  const extracted = extractModel(parsed);
  const sourceDrift = computeSourceDrift(targetRoot, parsed.fingerprint.knowledgeHead ?? null, head, extracted.model);
  const affected = affectedCategories(sourceDrift);
  if (sourceDrift.status !== "COMPLETE") {
    const drift =
      sourceDrift.status === "REFRESH_RECOMMENDED"
        ? `Source changed since the knowledge was generated (${sourceDrift.reason})`
        : `Source-backed knowledge freshness is unknown (${sourceDrift.reason})`;
    staleDetail = `${staleDetail ? `${staleDetail} ` : ""}${drift} Affected reused categories are verified on use against the current repository. ${REFRESH_RECOMMENDATION}`;
  }

  // --- Usable vs derive-live, per contract obligations 5 and 6 ---
  const usableCategories: string[] = [];
  const deriveLive: string[] = [];
  for (const category of ALL_CATEGORIES) {
    const coverage = parsed.coverage?.[category];
    const source = CATEGORY_SOURCE[category];
    const sourceChanged = changedArtifacts.includes(source);
    if (coverage === "populated" || coverage === "partial") {
      if (sourceChanged) deriveLive.push(category);
      else usableCategories.push(category);
    } else {
      deriveLive.push(category);
    }
  }

  const verifyOnUse = usableCategories.filter((c) => affected.includes(c));
  const trustedCategories = usableCategories.filter((c) => !affected.includes(c));

  const surfacesCategory = extendedCategory("surfaces", parsed, extracted.surfaceProblems, changedArtifacts, sourceDrift);
  const capabilitiesCategory = extendedCategory("capabilities", parsed, extracted.capabilityProblems, changedArtifacts, sourceDrift);
  const extendedNote = (["surfaces", "capabilities"] as const)
    .map((k) => `${k} ${({ trusted: "reusable", verifyOnUse: "verify on use", deriveLive: "derive live" } as const)[(k === "surfaces" ? surfacesCategory : capabilitiesCategory).status]}`)
    .join(", ");

  const summary =
    `Repository knowledge available (contract v${schemaVersion}, produced by ${parsed.producedBy.plugin} ${parsed.producedBy.version}, ${freshness}). ` +
    `Reusing: ${trustedCategories.length ? trustedCategories.join(", ") : "nothing"}. ` +
    (verifyOnUse.length ? `Verify on use (source changed since the knowledge was generated): ${verifyOnUse.join(", ")}. ` : "") +
    `Deriving live: ${deriveLive.length ? deriveLive.join(", ") : "nothing"}.` +
    // An older manifest carries neither — its summary stays exactly what it always was.
    (parsed.surfaces !== undefined || parsed.capabilities !== undefined ? ` Surfaces and capabilities: ${extendedNote}.` : "");

  return {
    available: true,
    reason: null,
    schemaVersion,
    producedBy: parsed.producedBy,
    generatedAt: parsed.generatedAt,
    freshness,
    staleDetail,
    usableCategories,
    trustedCategories,
    verifyOnUse,
    sourceDrift,
    refreshRecommendation: sourceDrift.status === "COMPLETE" ? null : REFRESH_RECOMMENDATION,
    deriveLive,
    knowledge: parsed,
    platformHintsAreAdvisory: true,
    extendedCategories: { surfaces: surfacesCategory, capabilities: capabilitiesCategory },
    surfaces: surfacesCategory.status === "deriveLive" ? null : extracted.model.surfaces,
    sharedCode: surfacesCategory.status === "deriveLive" ? null : extracted.model.sharedCode,
    capabilities: capabilitiesCategory.status === "deriveLive" ? null : extracted.model.capabilities,
    capabilityRelationships: capabilitiesCategory.status === "deriveLive" ? null : extracted.model.relationships,
    invalidRelationships: capabilitiesCategory.status === "deriveLive" ? [] : extracted.invalid,
    surfacesAreAdvisory: true,
    summary,
  };
}

/* ------------------------------------------------ Stage B: queries over the model */

export interface RefCheck {
  ref: string;
  ok: boolean;
  reason: string;
}

export interface Verification {
  /** `trusted` — not re-checked (fresh knowledge). `verified` — every ref still resolves. */
  status: "trusted" | "verified" | "failed";
  checked: number;
  failed: RefCheck[];
}

/**
 * Re-check one evidence ref against the CURRENT source: the path must exist inside the
 * repository and outside Inspector-owned knowledge, and a `path::token` ref's literal token
 * must occur in that file. A ref that no longer resolves means the fact moved — the current
 * code wins.
 */
export function verifyEvidenceRef(targetRoot: string, ref: string): RefCheck {
  const { path, token } = parseEvidenceRef(ref);
  const rel = path.replace(/^\.\//, "");
  if (rel === "" || rel.startsWith("/") || rel.split("/").includes("..")) return { ref, ok: false, reason: "not a repository-relative path" };
  if (isInspectorOwned(rel)) return { ref, ok: false, reason: "points at Inspector-owned knowledge, not at repository source" };
  const abs = join(targetRoot, rel);
  if (!existsSync(abs)) return { ref, ok: false, reason: `${rel} no longer exists` };
  if (token === null) return { ref, ok: true, reason: "path exists" };
  let text: string;
  try {
    text = readFileSync(abs, "utf-8");
  } catch {
    return { ref, ok: false, reason: `${rel} is not a readable file` };
  }
  return text.includes(token) ? { ref, ok: true, reason: "token found" } : { ref, ok: false, reason: `"${token}" no longer occurs in ${rel}` };
}

function verifyRefs(targetRoot: string, refs: string[]): Verification {
  const unique = [...new Set(refs)].sort();
  const failed = unique.map((r) => verifyEvidenceRef(targetRoot, r)).filter((c) => !c.ok);
  return { status: failed.length === 0 ? "verified" : "failed", checked: unique.length, failed };
}

const TRUSTED: Verification = { status: "trusted", checked: 0, failed: [] };

const normPath = (p: string): string => p.trim().replace(/^\.\//, "");
const normName = (s: string): string => s.trim().toLowerCase().replace(/\s+/g, " ");

/** Where a base category stands in a result: reuse as-is, verify on use, or derive live. */
function baseStatus(r: KnowledgeResult, category: string): ExtendedStatus {
  return r.trustedCategories.includes(category) ? "trusted" : r.verifyOnUse.includes(category) ? "verifyOnUse" : "deriveLive";
}

/**
 * One surface's context — to scope a feature AFTER the human confirmed its platform and
 * device type. Never an input to routing: `formFactor` is not a `device_type`.
 */
export function querySurface(r: KnowledgeResult, targetRoot: string, surfaceId: string, opts: { verify?: boolean } = {}): Record<string, any> {
  const cat = r.extendedCategories.surfaces;
  if (!r.available || cat.status === "deriveLive" || r.surfaces === null) return { status: "derive-live", reason: cat.reason };
  const surface = r.surfaces.find((x) => x.id === surfaceId);
  if (surface === undefined) return { status: "not-found", surfaceId, declared: r.surfaces.map((x) => x.id) };
  const sharedCode = (r.sharedCode ?? []).filter((c) => c.sharedBy.includes(surfaceId));
  const conventionsDoc = r.knowledge?.documents?.conventions ?? null;
  const rawOverrides = conventionsDoc?.surfaceAnchors?.[surfaceId];
  const overrides: Array<{ section: string; anchor: string }> = Array.isArray(rawOverrides)
    ? rawOverrides.filter((o: any) => o && isStr(o.section) && isStr(o.anchor)).map((o: any) => ({ section: o.section, anchor: o.anchor }))
    : [];
  const verify = cat.status === "verifyOnUse" || opts.verify === true;
  return {
    status: "found",
    category: cat.status,
    surface,
    sharedCode,
    conventions: {
      path: conventionsDoc?.path ?? null,
      category: baseStatus(r, "conventions"),
      overrides,
      note: overrides.length > 0
        ? "Read each shared section, then this surface's override for it; a section with no override is inherited."
        : "No overrides: this surface inherits every shared convention section.",
    },
    inventory: { path: r.knowledge?.documents?.inventory?.path ?? null, category: baseStatus(r, "inventory"), note: "Rows carry a Surface cell (`all` or surface ids)." },
    integrations: { path: r.knowledge?.documents?.integrations?.path ?? null, category: baseStatus(r, "integrations"), note: "Rows carry a Surface cell (`all` or surface ids)." },
    verification: verify
      ? verifyRefs(targetRoot, [...surface.evidence, ...surface.sourceRoots, ...sharedCode.flatMap((c) => [c.root, ...c.evidence])])
      : TRUSTED,
  };
}

/**
 * Locate a requested capability by deterministic identity only: its id, its exact name
 * (case and whitespace aside), or a path under one of its recorded source roots / an entry
 * point. Never by similarity: "video" does not find "Video Playback".
 */
export function lookupCapability(r: KnowledgeResult, q: { capability?: string; paths?: string[] }): Record<string, any> {
  const cat = r.extendedCategories.capabilities;
  if (!r.available || cat.status === "deriveLive" || r.capabilities === null) return { status: "derive-live", reason: cat.reason, matches: [] };
  const found = new Map<string, string>();
  const add = (id: string, by: string) => { if (!found.has(id)) found.set(id, by); };
  if (q.capability !== undefined && q.capability.trim() !== "") {
    const want = normName(q.capability);
    for (const c of r.capabilities) if (normName(c.id) === want) add(c.id, "id");
    for (const c of r.capabilities) if (c.name !== null && normName(c.name) === want) add(c.id, "name");
  }
  for (const raw of q.paths ?? []) {
    const p = normPath(raw);
    for (const c of r.capabilities) {
      if (c.sourceRoots.some((sr) => isUnder(p, normPath(sr.path)))) add(c.id, "source-root");
      else if (c.entryPoints.some((e) => normPath(parseEvidenceRef(e).path) === p)) add(c.id, "entry-point");
    }
  }
  const matches = [...found.entries()].map(([id, matchedBy]) => ({ id, matchedBy })).sort((a, b) => (a.id < b.id ? -1 : 1));
  return {
    status: matches.length === 0 ? "not-found" : matches.length === 1 ? "found" : "ambiguous",
    category: cat.status,
    matches,
    note: matches.length === 0
      ? "Not in the Feature & Capability Map by id, name or source root — discover the change surface live."
      : matches.length > 1 ? "More than one capability matches — the developer picks; nothing is chosen here." : null,
  };
}

/**
 * A capability and its DIRECT relationships — first degree only. A neighbour is summarised
 * by id, name and anchor, never with its own relationships: expanding the graph further is
 * the analysis's own decision, never this reader's. Stale evidence is re-checked; an edge
 * that no longer holds, or that was rejected structurally, is handed back for live
 * derivation instead of being presented as context.
 */
export function capabilityContext(r: KnowledgeResult, targetRoot: string, id: string, opts: { verify?: boolean } = {}): Record<string, any> {
  const cat = r.extendedCategories.capabilities;
  if (!r.available || cat.status === "deriveLive" || r.capabilities === null) return { status: "derive-live", reason: cat.reason };
  const caps = r.capabilities;
  const c = caps.find((x) => x.id === id);
  if (c === undefined) return { status: "not-found", id };
  const verify = cat.status === "verifyOnUse" || opts.verify === true;
  const summary = (otherId: string) => {
    const o = caps.find((x) => x.id === otherId);
    return { id: otherId, name: o?.name ?? null, anchor: o?.anchor ?? null };
  };
  const edges = (r.capabilityRelationships ?? []).filter((e) => e.from === id || e.to === id);
  const deriveLive = new Set<string>();
  const relationships = edges.map((e) => {
    const checked = verify ? verifyRefs(targetRoot, e.evidence) : TRUSTED;
    const verification = { ...checked, status: checked.status === "failed" ? "invalid" : checked.status };
    if (verification.status === "invalid") deriveLive.add(e.id);
    return {
      id: e.id,
      type: e.type,
      direction: e.from === id ? "outgoing" : "incoming",
      other: summary(e.from === id ? e.to : e.from),
      evidenceKind: e.evidenceKind,
      evidence: e.evidence,
      anchor: e.anchor,
      verification,
    };
  });
  const validIds = new Set(edges.map((e) => e.id));
  for (const rid of c.relationships) if (!validIds.has(rid)) deriveLive.add(rid);
  for (const bad of r.invalidRelationships) if (bad.id.split(":").includes(id) || c.relationships.includes(bad.id)) deriveLive.add(bad.id);
  const related = new Map<string, { id: string; name: string | null; anchor: string | null; via: string[] }>();
  for (const rel of relationships) {
    if (rel.verification.status === "invalid") continue;
    const entry = related.get(rel.other.id) ?? { ...rel.other, via: [] as string[] };
    entry.via.push(rel.id);
    related.set(rel.other.id, entry);
  }
  return {
    status: "found",
    category: cat.status,
    capability: c,
    verification: verify ? verifyRefs(targetRoot, capabilityRefs(c)) : TRUSTED,
    relationships,
    relatedCapabilities: [...related.values()].sort((a, b) => (a.id < b.id ? -1 : 1)),
    deriveLive: [...deriveLive].sort(),
    note: "First-degree context only — a relationship is not proof of impact, and never expands scope by itself.",
  };
}

/** The surfaces, shared-code root and capabilities each path falls under — e.g. the files a review covers. */
export function pathScope(r: KnowledgeResult, paths: string[]): Array<{ path: string; surfaces: string[]; sharedCode: string | null; capabilities: string[] }> {
  const surfacesOk = r.available && r.extendedCategories.surfaces.status !== "deriveLive";
  const capsOk = r.available && r.extendedCategories.capabilities.status !== "deriveLive";
  return paths.map((raw) => {
    const p = normPath(raw);
    const surfaces = new Set<string>();
    let sharedCode: string | null = null;
    if (surfacesOk) {
      for (const s of r.surfaces ?? []) if (s.sourceRoots.some((root) => isUnder(p, normPath(root)))) surfaces.add(s.id);
      for (const sc of r.sharedCode ?? []) {
        if (isUnder(p, normPath(sc.root))) {
          sharedCode = sc.root;
          sc.sharedBy.forEach((x) => surfaces.add(x));
        }
      }
    }
    const capabilities = capsOk ? (r.capabilities ?? []).filter((c) => c.sourceRoots.some((sr) => isUnder(p, normPath(sr.path)))).map((c) => c.id).sort() : [];
    return { path: p, surfaces: [...surfaces].sort(), sharedCode, capabilities };
  });
}

function main(): void {
  const args = process.argv.slice(2);
  const flagValues = (name: string): string[] => args.flatMap((a, i) => (a === `--${name}` && args[i + 1] !== undefined ? [args[i + 1]] : []));
  const valueFlags = new Set(["--surface", "--capability", "--path"]);
  const target = args.find((a, i) => !a.startsWith("--") && !valueFlags.has(args[i - 1] ?? "")) ?? process.cwd();
  const result: Record<string, any> = readRepoKnowledge(target);
  const surface = flagValues("surface")[0];
  const capability = flagValues("capability")[0];
  const paths = flagValues("path");
  const verify = args.includes("--verify");
  if (surface !== undefined || capability !== undefined || paths.length > 0) {
    const root = existsSync(resolve(target)) ? realpathSync(resolve(target)) : resolve(target);
    const query: Record<string, any> = {};
    if (surface !== undefined) query.surface = querySurface(result as KnowledgeResult, root, surface, { verify });
    if (capability !== undefined || paths.length > 0) {
      const lookup = lookupCapability(result as KnowledgeResult, { capability, paths });
      query.capability = { ...lookup, context: lookup.status === "found" ? capabilityContext(result as KnowledgeResult, root, lookup.matches[0].id, { verify }) : null };
    }
    if (paths.length > 0) query.paths = pathScope(result as KnowledgeResult, paths);
    result.query = query;
  }
  // Always exit 0 with valid JSON — see the header note.
  console.log(JSON.stringify(result, null, 2));
  process.exit(0);
}

// Only run the CLI when executed directly, so the test file can import the
// pure function without triggering process.exit.
const invokedDirectly =
  typeof process !== "undefined" &&
  process.argv[1] !== undefined &&
  /read-repo-knowledge\.ts$/.test(realpathSync(process.argv[1]));

if (invokedDirectly) {
  main();
}
