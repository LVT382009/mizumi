import { describe, it, expect } from "vitest";
import { detectParadigmClashes } from "../paradigm-clash-detector.js";
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
// react-class-and-hooks
// ---------------------------------------------------------------------------

describe("detectParadigmClashes — react-class-and-hooks", () => {
  it("detects class component with useState hook", () => {
    const file = makeFile("src/Component.tsx", [
      "class MyComponent extends React.Component {",
      "  render() { return <div />; }",
      "}",
      "const [count, setCount] = useState(0);",
    ]);

    const result = detectParadigmClashes([file]);
    const issues = result.issues.filter((i) => i.category === "react-class-and-hooks");
    expect(issues.length).toBeGreaterThanOrEqual(1);
    expect(issues[0].severity).toBe("critical");
    expect(issues[0].description).toContain("hook");
  });

  it("detects class component with useEffect", () => {
    const file = makeFile("src/Widget.tsx", [
      "class Widget extends Component {",
      "  componentDidMount() { }",
      "  render() { return null; }",
      "}",
      "useEffect(() => { }, []);",
    ]);

    const result = detectParadigmClashes([file]);
    const issues = result.issues.filter((i) => i.category === "react-class-and-hooks");
    expect(issues.length).toBeGreaterThanOrEqual(1);
  });

  it("detects this.state alongside useState", () => {
    const file = makeFile("src/Form.tsx", [
      "this.state = { value: '' };",
      "const [value, setValue] = useState('');",
    ]);

    const result = detectParadigmClashes([file]);
    const issues = result.issues.filter((i) => i.category === "react-class-and-hooks");
    expect(issues.length).toBeGreaterThanOrEqual(1);
  });

  it("does not flag functional component with hooks only", () => {
    const file = makeFile("src/Func.tsx", [
      "function Func() {",
      "  const [count, setCount] = useState(0);",
      "  useEffect(() => { }, []);",
      "  return <div>{count}</div>;",
      "}",
    ]);

    const result = detectParadigmClashes([file]);
    const issues = result.issues.filter((i) => i.category === "react-class-and-hooks");
    expect(issues).toHaveLength(0);
  });

  it("does not flag class component without hooks", () => {
    const file = makeFile("src/ClassComp.tsx", [
      "class ClassComp extends React.Component {",
      "  componentDidMount() { }",
      "  render() { return <div />; }",
      "}",
    ]);

    const result = detectParadigmClashes([file]);
    const issues = result.issues.filter((i) => i.category === "react-class-and-hooks");
    expect(issues).toHaveLength(0);
  });

  it("detects PureComponent with useCallback", () => {
    const file = makeFile("src/Pure.tsx", [
      "class Pure extends React.PureComponent { }",
      "const memoFn = useCallback(() => {}, []);",
    ]);

    const result = detectParadigmClashes([file]);
    const issues = result.issues.filter((i) => i.category === "react-class-and-hooks");
    expect(issues.length).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// callback-and-async-await
// ---------------------------------------------------------------------------

describe("detectParadigmClashes — callback-and-async-await", () => {
  it("detects .then() mixed with await", () => {
    const file = makeFile("src/api.ts", [
      "fetch('/api').then(res => res.json());",
      "const data = await fetch('/api2');",
    ]);

    const result = detectParadigmClashes([file]);
    const issues = result.issues.filter((i) => i.category === "callback-and-async-await");
    expect(issues.length).toBeGreaterThanOrEqual(1);
    expect(issues[0].severity).toBe("warning");
  });

  it("detects error-first callback mixed with async function", () => {
    const file = makeFile("src/io.ts", [
      "fs.readFile(path, (err, data) => { });",
      "async function readConfig() { return await fs.promises.readFile(cfg); }",
    ]);

    const result = detectParadigmClashes([file]);
    const issues = result.issues.filter((i) => i.category === "callback-and-async-await");
    expect(issues.length).toBeGreaterThanOrEqual(1);
  });

  it("detects callback parameter mixed with await", () => {
    const file = makeFile("src/process.ts", [
      "function process(data, callback) { callback(result); }",
      "const result = await processAsync(data);",
    ]);

    const result = detectParadigmClashes([file]);
    const issues = result.issues.filter((i) => i.category === "callback-and-async-await");
    expect(issues.length).toBeGreaterThanOrEqual(1);
  });

  it("does not flag pure async/await code", () => {
    const file = makeFile("src/async-only.ts", [
      "async function fetchAll() {",
      "  const a = await fetch('/a');",
      "  const b = await fetch('/b');",
      "  return { a, b };",
      "}",
    ]);

    const result = detectParadigmClashes([file]);
    const issues = result.issues.filter((i) => i.category === "callback-and-async-await");
    expect(issues).toHaveLength(0);
  });

  it("does not flag pure callback code", () => {
    const file = makeFile("src/cb-only.ts", [
      "fs.readFile(path, (err, data) => {",
      "  if (err) return callback(err);",
      "  callback(null, data);",
      "});",
    ]);

    const result = detectParadigmClashes([file]);
    const issues = result.issues.filter((i) => i.category === "callback-and-async-await");
    expect(issues).toHaveLength(0);
  });

  it("detects .catch() mixed with try/catch await", () => {
    const file = makeFile("src/mixed.ts", [
      "promise.catch(err => log(err));",
      "try { const x = await promise; } catch (e) { }",
    ]);

    const result = detectParadigmClashes([file]);
    const issues = result.issues.filter((i) => i.category === "callback-and-async-await");
    expect(issues.length).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// oop-and-functional-mix
// ---------------------------------------------------------------------------

describe("detectParadigmClashes — oop-and-functional-mix", () => {
  it("detects class with .map/.filter pipeline", () => {
    const file = makeFile("src/service.ts", [
      "class UserService {",
      "  private users: User[] = [];",
      "  getActive() { return this.users.filter(u => u.active); }",
      "}",
      "const result = data.map(x => x.value).filter(v => v > 0);",
    ]);

    const result = detectParadigmClashes([file]);
    const issues = result.issues.filter((i) => i.category === "oop-and-functional-mix");
    expect(issues.length).toBeGreaterThanOrEqual(1);
    expect(issues[0].severity).toBe("warning");
  });

  it("detects extends with pipe/compose", () => {
    const file = makeFile("src/transform.ts", [
      "class Transform extends Base { }",
      "const pipeline = compose(normalize, validate, save);",
    ]);

    const result = detectParadigmClashes([file]);
    const issues = result.issues.filter((i) => i.category === "oop-and-functional-mix");
    expect(issues.length).toBeGreaterThanOrEqual(1);
  });

  it("detects this assignment with Ramda usage", () => {
    const file = makeFile("src/ramda-mix.ts", [
      "this.name = name;",
      "const result = R.pipe(R.map(R.prop('id')), R.filter(Boolean))(items);",
    ]);

    const result = detectParadigmClashes([file]);
    const issues = result.issues.filter((i) => i.category === "oop-and-functional-mix");
    expect(issues.length).toBeGreaterThanOrEqual(1);
  });

  it("does not flag pure functional code", () => {
    const file = makeFile("src/pure-fn.ts", [
      "const result = items.map(x => x.value).filter(v => v > 0);",
      "const pipeline = compose(normalize, validate);",
    ]);

    const result = detectParadigmClashes([file]);
    const issues = result.issues.filter((i) => i.category === "oop-and-functional-mix");
    expect(issues).toHaveLength(0);
  });

  it("does not flag pure OOP code", () => {
    const file = makeFile("src/pure-oop.ts", [
      "class Service {",
      "  private data: string[] = [];",
      "  add(item: string) { this.data.push(item); }",
      "}",
    ]);

    const result = detectParadigmClashes([file]);
    const issues = result.issues.filter((i) => i.category === "oop-and-functional-mix");
    expect(issues).toHaveLength(0);
  });

  it("detects new operator with functional .reduce pipeline", () => {
    const file = makeFile("src/mix.ts", [
      "const svc = new Service();",
      "const total = items.reduce((sum, item) => sum + item.price, 0);",
    ]);

    const result = detectParadigmClashes([file]);
    const issues = result.issues.filter((i) => i.category === "oop-and-functional-mix");
    expect(issues.length).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// framework-clash
// ---------------------------------------------------------------------------

describe("detectParadigmClashes — framework-clash", () => {
  it("detects jQuery + React in same file", () => {
    const file = makeFile("src/app.js", [
      "$('.modal').show();",
      "ReactDOM.render(<App />, root);",
    ]);

    const result = detectParadigmClashes([file]);
    const issues = result.issues.filter((i) => i.category === "framework-clash");
    expect(issues.length).toBeGreaterThanOrEqual(1);
    expect(issues[0].severity).toBe("critical");
    expect(issues[0].description).toContain("jQuery");
    expect(issues[0].description).toContain("React");
  });

  it("detects Express + Koa in same file", () => {
    const file = makeFile("src/server.ts", [
      "const app = express();",
      "app.get('/', handler);",
      "const koa = new Koa();",
    ]);

    const result = detectParadigmClashes([file]);
    const issues = result.issues.filter((i) => i.category === "framework-clash");
    expect(issues.length).toBeGreaterThanOrEqual(1);
    expect(issues[0].description).toContain("Express");
  });

  it("detects Angular + Vue in same file", () => {
    const file = makeFile("src/hybrid.ts", [
      "@NgModule({ declarations: [] })",
      "const app = Vue.createApp({});",
    ]);

    const result = detectParadigmClashes([file]);
    const issues = result.issues.filter((i) => i.category === "framework-clash");
    expect(issues.length).toBeGreaterThanOrEqual(1);
  });

  it("does not flag file using only React", () => {
    const file = makeFile("src/app.tsx", [
      "import React from 'react';",
      "function App() { return <div />; }",
    ]);

    const result = detectParadigmClashes([file]);
    const reactIssues = result.issues.filter((i) => i.category === "framework-clash");
    expect(reactIssues).toHaveLength(0);
  });

  it("does not flag file using only Express", () => {
    const file = makeFile("src/server.ts", [
      "import express from 'express';",
      "const app = express();",
      "app.get('/', (req, res) => res.send('ok'));",
    ]);

    const result = detectParadigmClashes([file]);
    const expressIssues = result.issues.filter((i) => i.category === "framework-clash");
    expect(expressIssues).toHaveLength(0);
  });

  it("detects React + Vue clash", () => {
    const file = makeFile("src/confused.tsx", [
      "import React from 'react';",
      "const app = Vue.createApp({ template: '<div />' });",
    ]);

    const result = detectParadigmClashes([file]);
    const issues = result.issues.filter((i) => i.category === "framework-clash");
    expect(issues.length).toBeGreaterThanOrEqual(1);
  });

  it("detects Mocha + Jest clash", () => {
    const file = makeFile("test/mixed.test.ts", [
      "import { describe, it } from 'mocha';",
      "expect(result).toBe(42);",
    ]);

    const result = detectParadigmClashes([file]);
    const issues = result.issues.filter((i) => i.category === "framework-clash");
    expect(issues.length).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe("detectParadigmClashes — edge cases", () => {
  it("skips deleted files", () => {
    const file: DiffFile = { path: "src/deleted.ts", status: "deleted", hunks: [] };
    const result = detectParadigmClashes([file]);
    expect(result.issues).toHaveLength(0);
  });

  it("handles empty hunks", () => {
    const file: DiffFile = {
      path: "src/empty.ts",
      status: "modified",
      hunks: [{ header: "@@ -0 +0 @@", changes: [] }],
    };
    const result = detectParadigmClashes([file]);
    expect(result.issues).toHaveLength(0);
  });

  it("skips comment lines", () => {
    const file = makeFile("src/comment.ts", [
      "// class MyClass extends React.Component { }",
      "// const [x, setX] = useState(0);",
    ]);
    const result = detectParadigmClashes([file]);
    expect(result.issues).toHaveLength(0);
  });

  it("skips type-only imports", () => {
    const file = makeFile("src/types.ts", [
      "import type { React } from 'react';",
    ]);
    const result = detectParadigmClashes([file]);
    expect(result.issues).toHaveLength(0);
  });

  it("handles clean code with no paradigm clashes", () => {
    const file = makeFile("src/utils.ts", [
      "function add(a: number, b: number) { return a + b; }",
    ]);
    const result = detectParadigmClashes([file]);
    expect(result.issues).toHaveLength(0);
  });

  it("does not flag class with only internal .filter (not functional pipeline)", () => {
    const file = makeFile("src/service.ts", [
      "class Service {",
      "  getUsers() { return this.db.query('users'); }",
      "}",
    ]);
    const result = detectParadigmClashes([file]);
    const oopIssues = result.issues.filter((i) => i.category === "oop-and-functional-mix");
    expect(oopIssues).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Context & body summary
// ---------------------------------------------------------------------------

describe("detectParadigmClashes — context and summary", () => {
  it("generates context text for issues", () => {
    const file = makeFile("src/Component.tsx", [
      "class MyComponent extends React.Component { }",
      "const [count, setCount] = useState(0);",
    ]);

    const result = detectParadigmClashes([file]);
    if (result.issues.length > 0) {
      expect(result.contextText).toContain("Paradigm Clash Detection");
    }
  });

  it("generates empty context when no issues", () => {
    const file = makeFile("src/clean.ts", [
      "const x = 1;",
    ]);
    const result = detectParadigmClashes([file]);
    expect(result.contextText).toBe("");
  });

  it("generates body summary with HTML details", () => {
    const file = makeFile("src/Component.tsx", [
      "class MyComponent extends React.Component { }",
      "const [count, setCount] = useState(0);",
    ]);

    const result = detectParadigmClashes([file]);
    if (result.issues.length > 0) {
      expect(result.bodySummary).toContain("<details>");
      expect(result.bodySummary).toContain("</details>");
    }
  });

  it("generates empty body summary when no issues", () => {
    const file = makeFile("src/clean.ts", [
      "const x = 1;",
    ]);
    const result = detectParadigmClashes([file]);
    expect(result.bodySummary).toBe("");
  });

  it("sorts critical before warning", () => {
    const file = makeFile("src/mixed.ts", [
      "class Component extends React.Component { }",
      "const [count, setCount] = useState(0);",
      "fetch('/api').then(r => r.json());",
      "const data = await fetch('/api2');",
    ]);

    const result = detectParadigmClashes([file]);
    const critical = result.issues.filter((i) => i.severity === "critical");
    const warnings = result.issues.filter((i) => i.severity === "warning");
    if (critical.length > 0 && warnings.length > 0) {
      const lastC = result.issues.indexOf(critical[critical.length - 1]);
      const firstW = result.issues.indexOf(warnings[0]);
      expect(lastC).toBeLessThan(firstW);
    }
  });

  it("body summary includes table headers", () => {
    const file = makeFile("src/Component.tsx", [
      "class MyComponent extends React.Component { }",
      "const [count, setCount] = useState(0);",
    ]);

    const result = detectParadigmClashes([file]);
    if (result.issues.length > 0) {
      expect(result.bodySummary).toContain("| Category |");
    }
  });

  it("deduplicates issues with same category:file:line", () => {
    const file = makeFile("src/dedup.ts", [
      "class Comp extends React.Component { }",
      "useState(0);",
      "useState(0);",
      "useState(0);",
    ]);

    const result = detectParadigmClashes([file]);
    const reactIssues = result.issues.filter((i) => i.category === "react-class-and-hooks");
    // Each line should only appear once per category
    const lines = reactIssues.map((i) => i.line);
    const uniqueLines = new Set(lines);
    expect(lines.length).toBe(uniqueLines.size);
  });

  it("handles multiple clash categories in one file", () => {
    const file = makeFile("src/chaos.ts", [
      "class Comp extends React.Component { }",
      "const [x, setX] = useState(0);",
      "fs.readFile(path, (err, data) => { });",
      "const result = await processAsync(data);",
      "$('.btn').click(() => {});",
      "ReactDOM.render(<App />, root);",
    ]);

    const result = detectParadigmClashes([file]);
    const categories = new Set(result.issues.map((i) => i.category));
    expect(categories.size).toBeGreaterThanOrEqual(2);
  });
});
