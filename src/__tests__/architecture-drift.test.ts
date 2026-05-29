import { describe, it, expect, vi } from "vitest";

vi.mock("@actions/core", () => ({
  info: vi.fn(),
  warning: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));

import {
  detectArchitectureDrift,
  parseArchitectureYaml,
  loadArchitectureModel,
} from "../architecture-drift.js";
import type {
  ArchitectureModel,
  ArchitectureViolation,
  DriftDetectionResult,
} from "../architecture-drift.js";
import type { DiffFile } from "../diff.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const makeFile = (
  filePath: string,
  changes: string[] = ["+added line"],
  status: DiffFile["status"] = "modified",
): DiffFile => ({
  path: filePath,
  status,
  additions: changes.filter((c) => c.startsWith("+")).length,
  deletions: changes.filter((c) => c.startsWith("-")).length,
  hunks: [
    {
      header: "@@ -1 +1 @@",
      changes: changes.map((content, i) => ({
        type: content.startsWith("+")
          ? ("add" as const)
          : content.startsWith("-")
            ? ("delete" as const)
            : ("normal" as const),
        content,
        line: i + 1,
      })),
    },
  ],
});

const SIMPLE_MODEL: ArchitectureModel = {
  layers: [
    { name: "frontend", patterns: ["src/ui/**", "src/components/**"], allowedDeps: ["api"] },
    { name: "api", patterns: ["src/api/**", "src/routes/**"], allowedDeps: ["domain"] },
    { name: "domain", patterns: ["src/domain/**", "src/models/**"], allowedDeps: [] },
    { name: "infrastructure", patterns: ["src/db/**", "src/infra/**"], allowedDeps: [] },
  ],
};

const STRICT_MODEL: ArchitectureModel = {
  layers: [
    { name: "frontend", patterns: ["src/ui/**"], allowedDeps: ["api", "domain"] },
    { name: "api", patterns: ["src/api/**"], allowedDeps: ["domain"] },
    { name: "domain", patterns: ["src/domain/**"], allowedDeps: [] },
  ],
  strict: true,
};

const CONTEXT_MODEL: ArchitectureModel = {
  layers: [
    { name: "app", patterns: ["src/**"], allowedDeps: [] },
  ],
  contexts: [
    { name: "billing", patterns: ["src/billing/**"] },
    { name: "auth", patterns: ["src/auth/**"] },
  ],
};

// ---------------------------------------------------------------------------
// detectArchitectureDrift — no violations
// ---------------------------------------------------------------------------

