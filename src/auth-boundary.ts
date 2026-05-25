/**
 * Auth Boundary Detector — deterministic pre-scan for missing authentication
 * on route handler boundaries.
 *
 * Competitive gap: OWASP #1 is broken access control. Every AI code reviewer
 * flags SQL injection and XSS (we do too in rules.ts), but NONE check
 * whether route handlers actually enforce authentication. The existing
 * rule in rules.ts is limited (Express routes in routes/ dirs only).
 *
 * This module expands auth boundary detection across 6 frameworks:
 * 1. Express: app.get/post/... (req, res) => {}
 * 2. Fastify: fastify.get/post/... (req, reply) => {}
 * 3. Koa: router.get/post/... (ctx, next) => {}
 * 4. Next.js API routes: export default function handler(req, res)
 * 5. NestJS: @Controller + @Get/@Post decorators
 * 6. Hono: app.get/post/... (c) => {}
 *
 * Signals:
 * - Route handler without auth middleware in the same file or surrounding block
 * - No auth guard (requireAuth, isAuthenticated, jwt.verify, etc.)
 * - No auth decorator (@UseGuards, @Authenticated, etc.)
 * - No auth middleware passed as argument to the route
 *
 * Whitelist (not flagged):
 * - Public endpoints: /health, /status, /ping, /public, /login, /register, /webhook, /callback
 * - Files with auth middleware applied globally or at router level
 * - Handler bodies that explicitly skip auth with comments: @public, @no-auth
 *
 * Heuristic: If a route handler appears in a file that also has auth middleware
 * defined/applied, we assume coverage. Only flag when no auth signal is present
 * anywhere in the file.
 */
import * as core from "@actions/core";
import { DiffFile } from "./diff.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AuthBoundaryFinding {
  /** File where the unauthenticated route was found */
  file: string;
  /** Line number of the route definition */
  line: number;
  /** HTTP method */
  method: string;
  /** Route path (if extractable) */
  route: string;
  /** Framework detected */
  framework: string;
  /** Severity */
  severity: "high" | "medium";
}

export interface AuthBoundaryResult {
  findings: AuthBoundaryFinding[];
  totalRoutes: number;
  unprotectedRoutes: number;
  frameworks: string[];
}

// ---------------------------------------------------------------------------
// Route definition patterns per framework
// ---------------------------------------------------------------------------

interface RoutePattern {
  framework: string;
  /** Regex for route definitions */
  routeRe: RegExp;
  /** Method capture group index */
  methodGroup: number;
  /** Path capture group index */
  pathGroup: number;
}

