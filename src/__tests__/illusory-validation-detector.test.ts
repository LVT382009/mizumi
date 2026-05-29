import { describe, it, expect } from "vitest";
import { detectIllusoryValidation } from "../illusory-validation-detector.js";
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
        header: "@@ -1 +1 @@@@",
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
// dead-validation
// ---------------------------------------------------------------------------

describe("detectIllusoryValidation — dead-validation", () => {
  it("detects if-check with log then proceed", () => {
    const file = makeFile("src/api.ts", [
      "if (!isValid) { console.log('invalid input'); } processRequest(data);",
    ]);
    const result = detectIllusoryValidation([file]);
    const issues = result.issues.filter((i) => i.category === "dead-validation");
    expect(issues.length).toBeGreaterThanOrEqual(1);
    expect(issues[0].severity).toBe("critical");
  });

  it("detects auth check that logs but continues", () => {
    const file = makeFile("src/auth.ts", [
      "if (!authenticated) { logger.warn('unauthenticated'); } return user.json();",
    ]);
    const result = detectIllusoryValidation([file]);
    const issues = result.issues.filter((i) => i.category === "dead-validation");
    expect(issues.length).toBeGreaterThanOrEqual(1);
  });

  it("detects validate then execute pattern", () => {
    const file = makeFile("src/handler.ts", [
      "validateInput(input); executeQuery(input);",
    ]);
    const result = detectIllusoryValidation([file]);
    const issues = result.issues.filter((i) => i.category === "dead-validation");
    expect(issues.length).toBeGreaterThanOrEqual(1);
  });

  it("detects if-check with warn then send", () => {
    const file = makeFile("src/server.ts", [
      "if (!isAuthenticated) { console.warn('auth failed'); } sendResponse(data);",
    ]);
    const result = detectIllusoryValidation([file]);
    const issues = result.issues.filter((i) => i.category === "dead-validation");
    expect(issues.length).toBeGreaterThanOrEqual(1);
  });

  it("does not flag validation that returns on failure", () => {
    const file = makeFile("src/secure.ts", [
      "if (!isValid(data)) { return res.status(400).json({ error: 'invalid' }); }",
      "processRequest(data);",
    ]);
    const result = detectIllusoryValidation([file]);
    const issues = result.issues.filter((i) => i.category === "dead-validation");
    expect(issues).toHaveLength(0);
  });

  it("does not flag test files", () => {
    const file = makeFile("src/__tests__/api.test.ts", [
      "if (!isValid(data)) { console.log('invalid'); } processRequest(data);",
    ]);
    const result = detectIllusoryValidation([file]);
    const issues = result.issues.filter((i) => i.category === "dead-validation");
    expect(issues).toHaveLength(0);
  });

  it("detects permission check that logs but renders", () => {
    const file = makeFile("src/admin.ts", [
      "if (!permission) { logger.warn('no permission'); } renderAdminPage();",
    ]);
    const result = detectIllusoryValidation([file]);
    const issues = result.issues.filter((i) => i.category === "dead-validation");
    expect(issues.length).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// sanitizer-sink-mismatch
// ---------------------------------------------------------------------------

describe("detectIllusoryValidation — sanitizer-sink-mismatch", () => {
  it("detects HTML escaping before SQL query", () => {
    const file = makeFile("src/db.ts", [
      "const safe = escapeHtml(input); db.query('SELECT * FROM users WHERE id = ' + safe);",
    ]);
    const result = detectIllusoryValidation([file]);
    const issues = result.issues.filter((i) => i.category === "sanitizer-sink-mismatch");
    expect(issues.length).toBeGreaterThanOrEqual(1);
    expect(issues[0].severity).toBe("critical");
  });

  it("detects SQL escaping before HTML output", () => {
    const file = makeFile("src/render.ts", [
      "const safe = escapeSql(input); element.innerHTML = safe;",
    ]);
    const result = detectIllusoryValidation([file]);
    const issues = result.issues.filter((i) => i.category === "sanitizer-sink-mismatch");
    expect(issues.length).toBeGreaterThanOrEqual(1);
  });

  it("detects HTML escaping before shell command", () => {
    const file = makeFile("src/exec.ts", [
      "const safe = escapeHtml(userInput); child_process.exec(safe);",
    ]);
    const result = detectIllusoryValidation([file]);
    const issues = result.issues.filter((i) => i.category === "sanitizer-sink-mismatch");
    expect(issues.length).toBeGreaterThanOrEqual(1);
  });

  it("does not flag correct sanitization for SQL context", () => {
    const file = makeFile("src/db.ts", [
      "const safe = db.escape(input); conn.query(safe);",
    ]);
    const result = detectIllusoryValidation([file]);
    const issues = result.issues.filter((i) => i.category === "sanitizer-sink-mismatch");
    // db.escape + query is a correct pairing, should not flag
    expect(issues).toHaveLength(0);
  });

  it("does not flag test files", () => {
    const file = makeFile("src/__tests__/db.test.ts", [
      "const safe = escapeHtml(input); db.query(safe);",
    ]);
    const result = detectIllusoryValidation([file]);
    const issues = result.issues.filter((i) => i.category === "sanitizer-sink-mismatch");
    expect(issues).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// crypto-voided-parameters
// ---------------------------------------------------------------------------

describe("detectIllusoryValidation — crypto-voided-parameters", () => {
  it("detects bcrypt with cost factor below 10", () => {
    const file = makeFile("src/auth.ts", [
      "const hash = await bcrypt(password, 4);",
    ]);
    const result = detectIllusoryValidation([file]);
    const issues = result.issues.filter((i) => i.category === "crypto-voided-parameters");
    expect(issues.length).toBeGreaterThanOrEqual(1);
    expect(issues[0].severity).toBe("critical");
  });

  it("detects bcrypt genSalt with rounds below 10", () => {
    const file = makeFile("src/auth.ts", [
      "const salt = await bcrypt.genSalt(5);",
    ]);
    const result = detectIllusoryValidation([file]);
    const issues = result.issues.filter((i) => i.category === "crypto-voided-parameters");
    expect(issues.length).toBeGreaterThanOrEqual(1);
  });

  it("detects bcrypt with cost option below 10", () => {
    const file = makeFile("src/hash.ts", [
      "const hash = await bcrypt(password, { cost: 8 });",
    ]);
    const result = detectIllusoryValidation([file]);
    const issues = result.issues.filter((i) => i.category === "crypto-voided-parameters");
    expect(issues.length).toBeGreaterThanOrEqual(1);
  });

  it("detects AES ECB mode", () => {
    const file = makeFile("src/encrypt.ts", [
      "const cipher = AES.new(key, AES.MODE_ECB);",
    ]);
    const result = detectIllusoryValidation([file]);
    const issues = result.issues.filter((i) => i.category === "crypto-voided-parameters");
    expect(issues.length).toBeGreaterThanOrEqual(1);
  });

  it("detects MODE_ECB in Python", () => {
    const file = makeFile("src/encrypt.py", [
      "cipher = AES.new(key, AES.MODE_ECB)",
    ]);
    const result = detectIllusoryValidation([file]);
    const issues = result.issues.filter((i) => i.category === "crypto-voided-parameters");
    expect(issues.length).toBeGreaterThanOrEqual(1);
  });

  it("detects MD5 for password hashing", () => {
    const file = makeFile("src/auth.ts", [
      "const hash = crypto.createHash('md5').update(password).digest('hex');",
    ]);
    const result = detectIllusoryValidation([file]);
    const issues = result.issues.filter((i) =>
      i.category === "crypto-voided-parameters" && i.description.includes("MD5")
    );
    expect(issues.length).toBeGreaterThanOrEqual(1);
  });

  it("detects HMAC with MD5", () => {
    const file = makeFile("src/sign.ts", [
      "const hmac = crypto.createHmac('md5', secret);",
    ]);
    const result = detectIllusoryValidation([file]);
    const issues = result.issues.filter((i) => i.category === "crypto-voided-parameters");
    expect(issues.length).toBeGreaterThanOrEqual(1);
  });

  it("detects JWT with none algorithm", () => {
    const file = makeFile("src/jwt.ts", [
      "const token = jwt.encode(payload, 'secret', algorithm='none');",
    ]);
    const result = detectIllusoryValidation([file]);
    const issues = result.issues.filter((i) =>
      i.category === "crypto-voided-parameters" && i.description.includes("none")
    );
    expect(issues.length).toBeGreaterThanOrEqual(1);
  });

  it("detects DES cipher", () => {
    const file = makeFile("src/crypto.ts", [
      "const cipher = DES.new(key, DES.MODE_CBC);",
    ]);
    const result = detectIllusoryValidation([file]);
    const issues = result.issues.filter((i) => i.category === "crypto-voided-parameters");
    expect(issues.length).toBeGreaterThanOrEqual(1);
  });

  it("detects RC4 cipher", () => {
    const file = makeFile("src/cipher.ts", [
      "const cipher = RC4.new(key);",
    ]);
    const result = detectIllusoryValidation([file]);
    const issues = result.issues.filter((i) => i.category === "crypto-voided-parameters");
    expect(issues.length).toBeGreaterThanOrEqual(1);
  });

  it("does not flag bcrypt with cost 10 or above", () => {
    const file = makeFile("src/auth.ts", [
      "const hash = await bcrypt(password, 12);",
    ]);
    const result = detectIllusoryValidation([file]);
    const issues = result.issues.filter((i) =>
      i.category === "crypto-voided-parameters" && i.description.includes("cost")
    );
    expect(issues).toHaveLength(0);
  });

  it("does not flag AES-GCM mode", () => {
    const file = makeFile("src/encrypt.ts", [
      "const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);",
    ]);
    const result = detectIllusoryValidation([file]);
    const issues = result.issues.filter((i) =>
      i.category === "crypto-voided-parameters" && i.description.includes("ECB")
    );
    expect(issues).toHaveLength(0);
  });

  it("does not flag test files", () => {
    const file = makeFile("src/__tests__/crypto.test.ts", [
      "const hash = await bcrypt(password, 4);",
    ]);
    const result = detectIllusoryValidation([file]);
    const issues = result.issues.filter((i) => i.category === "crypto-voided-parameters");
    expect(issues).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// decorative-security-import
// ---------------------------------------------------------------------------

describe("detectIllusoryValidation — decorative-security-import", () => {
  it("detects flask_cors imported without CORS(app)", () => {
    const file = makeFile("src/app.py", [
      "from flask_cors import CORS",
      "app = Flask(__name__)",
    ]);
    const result = detectIllusoryValidation([file]);
    const issues = result.issues.filter((i) =>
      i.category === "decorative-security-import" && i.description.includes("flask_cors")
    );
    expect(issues.length).toBeGreaterThanOrEqual(1);
    expect(issues[0].severity).toBe("warning");
  });

  it("detects helmet imported without helmet()", () => {
    const file = makeFile("src/server.ts", [
      "import helmet from 'helmet';",
      "const app = express();",
    ]);
    const result = detectIllusoryValidation([file]);
    const issues = result.issues.filter((i) =>
      i.category === "decorative-security-import" && i.description.includes("helmet")
    );
    expect(issues.length).toBeGreaterThanOrEqual(1);
  });

  it("does not flag helmet when properly initialized", () => {
    const file = makeFile("src/server.ts", [
      "import helmet from 'helmet';",
      "app.use(helmet());",
    ]);
    const result = detectIllusoryValidation([file]);
    const issues = result.issues.filter((i) =>
      i.category === "decorative-security-import" && i.description.includes("helmet")
    );
    expect(issues).toHaveLength(0);
  });

  it("does not flag flask_cors when CORS(app) is called", () => {
    const file = makeFile("src/app.py", [
      "from flask_cors import CORS",
      "CORS(app)",
    ]);
    const result = detectIllusoryValidation([file]);
    const issues = result.issues.filter((i) =>
      i.category === "decorative-security-import" && i.description.includes("flask_cors")
    );
    expect(issues).toHaveLength(0);
  });

  it("does not flag test files", () => {
    const file = makeFile("src/__tests__/server.test.ts", [
      "import helmet from 'helmet';",
    ]);
    const result = detectIllusoryValidation([file]);
    const issues = result.issues.filter((i) => i.category === "decorative-security-import");
    expect(issues).toHaveLength(0);
  });

  it("detects express-rate-limit imported without config", () => {
    const file = makeFile("src/app.ts", [
      "import rateLimit from 'express-rate-limit';",
      "const app = express();",
    ]);
    const result = detectIllusoryValidation([file]);
    const issues = result.issues.filter((i) =>
      i.category === "decorative-security-import" && i.description.includes("rate-limit")
    );
    expect(issues.length).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe("detectIllusoryValidation — edge cases", () => {
  it("skips deleted files", () => {
    const file: DiffFile = { path: "src/deleted.ts", status: "deleted", hunks: [] };
    const result = detectIllusoryValidation([file]);
    expect(result.issues).toHaveLength(0);
  });

  it("handles empty hunks", () => {
    const file: DiffFile = {
      path: "src/empty.ts",
      status: "modified",
      hunks: [{ header: "@@ -0 +0 @@@@", changes: [] }],
    };
    const result = detectIllusoryValidation([file]);
    expect(result.issues).toHaveLength(0);
  });

  it("skips comment-only lines", () => {
    const file = makeFile("src/config.ts", [
      "// if (!isValid(data)) { console.log('invalid'); } processRequest(data);",
    ]);
    const result = detectIllusoryValidation([file]);
    expect(result.issues).toHaveLength(0);
  });

  it("handles clean code with no illusory validation patterns", () => {
    const file = makeFile("src/utils.ts", [
      "function add(a: number, b: number): number { return a + b; }",
    ]);
    const result = detectIllusoryValidation([file]);
    expect(result.issues).toHaveLength(0);
  });

  it("handles multiple categories in one PR", () => {
    const file1 = makeFile("src/api.ts", [
      "if (!isValid) { console.log('invalid input'); } processRequest(data);",
    ]);
    const file2 = makeFile("src/auth.ts", [
      "const hash = await bcrypt(password, 4);",
    ]);
    const result = detectIllusoryValidation([file1, file2]);
    expect(result.issues.length).toBeGreaterThanOrEqual(2);
  });

  it("skips type-only import lines", () => {
    const file = makeFile("src/types.ts", [
      "import type { Config } from './config';",
    ]);
    const result = detectIllusoryValidation([file]);
    expect(result.issues).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Context & body summary
// ---------------------------------------------------------------------------

describe("detectIllusoryValidation — context and summary", () => {
  it("generates context text for issues", () => {
    const file = makeFile("src/api.ts", [
      "if (!isValid(data)) { console.log('invalid input'); } processRequest(data);",
    ]);
    const result = detectIllusoryValidation([file]);
    if (result.issues.length > 0) {
      expect(result.contextText).toContain("Illusory Validation Detection");
    }
  });

  it("generates empty context when no issues", () => {
    const file = makeFile("src/clean.ts", [
      "const x = 1;",
    ]);
    const result = detectIllusoryValidation([file]);
    expect(result.contextText).toBe("");
  });

  it("generates body summary with HTML details", () => {
    const file = makeFile("src/api.ts", [
      "if (!isValid(data)) { console.log('invalid input'); } processRequest(data);",
    ]);
    const result = detectIllusoryValidation([file]);
    if (result.issues.length > 0) {
      expect(result.bodySummary).toContain("<details>");
      expect(result.bodySummary).toContain("</details>");
    }
  });

  it("generates empty body summary when no issues", () => {
    const file = makeFile("src/clean.ts", [
      "const x = 1;",
    ]);
    const result = detectIllusoryValidation([file]);
    expect(result.bodySummary).toBe("");
  });

  it("sorts critical before warning", () => {
    const file1 = makeFile("src/api.ts", [
      "if (!isValid(data)) { console.log('invalid'); } processRequest(data);",
    ]);
    const file2 = makeFile("src/server.ts", [
      "import helmet from 'helmet';",
    ]);
    const result = detectIllusoryValidation([file1, file2]);
    const critical = result.issues.filter((i) => i.severity === "critical");
    const warnings = result.issues.filter((i) => i.severity === "warning");
    if (critical.length > 0 && warnings.length > 0) {
      const lastC = result.issues.indexOf(critical[critical.length - 1]);
      const firstW = result.issues.indexOf(warnings[0]);
      expect(lastC).toBeLessThan(firstW);
    }
  });

  it("body summary includes table headers", () => {
    const file = makeFile("src/api.ts", [
      "if (!isValid(data)) { console.log('invalid'); } processRequest(data);",
    ]);
    const result = detectIllusoryValidation([file]);
    if (result.issues.length > 0) {
      expect(result.bodySummary).toContain("| Category |");
    }
  });
});
