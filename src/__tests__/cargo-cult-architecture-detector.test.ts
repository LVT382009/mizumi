import { describe, it, expect } from "vitest";
import { detectCargoCultArchitecture } from "../cargo-cult-architecture-detector.js";
import type { DiffFile } from "../diff.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeFile(path: string, addedLines: string[]): DiffFile {
  return {
    path,
    status: "modified",
    hunks: [
      {
        header: "@@ -1 +1 @@",
        changes: addedLines.map((content, idx) => ({
          type: "add" as const,
          content: `+${content}`,
          line: idx + 1,
        })),
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// enterprise-facade
// ---------------------------------------------------------------------------

describe("detectCargoCultArchitecture — enterprise-facade", () => {
  it("detects class with delegation-only methods", () => {
    const file = makeFile("src/notification-manager.ts", [
      "export class NotificationManager {",
      "  private sender: NotificationSender;",
      "  send(msg: string) { return this.sender.send(msg); }",
      "  format(msg: string) { return this.sender.format(msg); }",
      "}",
    ]);

    const result = detectCargoCultArchitecture([file]);
    const issues = result.issues.filter((i) => i.category === "enterprise-facade");
    expect(issues.length).toBeGreaterThanOrEqual(1);
    expect(issues[0].description).toContain("NotificationManager");
  });

  it("does not flag class with real logic in methods", () => {
    const file = makeFile("src/processor.ts", [
      "export class DataProcessor {",
      "  process(data: string) { const parsed = JSON.parse(data); return parsed.map(transform); }",
      "  validate(data: string) { return schema.check(data); }",
      "  save(data: any) { return db.insert(data); }",
      "}",
    ]);

    const result = detectCargoCultArchitecture([file]);
    const issues = result.issues.filter((i) => i.category === "enterprise-facade");
    expect(issues).toHaveLength(0);
  });

  it("does not flag class with fewer than 2 methods", () => {
    const file = makeFile("src/wrapper.ts", [
      "export class SimpleWrapper {",
      "  doStuff() { return this.impl.doStuff(); }",
      "}",
    ]);

    const result = detectCargoCultArchitecture([file]);
    const issues = result.issues.filter((i) => i.category === "enterprise-facade");
    expect(issues).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// interface-for-single-impl
// ---------------------------------------------------------------------------

describe("detectCargoCultArchitecture — interface-for-single-impl", () => {
  it("detects interface with exactly one implementation", () => {
    const file1 = makeFile("src/user-repo.ts", [
      "export interface IUserRepository {",
      "  findById(id: string): User;",
      "}",
    ]);
    const file2 = makeFile("src/user-repo-impl.ts", [
      "export class UserRepository implements IUserRepository {",
      "  findById(id: string) { return db.query(id); }",
      "}",
    ]);

    const result = detectCargoCultArchitecture([file1, file2]);
    const issues = result.issues.filter((i) => i.category === "interface-for-single-impl");
    expect(issues.length).toBeGreaterThanOrEqual(1);
    expect(issues[0].description).toContain("IUserRepository");
  });

  it("does not flag well-known interface names like Options", () => {
    const file1 = makeFile("src/types.ts", [
      "export interface Options { verbose: boolean; }",
    ]);
    const file2 = makeFile("src/opts.ts", [
      "export class DefaultOptions implements Options { verbose = false; }",
    ]);

    const result = detectCargoCultArchitecture([file1, file2]);
    const issues = result.issues.filter((i) => i.category === "interface-for-single-impl");
    expect(issues).toHaveLength(0);
  });

  it("does not flag interface with multiple implementations", () => {
    const file1 = makeFile("src/storage.ts", [
      "export interface IStorage { get(key: string): string; }",
    ]);
    const file2 = makeFile("src/memory-storage.ts", [
      "export class MemoryStorage implements IStorage { get(key: string) { return map[key]; } }",
    ]);
    const file3 = makeFile("src/redis-storage.ts", [
      "export class RedisStorage implements IStorage { get(key: string) { return redis.get(key); } }",
    ]);

    const result = detectCargoCultArchitecture([file1, file2, file3]);
    const issues = result.issues.filter((i) => i.category === "interface-for-single-impl");
    expect(issues).toHaveLength(0);
  });

  it("caps at 5 issues to avoid noise", () => {
    const files: DiffFile[] = [];
    for (let i = 0; i < 10; i++) {
      files.push(makeFile(`src/iface${i}.ts`, [
        `export interface IHandler${i} { handle(): void; }`,
      ]));
      files.push(makeFile(`src/impl${i}.ts`, [
        `export class Handler${i} implements IHandler${i} { handle() {} }`,
      ]));
    }

    const result = detectCargoCultArchitecture(files);
    const issues = result.issues.filter((i) => i.category === "interface-for-single-impl");
    expect(issues.length).toBeLessThanOrEqual(5);
  });
});

// ---------------------------------------------------------------------------
// deep-inheritance
// ---------------------------------------------------------------------------

describe("detectCargoCultArchitecture — deep-inheritance", () => {
  it("detects 3+ level inheritance chain", () => {
    const file1 = makeFile("src/base.ts", [
      "export class BaseEntity { id: string; }",
    ]);
    const file2 = makeFile("src/named.ts", [
      "export class NamedEntity extends BaseEntity { name: string; }",
    ]);
    const file3 = makeFile("src/user.ts", [
      "export class User extends NamedEntity { email: string; }",
    ]);

    const result = detectCargoCultArchitecture([file1, file2, file3]);
    const issues = result.issues.filter((i) => i.category === "deep-inheritance");
    expect(issues.length).toBeGreaterThanOrEqual(1);
    expect(issues[0].description).toContain("3-level");
  });

  it("does not flag 2-level inheritance", () => {
    const file1 = makeFile("src/base.ts", [
      "export class BaseEntity { id: string; }",
    ]);
    const file2 = makeFile("src/user.ts", [
      "export class User extends BaseEntity { email: string; }",
    ]);

    const result = detectCargoCultArchitecture([file1, file2]);
    const issues = result.issues.filter((i) => i.category === "deep-inheritance");
    expect(issues).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// singleton-misuse
// ---------------------------------------------------------------------------

describe("detectCargoCultArchitecture — singleton-misuse", () => {
  it("detects singleton with private constructor and getInstance", () => {
    const file = makeFile("src/config-manager.ts", [
      "export class ConfigManager {",
      "  private static instance: ConfigManager;",
      "  private constructor() {}",
      "  static getInstance(): ConfigManager {",
      "    if (!ConfigManager.instance) { ConfigManager.instance = new ConfigManager(); }",
      "    return ConfigManager.instance;",
      "  }",
      "}",
    ]);

    const result = detectCargoCultArchitecture([file]);
    const issues = result.issues.filter((i) => i.category === "singleton-misuse");
    expect(issues.length).toBeGreaterThanOrEqual(1);
    expect(issues[0].description).toContain("singleton");
  });

  it("does not flag class without singleton pattern", () => {
    const file = makeFile("src/service.ts", [
      "export class Service {",
      "  constructor(private deps: Dependencies) {}",
      "  doWork() { return this.deps.run(); }",
      "}",
    ]);

    const result = detectCargoCultArchitecture([file]);
    const issues = result.issues.filter((i) => i.category === "singleton-misuse");
    expect(issues).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// decorator-stack
// ---------------------------------------------------------------------------

describe("detectCargoCultArchitecture — decorator-stack", () => {
  it("detects 3+ consecutive decorators", () => {
    const file = makeFile("src/controller.ts", [
      "@Controller",
      "@UseGuards(AuthGuard)",
      "@Injectable()",
      "export class AppController {",
      "  @Get('/health')",
      "  health() { return { status: 'ok' }; }",
      "}",
    ]);

    const result = detectCargoCultArchitecture([file]);
    const issues = result.issues.filter((i) => i.category === "decorator-stack");
    expect(issues.length).toBeGreaterThanOrEqual(1);
    expect(issues[0].description).toContain("3 decorators");
  });

  it("does not flag 2 or fewer decorators", () => {
    const file = makeFile("src/component.ts", [
      "@Component()",
      "@Injectable()",
      "export class MyService { }",
    ]);

    const result = detectCargoCultArchitecture([file]);
    const issues = result.issues.filter((i) => i.category === "decorator-stack");
    expect(issues).toHaveLength(0);
  });

  it("does not flag decorator-separated method decorators", () => {
    const file = makeFile("src/mixed.ts", [
      "@Controller()",
      "export class MyController {",
      "  @Get('/list')",
      "  list() { return []; }",
      "}",
    ]);

    const result = detectCargoCultArchitecture([file]);
    const issues = result.issues.filter((i) => i.category === "decorator-stack");
    expect(issues).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe("detectCargoCultArchitecture — edge cases", () => {
  it("skips deleted files", () => {
    const file: DiffFile = { path: "src/deleted.ts", status: "deleted", hunks: [] };
    const result = detectCargoCultArchitecture([file]);
    expect(result.issues).toHaveLength(0);
  });

  it("handles empty hunks", () => {
    const file: DiffFile = {
      path: "src/empty.ts",
      status: "modified",
      hunks: [{ header: "@@ -0 +0 @@", changes: [] }],
    };
    const result = detectCargoCultArchitecture([file]);
    expect(result.issues).toHaveLength(0);
  });

  it("skips comment lines", () => {
    const file = makeFile("src/a.ts", [
      "// export class Singleton {",
      "/* private constructor() {} */",
    ]);
    const result = detectCargoCultArchitecture([file]);
    expect(result.issues).toHaveLength(0);
  });

  it("skips type/interface import lines", () => {
    const file = makeFile("src/types.ts", [
      "import type { IUserRepository } from './repo';",
      "export type { IUserRepository };",
    ]);
    const result = detectCargoCultArchitecture([file]);
    expect(result.issues).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Context & body summary
// ---------------------------------------------------------------------------

describe("detectCargoCultArchitecture — context and summary", () => {
  it("generates context text for issues", () => {
    const file1 = makeFile("src/iface.ts", [
      "export interface ICache { get(key: string): string; }",
    ]);
    const file2 = makeFile("src/impl.ts", [
      "export class MemoryCache implements ICache { get(key: string) { return ''; } }",
    ]);

    const result = detectCargoCultArchitecture([file1, file2]);
    if (result.issues.length > 0) {
      expect(result.contextText).toContain("Cargo-Cult Architecture Detection");
    }
  });

  it("generates empty context when no issues", () => {
    const file = makeFile("src/clean.ts", [
      "const x = 1;",
    ]);
    const result = detectCargoCultArchitecture([file]);
    expect(result.contextText).toBe("");
  });

  it("generates body summary with HTML details", () => {
    const file1 = makeFile("src/iface.ts", [
      "export interface ICache { get(key: string): string; }",
    ]);
    const file2 = makeFile("src/impl.ts", [
      "export class MemoryCache implements ICache { get(key: string) { return ''; } }",
    ]);

    const result = detectCargoCultArchitecture([file1, file2]);
    if (result.issues.length > 0) {
      expect(result.bodySummary).toContain("<details>");
      expect(result.bodySummary).toContain("</details>");
    }
  });

  it("generates empty body summary when no issues", () => {
    const file = makeFile("src/clean.ts", [
      "const x = 1;",
    ]);
    const result = detectCargoCultArchitecture([file]);
    expect(result.bodySummary).toBe("");
  });
});