const ROUTE_PATTERNS: RoutePattern[] = [
  // Express/Fastify/Hono: app.get('/path', ...) or router.post('/path', ...)
  {
    framework: "express",
    routeRe: /(?:app|router|server|fastify|hono|api)\s*\.\s*(get|post|put|delete|patch|all|route)\s*\(\s*['"`]([^'"`]+)['"`]/i,
    methodGroup: 1,
    pathGroup: 2,
  },
  // Koa: router.get('/path', ...)
  {
    framework: "koa",
    routeRe: /(?:router|Router)\s*\.\s*(get|post|put|delete|patch|all)\s*\(\s*['"`]([^'"`]+)['"`]/i,
    methodGroup: 1,
    pathGroup: 2,
  },
  // Next.js API route: export default function handler(req, res)
  {
    framework: "nextjs",
    routeRe: /export\s+default\s+(?:async\s+)?function\s+handler\s*\(\s*(?:req|request)/i,
    methodGroup: 0,
    pathGroup: 0,
  },
  // NestJS: @Get('/path') or @Post('path')
  {
    framework: "nestjs",
    routeRe: /@(Get|Post|Put|Delete|Patch|All|RequestMapping)\s*\(\s*(?:['"`]([^'"`]+)['"`])?/i,
    methodGroup: 1,
    pathGroup: 2,
  },
];

// ---------------------------------------------------------------------------
// Auth signal patterns
// ---------------------------------------------------------------------------

/** Patterns that indicate auth is being checked */
const AUTH_SIGNALS = [
  /\brequireAuth\b/i,
  /\bisAuthenticated\b/i,
  /\bauthenticate\b/i,
  /\bauthMiddleware\b/i,
  /\bauthGuard\b/i,
  /\bverifyToken\b/i,
  /\bjwt\.verify\b/i,
  /\bjwt\.decode\b/i,
  /\bcheckAuth\b/i,
  /\bvalidateToken\b/i,
  /\bverifySession\b/i,
  /\bsession\.user\b/i,
  /\breq\.user\b/i,
  /\bctx\.user\b/i,
  /\bc\.user\b/i,
  /\brequest\.user\b/i,
  /\bcurrentUser\b/i,
  /@UseGuards\b/,
  /@Authenticated\b/i,
  /@RequireAuth\b/i,
  /@Public\b/i,             // Explicitly marked as public
  /@NoAuth\b/i,             // Explicitly marked as no-auth
  /\bauth\s*\(/i,           // auth() call
  /\bprotect\b/i,           // protect() middleware
  /\bensureAuthenticated\b/i,
  /\bpassport\.authenticate\b/,
  /\bFirebaseAuthGuard\b/i,
  /\bCanActivate\b/,        // NestJS guard interface
  /@InjectGuard\b/i,
];

/** Public endpoint patterns — not flagged even without auth */
const PUBLIC_ROUTE_PATTERNS = [
  /^\/healthz?$/i,
  /^\/status$/i,
  /^\/ping$/i,
  /^\/readiness$/i,
  /^\/liveness$/i,
  /^\/version$/i,
  /^\/metrics$/i,
  /^\/public\b/i,
  /^\/login$/i,
  /^\/register$/i,
  /^\/signup$/i,
  /^\/auth\/(login|register|callback|token|refresh|verify)/i,
  /^\/oauth\b/i,
  /^\/webhook/i,
  /^\/callback/i,
  /^\/api-docs/i,
  /^\/swagger/i,
  /^\/graphql/i,             // Often public, but may have auth at middleware level
];

// ---------------------------------------------------------------------------
// Core logic
// ---------------------------------------------------------------------------

/** Check if a route path is a public endpoint that doesn't need auth */
export function isPublicRoute(path: string): boolean {
  if (!path) return false;
  return PUBLIC_ROUTE_PATTERNS.some((re) => re.test(path));
}

/** Check if a line contains an auth signal */
export function hasAuthSignal(content: string): boolean {
  return AUTH_SIGNALS.some((re) => re.test(content));
}

/** Check if a line explicitly marks the route as public/no-auth */
export function isExplicitlyPublic(content: string): boolean {
  return /@(Public|NoAuth)\b/i.test(content) || /\/\/\s*@public\b/i.test(content) || /\/\/\s*@no-auth\b/i.test(content);
}

/** Check if a file path suggests a Next.js API route */
export function isNextjsApiRoute(filePath: string): boolean {
  return /pages\/api\/|app\/api\//.test(filePath) && /\.ts$|\.js$|\.tsx$|\.jsx$/.test(filePath);
}

/** Detect route definitions in a single file's diff content */
export function detectRoutesInFile(file: DiffFile): Array<{
  line: number;
  method: string;
  route: string;
  framework: string;
  surroundingBlock: string[];
}> {
  const routes: Array<{
    line: number;
    method: string;
    route: string;
    framework: string;
    surroundingBlock: string[];
  }> = [];

  // Check if this is a Next.js API route file
  const nextjsApiRoute = isNextjsApiRoute(file.path);

  for (const hunk of file.hunks) {

    for (const change of hunk.changes) {
      if (change.type !== "add") continue;

      // Check each route pattern
      for (const pattern of ROUTE_PATTERNS) {
        // Skip NestJS pattern for non-NestJS files
        if (pattern.framework === "nestjs" && !file.path.includes(".controller.") && !file.path.includes(".module.")) continue;
        // Skip Next.js pattern for non-API-route files
        if (pattern.framework === "nextjs" && !nextjsApiRoute) continue;

        const match = change.content.match(pattern.routeRe);
        if (!match) continue;

        const method = pattern.methodGroup > 0 ? match[pattern.methodGroup].toLowerCase() : "any";
        const route = pattern.pathGroup > 0 ? (match[pattern.pathGroup] || "/") : "/";

        const surroundingBlock = hunk.changes
          .filter((c) => Math.abs(c.line - change.line) <= 15 && c.type !== "delete")
          .map((c) => c.content);

        routes.push({ line: change.line, method, route, framework: pattern.framework, surroundingBlock });
        break; // Don't match the same line against multiple patterns
      }
    }
  }

  return routes;
}

/** Check if auth signals exist in the file or surrounding block */
export function checkAuthPresence(routes: Array<{
  surroundingBlock: string[];
  route: string;
}>, fileContent: string[]): boolean {
  // If any auth signal appears in the file content, assume auth is present
  const fileHasAuth = fileContent.some((line) => hasAuthSignal(line));
  if (fileHasAuth) return true;

  // Check each route's surrounding block
  for (const route of routes) {
    if (route.surroundingBlock.some((line) => hasAuthSignal(line))) return true;
  }

  return false;
}

/**
 * Run auth boundary analysis on diff files.
 * Detects route handlers without auth signals.
 */
export function runAuthBoundaryAnalysis(files: DiffFile[]): AuthBoundaryResult {
  const findings: AuthBoundaryFinding[] = [];
  const frameworks = new Set<string>();
  let totalRoutes = 0;

  for (const file of files) {
    const routes = detectRoutesInFile(file);
    if (routes.length === 0) continue;

    totalRoutes += routes.length;

    // Get all non-deleted lines in the file for auth signal scanning
    const fileContent: string[] = [];
    for (const hunk of file.hunks) {
      for (const change of hunk.changes) {
        if (change.type !== "delete") {
          fileContent.push(change.content);
        }
      }
    }

    // Check if the file has auth signals
    const fileHasAuth = checkAuthPresence(routes, fileContent);

    for (const route of routes) {
      frameworks.add(route.framework);

      // Skip public routes
      if (isPublicRoute(route.route)) continue;

      // Skip explicitly marked public routes
      const isMarkedPublic = route.surroundingBlock.some((line) => isExplicitlyPublic(line));
      if (isMarkedPublic) continue;

      // If the file has auth signals, assume this route is covered
      if (fileHasAuth) continue;

      // Check if auth middleware is passed as argument to the route
      // Pattern: app.get('/path', authMiddleware, handler)
      const routeLine = route.surroundingBlock.find((l) =>
        /(?:app|router|server|fastify|hono)\s*\.\s*(get|post|put|delete|patch)\s*\(/i.test(l)
      );
      if (routeLine && hasAuthSignal(routeLine)) continue;

      // No auth signal found — flag it
      findings.push({
        file: file.path,
        line: route.line,
        method: route.method,
        route: route.route,
        framework: route.framework,
        severity: "high",
      });
    }
  }

  if (findings.length > 0) {
    core.info(`Auth boundary: ${findings.length} unprotected routes in ${files.length} files (${totalRoutes} total routes)`);
  }

  return {
    findings,
    totalRoutes,
    unprotectedRoutes: findings.length,
    frameworks: [...frameworks],
  };
}

/** Build auth boundary context for LLM prompt injection */
export function buildAuthBoundaryContext(result: AuthBoundaryResult): string {
  if (result.findings.length === 0) return "";

  let ctx = `## Auth Boundary — Unprotected Routes (${result.findings.length})\n`;
  ctx += "The following route handlers have NO authentication signals detected. ";
  ctx += "Verify each route should be publicly accessible:\n\n";

  for (const f of result.findings.slice(0, 12)) {
    ctx += `- \`${f.file}:${f.line}\` — ${f.method.toUpperCase()} ${f.route} (${f.framework})\n`;
  }

  if (result.findings.length > 12) {
    ctx += `- ... and ${result.findings.length - 12} more\n`;
  }

  ctx += `\n**Routes scanned:** ${result.totalRoutes} | **Frameworks:** ${result.frameworks.join(", ")}\n`;

  return ctx.trim();
}
