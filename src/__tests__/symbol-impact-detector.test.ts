/**
 * Tests for Symbol-Level Impact Detector
 */
import { describe, it, expect } from "vitest";
import { detectSymbolImpact } from "../symbol-impact-detector.js";
import type { DiffFile } from "../diff.js";

function makeDiffFile(path: string, added: string[], status: "modified" | "added" = "modified"): DiffFile {
const changes = added.map((content, i) => ({ type: "add" as const, content: `+${content}`, line: i + 1, ln: i + 1 }));
return {
path,
status,
hunks: [{ header: "@@ -0 +0 @@", changes }],
};
}

// ---------------------------------------------------------------------------
// Exported symbol extraction
// ---------------------------------------------------------------------------

describe("detectSymbolImpact — exported function", () => {
it("detects exported function with caller in different file", () => {
const sourceFile = makeDiffFile("src/utils.ts", [
"export function getUser(id: string) { return db.find(id); }",
]);
const consumerFile = makeDiffFile("src/handler.ts", [
'import { getUser } from "./utils.js";',
"const user = getUser(userId);",
]);
const result = detectSymbolImpact([sourceFile, consumerFile]);
expect(result.issues.length).toBeGreaterThanOrEqual(1);
expect(result.issues[0].symbol).toBe("getUser");
expect(result.issues[0].kind).toBe("function");
});

it("detects async exported function", () => {
const sourceFile = makeDiffFile("src/api.ts", [
"export async function fetchData(url: string) { return fetch(url); }",
]);
const consumerFile = makeDiffFile("src/app.ts", [
'import { fetchData } from "./api.js";',
"await fetchData(endpoint);",
]);
const result = detectSymbolImpact([sourceFile, consumerFile]);
const issue = result.issues.find((i) => i.symbol === "fetchData");
expect(issue).toBeDefined();
});

it("does NOT flag symbol used in same file", () => {
const file = makeDiffFile("src/utils.ts", [
"export function helper() { return 1; }",
"const x = helper();",
]);
const result = detectSymbolImpact([file]);
expect(result.issues).toHaveLength(0);
});

it("detects export default function with caller", () => {
const sourceFile = makeDiffFile("src/main.ts", [
"export default function runTask(input: string) { return process(input); }",
]);
const consumerFile = makeDiffFile("src/worker.ts", [
'import { runTask } from "./main.js";',
"runTask(payload);",
]);
const result = detectSymbolImpact([sourceFile, consumerFile]);
const issue = result.issues.find((i) => i.symbol === "runTask");
expect(issue).toBeDefined();
expect(issue!.kind).toBe("function");
});

it("detects exported function with multiple consumers in different files", () => {
const sourceFile = makeDiffFile("src/lib.ts", [
"export function validate(input: string) { return !!input; }",
]);
const consumer1 = makeDiffFile("src/handler1.ts", [
'import { validate } from "./lib.js";',
"validate(data1);",
]);
const consumer2 = makeDiffFile("src/handler2.ts", [
'import { validate } from "./lib.js";',
"validate(data2);",
]);
const result = detectSymbolImpact([sourceFile, consumer1, consumer2]);
const issue = result.issues.find((i) => i.symbol === "validate");
expect(issue).toBeDefined();
expect(issue!.consumers.length).toBeGreaterThanOrEqual(2);
const consumerFiles = new Set(issue!.consumers.map((c) => c.consumerFile));
expect(consumerFiles.size).toBeGreaterThanOrEqual(2);
});

it("classifies exported constant used in test file + production file differently", () => {
const sourceFile = makeDiffFile("src/constants.ts", [
"export const MAX_RETRIES = 3;",
]);
const prodFile = makeDiffFile("src/client.ts", [
'import { MAX_RETRIES } from "./constants.js";',
"for (let i = 0; i < MAX_RETRIES; i++) { }",
]);
const testFile = makeDiffFile("src/__tests__/constants.test.ts", [
'import { MAX_RETRIES } from "../constants.js";',
"expect(MAX_RETRIES).toBe(3);",
]);
const result = detectSymbolImpact([sourceFile, prodFile, testFile]);
const issue = result.issues.find((i) => i.symbol === "MAX_RETRIES");
expect(issue).toBeDefined();
const kinds = issue!.consumers.map((c) => c.kind);
expect(kinds).toContain("caller");
expect(kinds).toContain("test-file");
});
});

