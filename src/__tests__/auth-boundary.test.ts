import { describe, it, expect, vi } from "vitest";
import {
  isPublicRoute,
  hasAuthSignal,
  isExplicitlyPublic,
  isNextjsApiRoute,
  detectRoutesInFile,
  runAuthBoundaryAnalysis,
  buildAuthBoundaryContext,
} from "../auth-boundary.js";
import type { DiffFile } from "../diff.js";

vi.mock("@actions/core", () => ({
  info: vi.fn(),
  warning: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeHunk(changes: Array<{ type: "add" | "delete" | "normal"; content: string; line: number }>) {
  return {
    oldStart: 1, oldLines: changes.length, newStart: 1, newLines: changes.length,
    content: "",
    changes: changes.map((c) => ({
      type: c.type, content: c.content, line: c.line,
      oldLine: c.type === "normal" ? c.line : c.type === "delete" ? c.line : 0,
    })),
  };
}

function makeDiffFile(path: string, addedLines: string[], allLines?: string[]): DiffFile {
  const changes = addedLines.map((content, i) => ({ type: "add" as const, content, line: i + 1 }));
  if (allLines) {
    return {
      path, status: "modified" as const, additions: addedLines.length, deletions: 0,
      hunks: [makeHunk(allLines.map((content, i) => ({ type: "normal" as const, content, line: i + 1 })))],
    };
  }
  return {
    path, status: "modified" as const, additions: addedLines.length, deletions: 0,
    hunks: [makeHunk(changes)],
  };
}

function makeRouteDiffFile(path: string, addedLines: string[]): DiffFile {
  return makeDiffFile(path, addedLines);
}

// ---------------------------------------------------------------------------
// isPublicRoute
// ---------------------------------------------------------------------------

describe("isPublicRoute", () => {
  it("flags /health as public", () => {
    expect(isPublicRoute("/health")).toBe(true);
  });

  it("flags /healthz as public", () => {
    expect(isPublicRoute("/healthz")).toBe(true);
  });

  it("flags /status as public", () => {
    expect(isPublicRoute("/status")).toBe(true);
  });

  it("flags /ping as public", () => {
    expect(isPublicRoute("/ping")).toBe(true);
  });

  it("flags /login as public", () => {
    expect(isPublicRoute("/login")).toBe(true);
  });

  it("flags /register as public", () => {
    expect(isPublicRoute("/register")).toBe(true);
  });

  it("flags /auth/callback as public", () => {
    expect(isPublicRoute("/auth/callback")).toBe(true);
  });

  it("flags /webhook/* as public", () => {
    expect(isPublicRoute("/webhook/stripe")).toBe(true);
  });

  it("flags /api-docs as public", () => {
    expect(isPublicRoute("/api-docs")).toBe(true);
  });

  it("flags /public/* as public", () => {
    expect(isPublicRoute("/public/assets")).toBe(true);
  });

  it("does NOT flag /api/users as public", () => {
    expect(isPublicRoute("/api/users")).toBe(false);
  });

  it("does NOT flag /admin as public", () => {
    expect(isPublicRoute("/admin")).toBe(false);
  });

  it("does NOT flag /profile as public", () => {
    expect(isPublicRoute("/profile")).toBe(false);
  });

  it("returns false for empty path", () => {
    expect(isPublicRoute("")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// hasAuthSignal
// ---------------------------------------------------------------------------

describe("hasAuthSignal", () => {
  it("detects requireAuth", () => {
    expect(hasAuthSignal("router.get('/profile', requireAuth, handler)")).toBe(true);
  });

  it("detects isAuthenticated", () => {
    expect(hasAuthSignal("if (req.isAuthenticated()) {")).toBe(true);
  });

  it("detects jwt.verify", () => {
    expect(hasAuthSignal("const decoded = jwt.verify(token, secret)")).toBe(true);
  });

  it("detects req.user", () => {
    expect(hasAuthSignal("const userId = req.user.id")).toBe(true);
  });

  it("detects @UseGuards", () => {
    expect(hasAuthSignal("@UseGuards(AuthGuard)")).toBe(true);
  });

  it("detects passport.authenticate", () => {
    expect(hasAuthSignal("passport.authenticate('jwt', { session: false })")).toBe(true);
  });

  it("detects ensureAuthenticated", () => {
    expect(hasAuthSignal("app.use(ensureAuthenticated)")).toBe(true);
  });

  it("detects @Public decorator", () => {
    expect(hasAuthSignal("@Public()")).toBe(true);
  });

  it("returns false for no auth signal", () => {
    expect(hasAuthSignal("router.get('/data', handler)")).toBe(false);
  });

  it("returns false for ordinary code", () => {
    expect(hasAuthSignal("const x = 42")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// isExplicitlyPublic
// ---------------------------------------------------------------------------

describe("isExplicitlyPublic", () => {
  it("detects @Public decorator", () => {
    expect(isExplicitlyPublic("@Public()")).toBe(true);
  });

  it("detects @NoAuth decorator", () => {
    expect(isExplicitlyPublic("@NoAuth()")).toBe(true);
  });

  it("detects //@public comment", () => {
    expect(isExplicitlyPublic("// @public")).toBe(true);
  });

  it("detects //@no-auth comment", () => {
    expect(isExplicitlyPublic("// @no-auth")).toBe(true);
  });

  it("does not flag ordinary code", () => {
    expect(isExplicitlyPublic("const handler = (req, res) => {}")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// isNextjsApiRoute
// ---------------------------------------------------------------------------

describe("isNextjsApiRoute", () => {
  it("detects pages/api route", () => {
    expect(isNextjsApiRoute("pages/api/users.ts")).toBe(true);
  });

  it("detects app/api route", () => {
    expect(isNextjsApiRoute("app/api/auth/login/route.ts")).toBe(true);
  });

  it("does not flag non-API route", () => {
    expect(isNextjsApiRoute("src/components/Button.tsx")).toBe(false);
  });

  it("does not flag non-TS/JS file", () => {
    expect(isNextjsApiRoute("pages/api/users.css")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// detectRoutesInFile
// ---------------------------------------------------------------------------

describe("detectRoutesInFile", () => {
  it("detects Express route definitions", () => {
    const file = makeRouteDiffFile("src/routes/users.ts", [
      "router.get('/api/users', handler)",
    ]);
    const routes = detectRoutesInFile(file);
    expect(routes).toHaveLength(1);
    expect(routes[0].method).toBe("get");
    expect(routes[0].route).toBe("/api/users");
    expect(routes[0].framework).toBe("express");
  });

  it("detects POST route definitions", () => {
    const file = makeRouteDiffFile("src/routes/auth.ts", [
      "app.post('/api/login', loginHandler)",
    ]);
    const routes = detectRoutesInFile(file);
    expect(routes).toHaveLength(1);
    expect(routes[0].method).toBe("post");
  });

  it("detects multiple routes in same file", () => {
    const file = makeRouteDiffFile("src/routes/api.ts", [
      "router.get('/users', getUsers)",
      "router.post('/users', createUser)",
      "router.delete('/users/:id', deleteUser)",
    ]);
    const routes = detectRoutesInFile(file);
    expect(routes).toHaveLength(3);
  });

  it("detects Koa routes", () => {
    const file = makeRouteDiffFile("src/routes/index.ts", [
      "router.get('/items', listItems)",
    ]);
    const routes = detectRoutesInFile(file);
    expect(routes.length).toBeGreaterThanOrEqual(1);
  });

  it("detects Next.js API route handler", () => {
    const file = makeRouteDiffFile("pages/api/users.ts", [
      "export default function handler(req, res) {",
    ]);
    const routes = detectRoutesInFile(file);
    expect(routes).toHaveLength(1);
    expect(routes[0].framework).toBe("nextjs");
  });

  it("detects NestJS controller decorators only in controller files", () => {
    const file = makeRouteDiffFile("src/users.controller.ts", [
      "@Get('/users')",
      "findAll() {}",
    ]);
    const routes = detectRoutesInFile(file);
    expect(routes.length).toBeGreaterThanOrEqual(1);
  });

  it("skips NestJS pattern for non-controller files", () => {
    const file = makeRouteDiffFile("src/users.service.ts", [
      "@Get('/users')",
    ]);
    const routes = detectRoutesInFile(file);
    expect(routes).toHaveLength(0);
  });

  it("returns empty for files without route definitions", () => {
    const file = makeRouteDiffFile("src/utils.ts", [
      "const x = 42;",
      "export function helper() {}",
    ]);
    const routes = detectRoutesInFile(file);
    expect(routes).toHaveLength(0);
  });

  it("only scans added lines", () => {
    const file: DiffFile = {
      path: "src/routes/api.ts", status: "modified", additions: 0, deletions: 1,
      hunks: [makeHunk([{ type: "delete", content: "router.get('/old', handler)", line: 1 }])],
    };
    const routes = detectRoutesInFile(file);
    expect(routes).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// runAuthBoundaryAnalysis
// ---------------------------------------------------------------------------

describe("runAuthBoundaryAnalysis", () => {
  it("returns empty for diff without routes", () => {
    const files = [makeDiffFile("src/utils.ts", ["const x = 42;"])];
    const result = runAuthBoundaryAnalysis(files);
    expect(result.findings).toHaveLength(0);
    expect(result.totalRoutes).toBe(0);
    expect(result.unprotectedRoutes).toBe(0);
  });

  it("flags route without auth signal", () => {
    const files = [makeRouteDiffFile("src/routes/users.ts", [
      "router.get('/api/users', (req, res) => {",
      "  const users = db.query('SELECT * FROM users')",
      "  res.json(users)",
      "})",
    ])];
    const result = runAuthBoundaryAnalysis(files);
    expect(result.findings.length).toBeGreaterThanOrEqual(1);
    expect(result.findings[0].method).toBe("get");
    expect(result.findings[0].route).toBe("/api/users");
  });

  it("does not flag route with auth middleware", () => {
    const files = [makeRouteDiffFile("src/routes/users.ts", [
      "router.get('/api/users', requireAuth, (req, res) => {",
      "  res.json(req.user)",
      "})",
    ])];
    const result = runAuthBoundaryAnalysis(files);
    expect(result.findings).toHaveLength(0);
  });

  it("does not flag public routes like /health", () => {
    const files = [makeRouteDiffFile("src/routes/health.ts", [
      "router.get('/health', (req, res) => { res.json({ ok: true }) })",
    ])];
    const result = runAuthBoundaryAnalysis(files);
    expect(result.findings).toHaveLength(0);
  });

  it("does not flag login routes", () => {
    const files = [makeRouteDiffFile("src/routes/auth.ts", [
      "router.post('/login', (req, res) => { /* login logic */ })",
    ])];
    const result = runAuthBoundaryAnalysis(files);
    expect(result.findings).toHaveLength(0);
  });

  it("does not flag webhook routes", () => {
    const files = [makeRouteDiffFile("src/routes/webhooks.ts", [
      "router.post('/webhook/stripe', (req, res) => { /* verify sig */ })",
    ])];
    const result = runAuthBoundaryAnalysis(files);
    expect(result.findings).toHaveLength(0);
  });

  it("does not flag routes with @Public decorator", () => {
    const files = [makeRouteDiffFile("src/routes/public.ts", [
      "@Public()",
      "router.get('/api/config', (req, res) => { res.json({}) })",
    ])];
    const result = runAuthBoundaryAnalysis(files);
    expect(result.findings).toHaveLength(0);
  });

  it("does not flag when auth exists elsewhere in file", () => {
    const files = [makeRouteDiffFile("src/routes/admin.ts", [
      "const authMiddleware = requireAuth;",
      "router.get('/api/admin/users', (req, res) => { res.json([]) })",
    ])];
    const result = runAuthBoundaryAnalysis(files);
    expect(result.findings).toHaveLength(0);
  });

  it("detects frameworks used", () => {
    const files = [makeRouteDiffFile("src/routes/api.ts", [
      "app.get('/api/data', handler)",
    ])];
    const result = runAuthBoundaryAnalysis(files);
    expect(result.frameworks).toContain("express");
  });

  it("counts total routes scanned", () => {
    const files = [makeRouteDiffFile("src/routes/api.ts", [
      "router.get('/a', handler)",
      "router.post('/b', handler)",
      "router.delete('/c', handler)",
    ])];
    const result = runAuthBoundaryAnalysis(files);
    expect(result.totalRoutes).toBe(3);
  });

  it("handles auth middleware as route argument", () => {
    const files = [makeRouteDiffFile("src/routes/protected.ts", [
      "router.post('/api/data', authenticate, (req, res) => { })",
    ])];
    const result = runAuthBoundaryAnalysis(files);
    expect(result.findings).toHaveLength(0);
  });

  it("flags Next.js API route without auth", () => {
    const files = [makeRouteDiffFile("pages/api/admin.ts", [
      "export default function handler(req, res) {",
      "  const data = db.query('...')",
      "  res.json(data)",
      "}",
    ])];
    const result = runAuthBoundaryAnalysis(files);
    expect(result.findings.length).toBeGreaterThanOrEqual(1);
    expect(result.findings[0].framework).toBe("nextjs");
  });

  it("does not flag Next.js route with auth check", () => {
    const files = [makeRouteDiffFile("pages/api/protected.ts", [
      "import { verifyToken } from '../../lib/auth'",
      "export default function handler(req, res) {",
      "  const user = verifyToken(req.headers.authorization)",
      "  res.json({ user })",
      "}",
    ])];
    const result = runAuthBoundaryAnalysis(files);
    expect(result.findings).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// buildAuthBoundaryContext
// ---------------------------------------------------------------------------

describe("buildAuthBoundaryContext", () => {
  it("returns empty string for no findings", () => {
    const result = { findings: [], totalRoutes: 0, unprotectedRoutes: 0, frameworks: [] };
    expect(buildAuthBoundaryContext(result)).toBe("");
  });

  it("formats unprotected routes with framework and method", () => {
    const result = {
      findings: [{
        file: "src/routes/api.ts", line: 10, method: "get",
        route: "/api/users", framework: "express", severity: "high" as const,
      }],
      totalRoutes: 3, unprotectedRoutes: 1, frameworks: ["express"],
    };
    const ctx = buildAuthBoundaryContext(result);
    expect(ctx).toContain("Auth Boundary");
    expect(ctx).toContain("/api/users");
    expect(ctx).toContain("GET");
    expect(ctx).toContain("express");
    expect(ctx).toContain("3");
  });

  it("truncates at 12 findings", () => {
    const findings = Array.from({ length: 15 }, (_, i) => ({
      file: `src/route${i}.ts`, line: i + 1, method: "get" as const,
      route: `/api/r${i}`, framework: "express", severity: "high" as const,
    }));
    const result = { findings, totalRoutes: 15, unprotectedRoutes: 15, frameworks: ["express"] };
    const ctx = buildAuthBoundaryContext(result);
    expect(ctx).toContain("and 3 more");
    expect(ctx).toContain("src/route0.ts");
    expect(ctx).toContain("src/route11.ts");
  });

  it("includes frameworks list", () => {
    const result = {
      findings: [{
        file: "src/api.ts", line: 1, method: "post" as const,
        route: "/data", framework: "koa", severity: "high" as const,
      }],
      totalRoutes: 1, unprotectedRoutes: 1, frameworks: ["koa"],
    };
    const ctx = buildAuthBoundaryContext(result);
    expect(ctx).toContain("Frameworks:");
    expect(ctx).toContain("koa");
  });
});