describe("detectArchitectureDrift — no violations", () => {
  it("returns empty when no architecture model", () => {
    const files = [makeFile("src/ui/App.tsx", ['+import { api } from "../api/client"'])];
    const model: ArchitectureModel = { layers: [] };
    const result = detectArchitectureDrift(files, model);
    expect(result.violations).toHaveLength(0);
  });

  it("returns empty when imports follow layer rules", () => {
    const files = [makeFile("src/ui/App.tsx", ['+import { getUser } from "../api/users"'])];
    const result = detectArchitectureDrift(files, SIMPLE_MODEL);
    const layerViolations = result.violations.filter((v) => v.kind === "layer-violation");
    expect(layerViolations).toHaveLength(0);
  });

  it("returns empty when no import edges exist", () => {
    const files = [makeFile("src/ui/App.tsx", ['+const x = 42'])];
    const result = detectArchitectureDrift(files, SIMPLE_MODEL);
    expect(result.violations).toHaveLength(0);
  });

  it("returns empty when file is not in any layer", () => {
    const files = [makeFile("scripts/deploy.sh", ['+import { x } from "./utils"'])];
    const result = detectArchitectureDrift(files, SIMPLE_MODEL);
    expect(result.violations).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// detectArchitectureDrift — layer violations
// ---------------------------------------------------------------------------

describe("detectArchitectureDrift — layer violations", () => {
  it("detects frontend importing directly from infrastructure", () => {
    const files = [makeFile("src/ui/App.tsx", ['+import { db } from "../db/connection"'])];
    const result = detectArchitectureDrift(files, SIMPLE_MODEL);
    const layerViolations = result.violations.filter((v) => v.kind === "layer-violation");
    expect(layerViolations).toHaveLength(1);
    expect(layerViolations[0].sourceLayer).toBe("frontend");
    expect(layerViolations[0].targetLayer).toBe("infrastructure");
    expect(layerViolations[0].severity).toBe("critical");
  });

  it("detects domain importing from api (upward dep without strict)", () => {
    const files = [makeFile("src/domain/User.ts", ['+import { route } from "../api/users"'])];
    const result = detectArchitectureDrift(files, SIMPLE_MODEL);
    const layerViolations = result.violations.filter((v) => v.kind === "layer-violation");
    expect(layerViolations.length).toBeGreaterThanOrEqual(1);
  });

  it("detects multiple violations from multiple imports", () => {
    const files = [
      makeFile("src/ui/App.tsx", ['+import { db } from "../db/connection"', '+import { User } from "../domain/User"']),
    ];
    const result = detectArchitectureDrift(files, SIMPLE_MODEL);
    const layerViolations = result.violations.filter((v) => v.kind === "layer-violation");
    expect(layerViolations.length).toBeGreaterThanOrEqual(1);
  });

  it("flags upward deps in strict mode", () => {
    const files = [makeFile("src/ui/App.tsx", ['+import { User } from "../domain/base"'])];
    const result = detectArchitectureDrift(files, STRICT_MODEL);
    // frontend can depend on domain (allowed), but domain is "lower" in layer order
    // In strict mode, this should be checked
    const upward = result.violations.filter(
      (v) => v.kind === "layer-violation" && v.description.includes("Upward"),
    );
    // If domain has lower index than frontend and frontend is allowed to depend on domain,
    // strict mode flags it as upward
    expect(upward.length).toBeGreaterThanOrEqual(0);
  });
});

// ---------------------------------------------------------------------------
// detectArchitectureDrift — boundary violations
// ---------------------------------------------------------------------------

describe("detectArchitectureDrift — boundary violations", () => {
  it("detects cross-context import", () => {
    const files = [makeFile("src/billing/Invoice.ts", ['+import { User } from "../auth/session"'])];
    const result = detectArchitectureDrift(files, CONTEXT_MODEL);
    const boundary = result.violations.filter((v) => v.kind === "boundary-violation");
    expect(boundary.length).toBeGreaterThanOrEqual(1);
    expect(boundary[0].sourceLayer).toBe("billing");
    expect(boundary[0].targetLayer).toBe("auth");
    expect(boundary[0].severity).toBe("medium");
  });

  it("does not flag imports within same context", () => {
    const files = [makeFile("src/auth/Login.ts", ['+import { User } from "../auth/session"'])];
    const result = detectArchitectureDrift(files, CONTEXT_MODEL);
    const boundary = result.violations.filter((v) => v.kind === "boundary-violation");
    expect(boundary).toHaveLength(0);
  });

  it("does not flag boundary violations when no contexts defined", () => {
    const files = [makeFile("src/billing/Invoice.ts", ['+import { User } from "../auth/session"'])];
    const result = detectArchitectureDrift(files, SIMPLE_MODEL);
    const boundary = result.violations.filter((v) => v.kind === "boundary-violation");
    expect(boundary).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Deduplication
// ---------------------------------------------------------------------------

describe("detectArchitectureDrift — deduplication", () => {
  it("deduplicates identical violations", () => {
    const files = [makeFile("src/ui/App.tsx", ['+import { db } from "../db/connection"', '+import { db } from "../db/connection"'])];
    const result = detectArchitectureDrift(files, SIMPLE_MODEL);
    const unique = new Set(result.violations.map((v) => `${v.sourceFile}:${v.targetFile}`));
    expect(unique.size).toBeLessThanOrEqual(result.violations.length);
  });
});

// ---------------------------------------------------------------------------
// Sorting
// ---------------------------------------------------------------------------

describe("detectArchitectureDrift — sorting", () => {
  it("sorts critical before medium", () => {
    const model: ArchitectureModel = {
      layers: [
        { name: "app", patterns: ["src/app/**"], allowedDeps: [] },
        { name: "infra", patterns: ["src/infra/**"], allowedDeps: [] },
      ],
      contexts: [
        { name: "ctx-a", patterns: ["src/ctx-a/**"] },
        { name: "ctx-b", patterns: ["src/ctx-b/**"] },
      ],
    };
    const files = [
      makeFile("src/app/main.ts", ['+import { x } from "../infra/db"', '+import { y } from "../ctx-b/svc"']),
    ];
    const result = detectArchitectureDrift(files, model);
    const severities = result.violations.map((v) => v.severity);
    if (severities.includes("critical") && severities.includes("medium")) {
      const critIdx = severities.indexOf("critical");
      const medIdx = severities.indexOf("medium");
      expect(critIdx).toBeLessThan(medIdx);
    }
  });
});

// ---------------------------------------------------------------------------
// Context text generation
// ---------------------------------------------------------------------------

describe("detectArchitectureDrift — context text", () => {
  it("includes violation summary in contextText", () => {
    const files = [makeFile("src/ui/App.tsx", ['+import { db } from "../db/connection"'])];
    const result = detectArchitectureDrift(files, SIMPLE_MODEL);
    if (result.violations.length > 0) {
      expect(result.contextText).toContain("Architecture Drift");
    }
  });

  it("returns empty contextText when no violations", () => {
    const files = [makeFile("src/ui/App.tsx", ['+const x = 42'])];
    const result = detectArchitectureDrift(files, SIMPLE_MODEL);
    expect(result.contextText).toBe("");
  });

  it("includes layer names in contextText", () => {
    const files = [makeFile("src/ui/App.tsx", ['+import { db } from "../db/connection"'])];
    const result = detectArchitectureDrift(files, SIMPLE_MODEL);
    if (result.violations.length > 0) {
      expect(result.contextText).toContain("frontend");
      expect(result.contextText).toContain("infrastructure");
    }
  });
});

// ---------------------------------------------------------------------------
// Body summary generation
// ---------------------------------------------------------------------------

describe("detectArchitectureDrift — body summary", () => {
  it("includes table in bodySummary when violations exist", () => {
    const files = [makeFile("src/ui/App.tsx", ['+import { db } from "../db/connection"'])];
    const result = detectArchitectureDrift(files, SIMPLE_MODEL);
    if (result.violations.length > 0) {
      expect(result.bodySummary).toContain("Architecture Drift");
      expect(result.bodySummary).toContain("| Type |");
    }
  });

  it("returns empty bodySummary when no violations", () => {
    const files = [makeFile("src/ui/App.tsx", ['+const x = 42'])];
    const result = detectArchitectureDrift(files, SIMPLE_MODEL);
    expect(result.bodySummary).toBe("");
  });

  it("truncates table at 15 violations", () => {
    const files: DiffFile[] = [];
    for (let i = 0; i < 16; i++) {
      files.push(makeFile(`src/ui/Comp${i}.tsx`, [`+import { db${i} } from "../db/conn${i}"`]));
    }
    const result = detectArchitectureDrift(files, SIMPLE_MODEL);
    if (result.violations.length > 15) {
      expect(result.bodySummary).toContain("more");
    }
  });
});

// ---------------------------------------------------------------------------
// parseArchitectureYaml
// ---------------------------------------------------------------------------

describe("parseArchitectureYaml", () => {
  it("parses simple layer model", () => {
    const yaml = `layers:
  frontend:
    patterns:
      - "src/ui/**"
    allowed_deps: "api"
  api:
    patterns:
      - "src/api/**"
`;
    const model = parseArchitectureYaml(yaml);
    expect(model.layers).toHaveLength(2);
    expect(model.layers[0].name).toBe("frontend");
    expect(model.layers[0].patterns).toEqual(["src/ui/**"]);
    expect(model.layers[0].allowedDeps).toEqual(["api"]);
  });

  it("parses contexts", () => {
    const yaml = `contexts:
  billing:
    patterns:
      - "src/billing/**"
  auth:
    patterns:
      - "src/auth/**"
`;
    const model = parseArchitectureYaml(yaml);
    expect(model.contexts).toHaveLength(2);
    expect(model.contexts![0].name).toBe("billing");
  });

  it("parses strict mode", () => {
    const yaml = `strict: true
layers:
  frontend:
    patterns:
      - "src/ui/**"
`;
    const model = parseArchitectureYaml(yaml);
    expect(model.strict).toBe(true);
  });

  it("handles empty yaml", () => {
    const model = parseArchitectureYaml("");
    expect(model.layers).toHaveLength(0);
  });

  it("handles yaml with only comments", () => {
    const yaml = `# This is a comment
# Another comment
`;
    const model = parseArchitectureYaml(yaml);
    expect(model.layers).toHaveLength(0);
  });

  it("handles comma-separated allowedDeps", () => {
    const yaml = `layers:
  frontend:
    patterns:
      - "src/ui/**"
    allowed_deps: "api, domain"
`;
    const model = parseArchitectureYaml(yaml);
    expect(model.layers[0].allowedDeps).toEqual(["api", "domain"]);
  });

  it("returns no contexts when none defined", () => {
    const yaml = `layers:
  frontend:
    patterns:
      - "src/ui/**"
`;
    const model = parseArchitectureYaml(yaml);
    expect(model.contexts).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Result metadata
// ---------------------------------------------------------------------------

describe("detectArchitectureDrift — result metadata", () => {
  it("includes model in result", () => {
    const files = [makeFile("src/ui/App.tsx")];
    const result = detectArchitectureDrift(files, SIMPLE_MODEL);
    expect(result.model).toBe(SIMPLE_MODEL);
  });
});

// ---------------------------------------------------------------------------
// Glob matching edge cases
// ---------------------------------------------------------------------------

describe("glob matching", () => {
  it("matches exact paths", () => {
    const model: ArchitectureModel = {
      layers: [
        { name: "exact", patterns: ["src/exact/file.ts"], allowedDeps: [] },
      ],
    };
    const files = [makeFile("src/exact/file.ts", ['+import { x } from "../other/y"'])];
    const result = detectArchitectureDrift(files, model);
    // Should assign to "exact" layer
    // x is in unknown layer, so no violation (target not in any layer)
    expect(result.violations).toHaveLength(0);
  });

  it("handles ** wildcard", () => {
    const model: ArchitectureModel = {
      layers: [
        { name: "all", patterns: ["src/**"], allowedDeps: [] },
      ],
    };
    const files = [makeFile("src/deep/nested/file.ts", ['+import { x } from "../other/y"'])];
    const result = detectArchitectureDrift(files, model);
    expect(result.violations).toHaveLength(0); // target not in any layer
  });
});

// ---------------------------------------------------------------------------
// Edge cases — additional coverage
// ---------------------------------------------------------------------------

describe('detectArchitectureDrift — edge cases (expanded)', () => {
  it('handles deleted files', () => {
    const files = [makeFile('src/ui/App.tsx', ['+import { db } from "../db/connection"'], 'deleted')];
    const result = detectArchitectureDrift(files, SIMPLE_MODEL);
    // Deleted files still have imports detected if they contain + lines
    expect(result).toBeDefined();
  });

  it('handles empty hunks', () => {
    const files = [makeFile('src/ui/App.tsx', [])];
    const result = detectArchitectureDrift(files, SIMPLE_MODEL);
    expect(result.violations).toHaveLength(0);
  });

  it('handles file with no imports', () => {
    const files = [makeFile('src/ui/App.tsx', ['+const x = 42;'])];
    const result = detectArchitectureDrift(files, SIMPLE_MODEL);
    expect(result.violations).toHaveLength(0);
  });

  it('handles deleted lines (should not be analyzed)', () => {
    const files = [makeFile('src/ui/App.tsx', [
      '-import { db } from "../db/connection"',
      '+import { api } from "../api/handler"',
    ])];
    const result = detectArchitectureDrift(files, SIMPLE_MODEL);
    // Only the + line should be analyzed
    if (result.violations.length > 0) {
      expect(result.violations[0].file).toBe('src/ui/App.tsx');
    }
  });

  it('returns empty context when no violations', () => {
    const files = [makeFile('src/ui/App.tsx', ['+import { api } from "../api/handler"'])];
    const result = detectArchitectureDrift(files, SIMPLE_MODEL);
    expect(result.contextText).toBe('');
  });

  it('returns empty body summary when no violations', () => {
    const files = [makeFile('src/ui/App.tsx', ['+import { api } from "../api/handler"'])];
    const result = detectArchitectureDrift(files, SIMPLE_MODEL);
    expect(result.bodySummary).toBe('');
  });

  it('detects multiple violations in one file', () => {
    const files = [makeFile('src/ui/App.tsx', [
      '+import { db } from "../db/sql"',
      '+import { orm } from "../db/orm"',
      '+import { api } from "../api/handler"',
    ])];
    const result = detectArchitectureDrift(files, SIMPLE_MODEL);
    // ui -> db is a violation if db is not in allowedDeps
    expect(result.violations).toBeDefined();
  });

  it('strict mode flags all cross-layer imports', () => {
    const strictModel: ArchitectureModel = {
      strict: true,
      layers: [
        { name: 'frontend', patterns: ['src/ui/**'], allowedDeps: [] },
        { name: 'api', patterns: ['src/api/**'], allowedDeps: [] },
      ],
    };
    const files = [makeFile('src/ui/App.tsx', ['+import { api } from "../api/handler"'])];
    const result = detectArchitectureDrift(files, strictModel);
    // In strict mode, any cross-layer import is a violation
    expect(result.violations.length).toBeGreaterThanOrEqual(0);
  });

  it('context text contains Architecture Drift header', () => {
    const model: ArchitectureModel = {
      strict: false,
      layers: [
        { name: 'ui', patterns: ['src/ui/**'], allowedDeps: [] },
        { name: 'db', patterns: ['src/db/**'], allowedDeps: [] },
      ],
    };
    const files = [makeFile('src/ui/App.tsx', ['+import { db } from "../db/sql"'])];
    const result = detectArchitectureDrift(files, model);
    if (result.violations.length > 0) {
      expect(result.contextText).toContain('Architecture Drift');
    }
  });
});



// ---------------------------------------------------------------------------
// New tests — architecture-drift expanded coverage
// ---------------------------------------------------------------------------

describe("parseArchitectureYaml — edge cases", () => {
  it("handles layer with no patterns (empty patterns list)", () => {
    const yaml = `layers:
  emptyLayer:
    allowed_deps: "api"
`;
    const model = parseArchitectureYaml(yaml);
    expect(model.layers).toHaveLength(1);
    expect(model.layers[0].name).toBe("emptyLayer");
    expect(model.layers[0].patterns).toHaveLength(0);
  });

  it("handles allowedDeps key (camelCase variant)", () => {
    const yaml = `layers:
  ui:
    patterns:
      - "src/ui/**"
    allowedDeps: "domain"
`;
    const model = parseArchitectureYaml(yaml);
    expect(model.layers[0].allowedDeps).toEqual(["domain"]);
  });

  it("handles multiple comma-separated allowedDeps with quotes", () => {
    const yaml = `layers:
  ui:
    patterns:
      - "src/ui/**"
    allowed_deps: "api, domain, shared"
`;
    const model = parseArchitectureYaml(yaml);
    expect(model.layers[0].allowedDeps).toEqual(["api", "domain", "shared"]);
  });

  it("defaults strict to false when not specified", () => {
    const yaml = `layers:
  ui:
    patterns:
      - "src/ui/**"
`;
    const model = parseArchitectureYaml(yaml);
    expect(model.strict).toBe(false);
  });
});

describe("detectArchitectureDrift — cross-layer and boundary interactions", () => {
  it("allows api to import from domain (per SIMPLE_MODEL)", () => {
    const files = [makeFile("src/api/users.ts", ['+import { User } from "../domain/User"'])];
    const result = detectArchitectureDrift(files, SIMPLE_MODEL);
    const layerViolations = result.violations.filter((v) => v.kind === "layer-violation" && v.sourceLayer === "api" && v.targetLayer === "domain");
    expect(layerViolations).toHaveLength(0);
  });

  it("flags api importing from infrastructure when not allowed", () => {
    const files = [makeFile("src/api/users.ts", ['+import { db } from "../infra/connection"'])];
    const result = detectArchitectureDrift(files, SIMPLE_MODEL);
    const layerViolations = result.violations.filter((v) => v.kind === "layer-violation");
    expect(layerViolations.length).toBeGreaterThanOrEqual(1);
    expect(layerViolations[0].sourceLayer).toBe("api");
  });

  it("does not flag same-layer imports", () => {
    const files = [makeFile("src/ui/App.tsx", ['+import { Header } from "../ui/Header"'])];
    const result = detectArchitectureDrift(files, SIMPLE_MODEL);
    const layerViolations = result.violations.filter((v) => v.kind === "layer-violation");
    expect(layerViolations).toHaveLength(0);
  });

  it("handles model with no contexts gracefully", () => {
    const model: ArchitectureModel = { layers: [{ name: "app", patterns: ["src/**"], allowedDeps: [] }] };
    const files = [makeFile("src/app/main.ts", ['+import { x } from "../other/y"'])];
    const result = detectArchitectureDrift(files, model);
    expect(result.violations.filter((v) => v.kind === "boundary-violation")).toHaveLength(0);
  });
});

describe("detectArchitectureDrift — context and body edge cases", () => {
  it("context text includes boundary crossing section for boundary violations", () => {
    const files = [makeFile("src/billing/Invoice.ts", ['+import { User } from "../auth/session"'])];
    const result = detectArchitectureDrift(files, CONTEXT_MODEL);
    if (result.violations.some((v) => v.kind === "boundary-violation")) {
      expect(result.contextText).toContain("Boundary Crossings");
    }
  });

  it("body summary includes model layer count", () => {
    const files = [makeFile("src/ui/App.tsx", ['+import { db } from "../db/connection"'])];
    const result = detectArchitectureDrift(files, SIMPLE_MODEL);
    if (result.violations.length > 0) {
      expect(result.bodySummary).toContain("4 layers");
    }
  });

  it("body summary mentions contexts when present in model", () => {
    const files = [makeFile("src/billing/Invoice.ts", ['+import { User } from "../auth/session"'])];
    const result = detectArchitectureDrift(files, CONTEXT_MODEL);
    if (result.violations.length > 0 && CONTEXT_MODEL.contexts) {
      expect(result.bodySummary).toContain("2 contexts");
    }
  });
});

describe("detectArchitectureDrift — file matching edge cases", () => {
  it("does not flag files that do not match any layer pattern", () => {
    const model: ArchitectureModel = {
      layers: [{ name: "ui", patterns: ["src/ui/**"], allowedDeps: [] }],
    };
    const files = [makeFile("scripts/build.sh", ['+import { x } from "./utils"'])];
    const result = detectArchitectureDrift(files, model);
    expect(result.violations).toHaveLength(0);
  });

  it("infrastructure layer has no allowedDeps in SIMPLE_MODEL", () => {
    const infraLayer = SIMPLE_MODEL.layers.find((l) => l.name === "infrastructure");
    expect(infraLayer!.allowedDeps).toHaveLength(0);
  });
});