describe("detectSymbolImpact — exported class", () => {
it("detects exported class with consumer", () => {
const sourceFile = makeDiffFile("src/models.ts", [
"export class User { constructor(public name: string) {} }",
]);
const consumerFile = makeDiffFile("src/handler.ts", [
'import { User } from "./models.js";',
"const u = new User('test');",
]);
const result = detectSymbolImpact([sourceFile, consumerFile]);
expect(result.issues.some((i) => i.symbol === "User" && i.kind === "class")).toBe(true);
});
});

describe("detectSymbolImpact — exported interface/type", () => {
it("detects exported interface with import", () => {
const sourceFile = makeDiffFile("src/types.ts", [
"export interface Config { port: number; }",
]);
const consumerFile = makeDiffFile("src/app.ts", [
'import { Config } from "./types.js";',
"const cfg: Config = { port: 3000 };",
]);
const result = detectSymbolImpact([sourceFile, consumerFile]);
expect(result.issues.some((i) => i.symbol === "Config")).toBe(true);
});

it("detects exported type alias", () => {
const sourceFile = makeDiffFile("src/types.ts", [
"export type UserId = string;",
]);
const consumerFile = makeDiffFile("src/api.ts", [
'import type { UserId } from "./types.js";',
"function findUser(id: UserId) { }",
]);
const result = detectSymbolImpact([sourceFile, consumerFile]);
expect(result.issues.some((i) => i.symbol === "UserId")).toBe(true);
});
});

describe("detectSymbolImpact — exported constant", () => {
it("detects exported const with consumer", () => {
const sourceFile = makeDiffFile("src/constants.ts", [
"export const MAX_RETRIES = 3;",
]);
const consumerFile = makeDiffFile("src/client.ts", [
'import { MAX_RETRIES } from "./constants.js";',
"for (let i = 0; i < MAX_RETRIES; i++) { }",
]);
const result = detectSymbolImpact([sourceFile, consumerFile]);
expect(result.issues.some((i) => i.symbol === "MAX_RETRIES" && i.kind === "constant")).toBe(true);
});
});

// ---------------------------------------------------------------------------
// Consumer classification
// ---------------------------------------------------------------------------

