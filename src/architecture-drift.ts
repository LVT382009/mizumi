/**
 * Architecture Drift Detection — flag when PR changes violate declared
 * architecture boundaries.
 *
 * No AI code reviewer detects architecture violations. CodeRabbit, Copilot,
 * CodeGuru, Sourcery all review each PR in isolation—nobody checks if the
 * change breaks the intended dependency direction. Erode.dev proves the
 * concept works as a standalone tool, but no reviewer integrates it.
 *
 * Mizumi loads an architecture model from `.github/mizumi-architecture.yml`,
 * analyzes import edges from the diff, and flags violations:
 *
 * 1. Layer violation: a file in layer A imports from layer B when the model
 *    says A must not depend on B (e.g., frontend → database)
 * 2. Boundary violation: a file imports across a bounded context boundary
 *    without an anti-corruption layer
 *
 * Zero LLM cost — pure graph analysis on import edges vs declared model.
 */
import * as core from "@actions/core";
import * as fs from "node:fs";
import * as path from "node:path";
import { DiffFile } from "./diff.js";
import { extractImportEdges, type DependencyEdge } from "./blast-radius.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ArchitectureLayer {
  /** Layer name (e.g., "frontend", "api", "domain", "infrastructure") */
  name: string;
  /** Glob patterns for files belonging to this layer */
  patterns: string[];
  /** Layers this layer is allowed to import from */
  allowedDeps: string[];
}

export interface BoundedContext {
  /** Context name (e.g., "billing", "auth", "catalog") */
  name: string;
  /** Glob patterns for files in this context */
  patterns: string[];
}

export interface ArchitectureModel {
  /** Declared layers with allowed dependency directions */
  layers: ArchitectureLayer[];
  /** Bounded contexts (optional) */
  contexts?: BoundedContext[];
  /** Whether to enforce strict layering (no upward deps) */
  strict?: boolean;
}

export interface ArchitectureViolation {
  /** Violation type */
  kind: "layer-violation" | "boundary-violation";
  /** File that has the illegal import */
  sourceFile: string;
  /** Import target (resolved, without extension) */
  targetFile: string;
  /** Source layer/context */
  sourceLayer: string;
  /** Target layer/context */
  targetLayer: string;
  /** Human-readable description */
  description: string;
  /** Severity: critical = directly violates constraint, medium = crosses boundary without ACL */
  severity: "critical" | "medium";
}

export interface DriftDetectionResult {
  /** All detected violations */
  violations: ArchitectureViolation[];
  /** The architecture model used */
  model: ArchitectureModel | null;
  /** Context text for LLM prompt */
  contextText: string;
  /** Review body summary */
  bodySummary: string;
}

// ---------------------------------------------------------------------------
// Architecture model loading
// ---------------------------------------------------------------------------

/**
 * Load architecture model from .github/mizumi-architecture.yml
 */
export function loadArchitectureModel(workspace: string): ArchitectureModel | null {
  const ymlPath = path.join(workspace, ".github", "mizumi-architecture.yml");
  if (!fs.existsSync(ymlPath)) return null;

  try {
    const raw = fs.readFileSync(ymlPath, "utf-8");
    return parseArchitectureYaml(raw);
  } catch {
    core.warning("Failed to parse .github/mizumi-architecture.yml");
    return null;
  }
}

// ---------------------------------------------------------------------------
// Glob matching (simplified — supports *, **, and exact paths)
// ---------------------------------------------------------------------------

function matchGlob(filePath: string, pattern: string): boolean {
  if (pattern === "**") return true;
  // Exact match
  if (!pattern.includes("*")) return filePath === pattern;

  // Convert glob to regex
  const re = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "{{GLOBSTAR}}")
    .replace(/\*/g, "[^/]*")
    .replace(/{{GLOBSTAR}}/g, ".*");

  return new RegExp(`^${re}$`).test(filePath);
}

function fileMatchesAny(filePath: string, patterns: string[]): boolean {
  return patterns.some((p) => matchGlob(filePath, p));
}

// ---------------------------------------------------------------------------
// Layer resolution
// ---------------------------------------------------------------------------

function resolveLayer(filePath: string, layers: ArchitectureLayer[]): string | null {
  for (const layer of layers) {
    if (fileMatchesAny(filePath, layer.patterns)) return layer.name;
  }
  return null;
}