describe("detectSymbolImpact — consumer classification", () => {
it("classifies test file consumer", () => {
const sourceFile = makeDiffFile("src/utils.ts", [
"export function parse(input: string) { return JSON.parse(input); }",
]);
const testFile = makeDiffFile("src/__tests__/utils.test.ts", [
'import { parse } from "../utils.js";',
"expect(parse('{}')).toEqual({});",
]);
const result = detectSymbolImpact([sourceFile, testFile]);
const issue = result.issues.find((i) => i.symbol === "parse");
expect(issue).toBeDefined();
expect(issue!.consumers.some((c) => c.kind === "test-file")).toBe(true);
});

it("classifies API handler consumer", () => {
const sourceFile = makeDiffFile("src/service.ts", [
"export function getUser(id: string) { return db.find(id); }",
]);
const handlerFile = makeDiffFile("src/routes.ts", [
'import { getUser } from "./service.js";',
"router.get('/users/:id', (req, res) => { res.json(getUser(req.params.id)); });",
]);
const result = detectSymbolImpact([sourceFile, handlerFile]);
const issue = result.issues.find((i) => i.symbol === "getUser");
expect(issue).toBeDefined();
expect(issue!.consumers.some((c) => c.kind === "api-handler")).toBe(true);
});

it("classifies regular caller", () => {
const sourceFile = makeDiffFile("src/utils.ts", [
"export function formatName(name: string) { return name.trim(); }",
]);
const consumerFile = makeDiffFile("src/display.ts", [
'import { formatName } from "./utils.js";',
"const formatted = formatName(rawName);",
]);
const result = detectSymbolImpact([sourceFile, consumerFile]);
const issue = result.issues.find((i) => i.symbol === "formatName");
expect(issue).toBeDefined();
expect(issue!.consumers.some((c) => c.kind === "caller")).toBe(true);
});

it("classifies Express route handler (app.get)", () => {
const sourceFile = makeDiffFile("src/service.ts", [
"export function listUsers() { return db.query('users'); }",
]);
const handlerFile = makeDiffFile("src/server.ts", [
'import { listUsers } from "./service.js";',
"app.get('/users', (req, res) => res.json(listUsers()));",
]);
const result = detectSymbolImpact([sourceFile, handlerFile]);
const issue = result.issues.find((i) => i.symbol === "listUsers");
expect(issue).toBeDefined();
expect(issue!.consumers.some((c) => c.kind === "api-handler")).toBe(true);
});

it("classifies Express route handler (app.post)", () => {
const sourceFile = makeDiffFile("src/service.ts", [
"export function createUser(data: unknown) { return db.insert(data); }",
]);
const handlerFile = makeDiffFile("src/server.ts", [
'import { createUser } from "./service.js";',
"app.post('/users', (req, res) => res.json(createUser(req.body)));",
]);
const result = detectSymbolImpact([sourceFile, handlerFile]);
const issue = result.issues.find((i) => i.symbol === "createUser");
expect(issue).toBeDefined();
expect(issue!.consumers.some((c) => c.kind === "api-handler")).toBe(true);
});

it("classifies Fastify handler", () => {
const sourceFile = makeDiffFile("src/service.ts", [
"export function getItem(id: string) { return db.find(id); }",
]);
const handlerFile = makeDiffFile("src/fastify-routes.ts", [
'import { getItem } from "./service.js";',
"fastify.get('/items/:id', async (req) => getItem(req.params.id));",
]);
const result = detectSymbolImpact([sourceFile, handlerFile]);
const issue = result.issues.find((i) => i.symbol === "getItem");
expect(issue).toBeDefined();
expect(issue!.consumers.some((c) => c.kind === "api-handler")).toBe(true);
});

it("classifies Hono handler", () => {
const sourceFile = makeDiffFile("src/service.ts", [
"export function serveHome() { return 'hello'; }",
]);
const handlerFile = makeDiffFile("src/hono-routes.ts", [
'import { serveHome } from "./service.js";',
"hono.get('/', (c) => c.text(serveHome()));",
]);
const result = detectSymbolImpact([sourceFile, handlerFile]);
const issue = result.issues.find((i) => i.symbol === "serveHome");
expect(issue).toBeDefined();
expect(issue!.consumers.some((c) => c.kind === "api-handler")).toBe(true);
});

it("classifies Koa handler", () => {
const sourceFile = makeDiffFile("src/service.ts", [
"export function getProfile(id: string) { return db.find(id); }",
]);
const handlerFile = makeDiffFile("src/koa-routes.ts", [
'import { getProfile } from "./service.js";',
"koa.use(router.get('/profile/:id', (ctx) => { ctx.body = getProfile(ctx.params.id); }));",
]);
const result = detectSymbolImpact([sourceFile, handlerFile]);
const issue = result.issues.find((i) => i.symbol === "getProfile");
expect(issue).toBeDefined();
expect(issue!.consumers.some((c) => c.kind === "api-handler")).toBe(true);
});
});

// ---------------------------------------------------------------------------
// Impact scoring
// ---------------------------------------------------------------------------