function resolveContext(filePath: string, contexts: BoundedContext[]): string | null {
  for (const ctx of contexts) {
    if (fileMatchesAny(filePath, ctx.patterns)) return ctx.name;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Violation detection
// ---------------------------------------------------------------------------

function detectLayerViolations(
  edges: DependencyEdge[],
  currentFiles: Set<string>,
  layers: ArchitectureLayer[],
  strict: boolean,
): ArchitectureViolation[] {
  const violations: ArchitectureViolation[] = [];

  for (const edge of edges) {
    if (!currentFiles.has(edge.from)) continue;

    const sourceLayer = resolveLayer(edge.from, layers);
    const targetLayer = resolveLayer(edge.to, layers);

    if (!sourceLayer || !targetLayer) continue;
    if (sourceLayer === targetLayer) continue;

    const sourceDef = layers.find((l) => l.name === sourceLayer);
    if (!sourceDef) continue;

    const isAllowed = sourceDef.allowedDeps.includes(targetLayer);

    if (!isAllowed) {
      violations.push({
        kind: "layer-violation",
        sourceFile: edge.from,
        targetFile: edge.to,
        sourceLayer,
        targetLayer,
        description: `Layer violation: \`${sourceLayer}\` file \`${edge.from}\` imports from \`${targetLayer}\` layer (\`${edge.to}\`) — not in allowed dependencies [${sourceDef.allowedDeps.join(", ")}]`,
        severity: "critical",
      });
    }

    // In strict mode, also flag upward dependencies
    if (strict && isAllowed) {
      const sourceIdx = layers.findIndex((l) => l.name === sourceLayer);
      const targetIdx = layers.findIndex((l) => l.name === targetLayer);
      if (targetIdx < sourceIdx) {
        violations.push({
          kind: "layer-violation",
          sourceFile: edge.from,
          targetFile: edge.to,
          sourceLayer,
          targetLayer,
          description: `Upward dependency: \`${sourceLayer}\` (\`${edge.from}\`) imports from lower layer \`${targetLayer}\` (\`${edge.to}\`) in strict mode`,
          severity: "medium",
        });
      }
    }
  }

  return violations;
}

function detectBoundaryViolations(
  edges: DependencyEdge[],
  currentFiles: Set<string>,
  contexts: BoundedContext[],
): ArchitectureViolation[] {
  if (contexts.length === 0) return [];
  const violations: ArchitectureViolation[] = [];

  for (const edge of edges) {
    if (!currentFiles.has(edge.from)) continue;

    const sourceCtx = resolveContext(edge.from, contexts);
    const targetCtx = resolveContext(edge.to, contexts);

    if (!sourceCtx || !targetCtx) continue;
    if (sourceCtx === targetCtx) continue;

    // Cross-context import — flag as boundary violation (medium severity
    // since some cross-context imports are intentional with ACLs)
    violations.push({
      kind: "boundary-violation",
      sourceFile: edge.from,
      targetFile: edge.to,
      sourceLayer: sourceCtx,
      targetLayer: targetCtx,
      description: `Boundary violation: \`${edge.from}\` in context \`${sourceCtx}\` imports from \`${targetCtx}\` context (\`${edge.to}\`) — consider an anti-corruption layer`,
      severity: "medium",
    });
  }

  return violations;
}

// ---------------------------------------------------------------------------
// Deduplication
// ---------------------------------------------------------------------------

function dedupViolations(violations: ArchitectureViolation[]): ArchitectureViolation[] {
  const seen = new Set<string>();
  return violations.filter((v) => {
    const key = `${v.kind}:${v.sourceFile}:${v.targetFile}:${v.sourceLayer}:${v.targetLayer}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ---------------------------------------------------------------------------
// Context generation
// ---------------------------------------------------------------------------

function buildDriftContext(result: DriftDetectionResult): string {
  if (result.violations.length === 0) return "";

  const critical = result.violations.filter((v) => v.severity === "critical");
  const medium = result.violations.filter((v) => v.severity === "medium");

  let ctx = `## Architecture Drift (${result.violations.length})\n`;
  ctx += "This PR may violate the declared architecture model. Review before merging:\n\n";

  if (critical.length > 0) {
    ctx += "### Layer Violations\n";
    for (const v of critical.slice(0, 10)) {
      ctx += `- ${v.description}\n`;
    }
  }
  if (medium.length > 0) {
    ctx += "### Boundary Crossings\n";
    for (const v of medium.slice(0, 10)) {
      ctx += `- ${v.description}\n`;
    }
  }

  return ctx.trim();
}

function buildDriftBodySummary(result: DriftDetectionResult): string {
  if (result.violations.length === 0) return "";

  let body = `<details><summary><strong>Architecture Drift</strong> — ${result.violations.length} violations</summary>\n\n`;
  body += "| Type | Source | Target | From → To | Severity |\n";
  body += "|------|--------|--------|-----------|----------|\n";

  for (const v of result.violations.slice(0, 15)) {
    const typeLabel = v.kind === "layer-violation" ? "layer" : "boundary";
    body += `| ${typeLabel} | \`${v.sourceFile}\` | \`${v.targetFile}\` | ${v.sourceLayer} → ${v.targetLayer} | ${v.severity} |\n`;
  }

  if (result.violations.length > 15) {
    body += `| ... | | | | ${result.violations.length - 15} more |\n`;
  }

  body += `\n*Architecture model: ${result.model?.layers.length ?? 0} layers${result.model?.contexts?.length ? `, ${result.model.contexts.length} contexts` : ""}.*\n</details>\n`;
  return body;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Run architecture drift detection against a declared architecture model.
 * Zero LLM cost.
 */
export function detectArchitectureDrift(
  currentFiles: DiffFile[],
  model: ArchitectureModel,
): DriftDetectionResult {
  const filePaths = new Set(currentFiles.map((f) => f.path));
  const edges = extractImportEdges(currentFiles);

  const layerViolations = detectLayerViolations(edges, filePaths, model.layers, model.strict ?? false);
  const boundaryViolations = detectBoundaryViolations(edges, filePaths, model.contexts ?? []);

  const violations = dedupViolations([...layerViolations, ...boundaryViolations]);

  // Sort: critical first, then by source file
  violations.sort((a, b) => {
    const sv = (a.severity === "critical" ? 0 : 1) - (b.severity === "critical" ? 0 : 1);
    if (sv !== 0) return sv;
    return a.sourceFile.localeCompare(b.sourceFile);
  });

  const result: DriftDetectionResult = {
    violations,
    model,
    contextText: "",
    bodySummary: "",
  };

  result.contextText = buildDriftContext(result);
  result.bodySummary = buildDriftBodySummary(result);

  if (violations.length > 0) {
    core.info(`Architecture drift: ${violations.length} violations detected (${layerViolations.length} layer, ${boundaryViolations.length} boundary)`);
  }

  return result;
}

// ---------------------------------------------------------------------------
// YAML parser for architecture model
// ---------------------------------------------------------------------------

export function parseArchitectureYaml(raw: string): ArchitectureModel {
  const lines = raw.split("\n");
  const layers: ArchitectureLayer[] = [];
  const contexts: BoundedContext[] = [];
  let strict = false;

  let currentSection: "layers" | "contexts" | "root" | null = null;
  let sectionIndent = -1;
  let currentLayer: ArchitectureLayer | null = null;
  let currentContext: BoundedContext | null = null;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const indent = line.search(/\S/);
    const colonIdx = trimmed.indexOf(":");
    if (colonIdx === -1) {
      // Array item
      if (trimmed.startsWith("- ")) {
        const item = trimmed.slice(2).trim().replace(/^["']|["']$/g, "");
        if (currentLayer && currentSection === "layers") {
          currentLayer.patterns.push(item);
        } else if (currentContext && currentSection === "contexts") {
          currentContext.patterns.push(item);
        }
      }
      continue;
    }

    const key = trimmed.slice(0, colonIdx).trim();
    const value = trimmed.slice(colonIdx + 1).trim();

    // Top-level keys (indent 0)
    if (indent === 0) {
      if (key === "strict") strict = value === "true";
      if (key === "layers") { currentSection = "layers"; sectionIndent = -1; currentLayer = null; }
      if (key === "contexts") { currentSection = "contexts"; sectionIndent = -1; currentContext = null; }
      continue;
    }

    // Section-level keys (indent === sectionIndent + 2) — these are layer/context names
    if (currentSection === "layers") {
      if (sectionIndent === -1) sectionIndent = indent - 2;
      if (indent === sectionIndent + 2 && value === "") {
        // This is a layer name
        currentLayer = { name: key, patterns: [], allowedDeps: [] };
        layers.push(currentLayer);
        continue;
      }
    }

    if (currentSection === "contexts") {
      if (sectionIndent === -1) sectionIndent = indent - 2;
      if (indent === sectionIndent + 2 && value === "") {
        // This is a context name
        currentContext = { name: key, patterns: [] };
        contexts.push(currentContext);
        continue;
      }
    }

    // Property keys within a layer/context
    if (currentLayer && currentSection === "layers") {
      if (key === "patterns" && value === "") {
        // patterns block — items will come as array items
      } else if ((key === "allowed_deps" || key === "allowedDeps") && value) {
        currentLayer.allowedDeps = value.split(",").map((s) => s.trim().replace(/^["']|["']$/g, "")).filter(Boolean);
      }
    }
  }

  return { layers, contexts: contexts.length > 0 ? contexts : undefined, strict };
}