describe("detectSymbolImpact — scoring", () => {
it("scores API handler consumers higher", () => {
const sourceFile = makeDiffFile("src/core.ts", [
"export function processData(data: unknown) { return validate(data); }",
]);
const handlerConsumer = makeDiffFile("src/routes.ts", [
'import { processData } from "./core.js";',
"app.post('/data', (req, res) => processData(req.body));",
]);
const result = detectSymbolImpact([sourceFile, handlerConsumer]);
const issue = result.issues.find((i) => i.symbol === "processData");
expect(issue).toBeDefined();
expect(issue!.score).toBeGreaterThanOrEqual(4);
});

it("marks score >= 7 as critical", () => {
const sourceFile = makeDiffFile("src/core.ts", [
"export function criticalFn(x: string) { return x; }",
]);
// 2 API handlers x 4 = 8 -> critical
const h1 = makeDiffFile("src/routes1.ts", [
'import { criticalFn } from "./core.js";',
"router.get('/a', () => criticalFn('a'));",
]);
const h2 = makeDiffFile("src/routes2.ts", [
'import { criticalFn } from "./core.js";',
"app.post('/b', () => criticalFn('b'));",
]);
const result = detectSymbolImpact([sourceFile, h1, h2]);
const issue = result.issues.find((i) => i.symbol === "criticalFn");
expect(issue).toBeDefined();
expect(issue!.severity).toBe("critical");
});

it("marks score < 7 as warning", () => {
const sourceFile = makeDiffFile("src/utils.ts", [
"export function minorHelper(x: number) { return x * 2; }",
]);
const consumer = makeDiffFile("src/calc.ts", [
'import { minorHelper } from "./utils.js";',
"const result = minorHelper(5);",
]);
const result = detectSymbolImpact([sourceFile, consumer]);
const issue = result.issues.find((i) => i.symbol === "minorHelper");
expect(issue).toBeDefined();
expect(issue!.severity).toBe("warning");
});

it("computes score: 2 callers (2x2=4) + 1 test (1) = 5 total (warning)", () => {
const sourceFile = makeDiffFile("src/lib.ts", [
"export function computeValue(x: number) { return x * 3; }",
]);
const caller1 = makeDiffFile("src/calc1.ts", [
'import { computeValue } from "./lib.js";',
"computeValue(10);",
]);
const caller2 = makeDiffFile("src/calc2.ts", [
'import { computeValue } from "./lib.js";',
"computeValue(20);",
]);
const testFile = makeDiffFile("src/__tests__/lib.test.ts", [
'import { computeValue } from "../lib.js";',
"expect(computeValue(5)).toBe(15);",
]);
const result = detectSymbolImpact([sourceFile, caller1, caller2, testFile]);
const issue = result.issues.find((i) => i.symbol === "computeValue");
expect(issue).toBeDefined();
// 2 callers x 2 = 4, 1 test x 1 = 1, total = 5
expect(issue!.score).toBe(5);
expect(issue!.severity).toBe("warning");
});

it("score 8 triggers critical: multiple api-handlers (4x2=8)", () => {
const sourceFile = makeDiffFile("src/core.ts", [
"export function handleRequest(req: unknown) { return process(req); }",
]);
const h1 = makeDiffFile("src/api1.ts", [
'import { handleRequest } from "./core.js";',
"app.get('/a', () => handleRequest({}));",
]);
const h2 = makeDiffFile("src/api2.ts", [
'import { handleRequest } from "./core.js";',
"app.post('/b', () => handleRequest({}));",
]);
const result = detectSymbolImpact([sourceFile, h1, h2]);
const issue = result.issues.find((i) => i.symbol === "handleRequest");
expect(issue).toBeDefined();
// 2 api-handlers x 4 = 8 -> critical
expect(issue!.score).toBe(8);
expect(issue!.severity).toBe("critical");
});
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe("detectSymbolImpact — edge cases", () => {
it("handles deleted files", () => {
const file: DiffFile = { path: "src/utils.ts", status: "deleted", hunks: [] };
const result = detectSymbolImpact([file]);
expect(result.issues).toHaveLength(0);
});

it("handles empty hunks", () => {
const file: DiffFile = {
path: "src/utils.ts",
status: "modified",
hunks: [{ header: "@@ -0 +0 @@", changes: [] }],
};
const result = detectSymbolImpact([file]);
expect(result.issues).toHaveLength(0);
});

it("returns empty for PR with no exports", () => {
const file = makeDiffFile("src/app.ts", [
"const x = 1 + 2;",
"console.log(x);",
]);
const result = detectSymbolImpact([file]);
expect(result.issues).toHaveLength(0);
expect(result.contextText).toBe("");
expect(result.bodySummary).toBe("");
});

it("ignores non-relative imports", () => {
const sourceFile = makeDiffFile("src/lib.ts", [
"export function processItem(item: unknown) { return item; }",
]);
const consumerFile = makeDiffFile("src/app.ts", [
'import { processItem } from "external-package";',
"processItem(data);",
]);
const result = detectSymbolImpact([sourceFile, consumerFile]);
// Should NOT flag because the import is from external, not relative
const issue = result.issues.find(
(i) => i.symbol === "processItem" && i.consumers.some((c) => c.consumerFile === "src/app.ts")
);
// The consumer's import is from external, so it shouldn't match our source
expect(issue?.consumers.some((c) => c.consumerFile === "src/app.ts" && c.sourceFile === "src/lib.ts")).toBeFalsy();
});

it("handles multiple symbols in one file", () => {
const sourceFile = makeDiffFile("src/utils.ts", [
"export function fn1() { return 1; }",
"export function fn2() { return 2; }",
]);
const consumerFile = makeDiffFile("src/app.ts", [
'import { fn1, fn2 } from "./utils.js";',
"const a = fn1();",
"const b = fn2();",
]);
const result = detectSymbolImpact([sourceFile, consumerFile]);
expect(result.issues.some((i) => i.symbol === "fn1")).toBe(true);
expect(result.issues.some((i) => i.symbol === "fn2")).toBe(true);
});

it("deduplicates symbols from same file:line", () => {
const sourceFile = makeDiffFile("src/utils.ts", [
"export function unique() { return 1; }",
]);
const consumerFile = makeDiffFile("src/app.ts", [
'import { unique } from "./utils.js";',
"unique();",
]);
const result = detectSymbolImpact([sourceFile, consumerFile]);
const uniqueIssues = result.issues.filter((i) => i.symbol === "unique");
expect(uniqueIssues.length).toBeLessThanOrEqual(1);
});

it("handles file with only import lines (no usage)", () => {
const sourceFile = makeDiffFile("src/lib.ts", [
"export function computeVal(x: number) { return x; }",
]);
const consumerFile = makeDiffFile("src/app.ts", [
'import { computeVal } from "./lib.js";',
]);
const result = detectSymbolImpact([sourceFile, consumerFile]);
// Import line only (skipped by the "import " check), no usage -> no consumer
const issue = result.issues.find((i) => i.symbol === "computeVal");
expect(issue).toBeUndefined();
});

it("does NOT flag file that uses symbol without importing it via relative path", () => {
const sourceFile = makeDiffFile("src/lib.ts", [
"export function computeThing(x: number) { return x * 2; }",
]);
const consumerFile = makeDiffFile("src/app.ts", [
"computeThing(42);",
]);
const result = detectSymbolImpact([sourceFile, consumerFile]);
// No relative import line means fileImports doesn't contain computeThing
const issue = result.issues.find((i) => i.symbol === "computeThing");
expect(issue).toBeUndefined();
});

it("handles deleted source file with no exports", () => {
const deletedFile: DiffFile = { path: "src/old-utils.ts", status: "deleted", hunks: [] };
const consumerFile = makeDiffFile("src/app.ts", [
'import { oldFn } from "./old-utils.js";',
"oldFn();",
]);
const result = detectSymbolImpact([deletedFile, consumerFile]);
expect(result.issues).toHaveLength(0);
});
});

// ---------------------------------------------------------------------------
// Context / body generation
// ---------------------------------------------------------------------------

describe("detectSymbolImpact — context and body", () => {
it("produces context text with symbol info", () => {
const sourceFile = makeDiffFile("src/core.ts", [
"export function important() { return true; }",
]);
const consumerFile = makeDiffFile("src/app.ts", [
'import { important } from "./core.js";',
"important();",
]);
const result = detectSymbolImpact([sourceFile, consumerFile]);
if (result.issues.length > 0) {
expect(result.contextText).toContain("Symbol-Level Impact");
expect(result.contextText).toContain("important");
}
});

it("produces body summary with table", () => {
const sourceFile = makeDiffFile("src/core.ts", [
"export function vital() { return 42; }",
]);
const consumerFile = makeDiffFile("src/app.ts", [
'import { vital } from "./core.js";',
"vital();",
]);
const result = detectSymbolImpact([sourceFile, consumerFile]);
if (result.issues.length > 0) {
expect(result.bodySummary).toContain("| Symbol |");
expect(result.bodySummary).toContain("vital");
}
});

it("returns empty context and body for clean PR", () => {
const file = makeDiffFile("src/app.ts", ["const x = 1;"]);
const result = detectSymbolImpact([file]);
expect(result.contextText).toBe("");
expect(result.bodySummary).toBe("");
});
});

// ---------------------------------------------------------------------------
// Namespace imports
// ---------------------------------------------------------------------------

describe("detectSymbolImpact — namespace imports", () => {
it("detects usage via namespace import * as", () => {
const sourceFile = makeDiffFile("src/utils.ts", [
"export function checkData(data: unknown) { return !!data; }",
]);
const consumerFile = makeDiffFile("src/app.ts", [
'import * as Utils from "./utils.js";',
"Utils.checkData(input);",
]);
const result = detectSymbolImpact([sourceFile, consumerFile]);
const issue = result.issues.find((i) => i.symbol === "checkData");
expect(issue).toBeDefined();
});
});
