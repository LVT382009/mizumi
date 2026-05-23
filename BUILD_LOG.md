# Mizumi Build Log

## Cycle 1 — 2026-05-23

### Research Agents Completed
1. **AI SDK 6 + Zod v4** — CONFIRMED: AI SDK 6 (v6.0.191) natively supports Zod v4 (^4.1.8+). `Output.object({ schema })` works directly. No `zod-to-json-schema` adapter needed. Breaking change: `generateObject()` deprecated, use `generateText() + Output.object()`. Return value is `{ output }` not `{ object }`. `maxTokens` → `maxOutputTokens`.
2. **Node 24 Migration** — `using: node24` in action.yml. `@actions/core` v3.0.1 (ESM-only). `@actions/github` v9.1.1 (ESM-only). `@octokit/rest` v22.0.1.
3. **reviewdog + SourceAnt + diff0 patterns** — Detailed analysis of position mapping, fingerprint dedup, suggestion block formatting, and 422 fallback strategies.
4. **GitHub API position deprecation** — `position` is deprecated in favor of `line`/`start_line`/`side`/`start_side`. Single-line: `{ path, line, side: "RIGHT", body }`. Multi-line: `{ path, start_line, line, start_side: "RIGHT", side: "RIGHT", body }`.

### Phase 0 Progress
- [x] action.yml — using: node24, 10 inputs, 3 outputs, MIZUMI_ANTHROPIC_API_KEY naming
- [x] package.json — ESM, all deps, dev deps
- [x] tsconfig.json — strict, ES2024 target, bundler moduleResolution
- [x] src/main.ts — full pipeline: rules → review → critique → post → memory
- [x] src/config.ts — .github/mizumi.yml parser + BYOK provider selection + getApiKey()
- [x] src/diff.ts — fetchDiff (3 strategies), parseDiff with rawDiff, PII stripping
- [x] src/linemap.ts — MIGRATED from position Map to LineMap (Set-based): validates line numbers in diff, no longer computes deprecated diff positions. resolveLine() with ±5 proximity.
- [x] src/context.ts — diff + memory + rules + PR metadata assembly
- [x] src/review.ts — AI SDK 6 Output.object() + Zod v4 structured output, BYOK multi-provider, profile-aware system prompt
- [x] src/critique.ts — two-pass "subterfuge" framing, cheap model for critique, exported filterByConfidence + parseCritiqueOutput
- [x] src/post.ts — MIGRATED from deprecated `position` to `line`/`start_line`/`side`/`start_side`. reviewdog pattern: inline suggestions + HTML marker dedup + 422 fallback
- [x] src/sanitize.ts — Comment-and-Control defense, recursive HTML comment strip, output screening, canary-ready
- [x] src/memory.ts — MEMORY.md reader/writer, ~2KB bounded, consolidation at 80%
- [x] src/rules.ts — deterministic regex checks: auth middleware, hardcoded secrets, SQL injection
- [x] rollup.config.ts — Rollup >=4.59.0, inlineDynamicImports, sourcemaps
- [x] .github/workflows/review.yml — pull_request + issue_comment trigger, uses: ./
- [x] .gitignore — dist/ exclusions removed (dist/index.js checked in per JS Action convention)
- [x] tsconfig.test.json — test-inclusive TS check (separate from build)
- [x] BUILD passes: `dist/index.js` produced, 2.5MB single bundle

### Test Coverage (206 tests, 9 files, ALL PASSING)
- `sanitize.test.ts` — 45 tests (input sanitization, output screening, wrap diff)
- `linemap.test.ts` — 21 tests (buildLineMapFromRawDiff as Set, isValidLine, resolveLine, buildPositionHint)
- `config.test.ts` — 18 tests (YAML parser, BYOK env vars, exclude patterns)
- `rules.test.ts` — 36 tests (auth middleware, hardcoded secrets, SQL concat, edge cases)
- `post.test.ts` — 30 tests (line-based comments, overflow, 422 fallback, marker dedup, risk display, multi-line)
- `diff.test.ts` — 21 tests (parseDiff, excludePatterns, stripPatchPII, fetchDiff mock)
- `memory.test.ts` — 11 tests (read/write/consolidate, readRules)
- `critique.test.ts` — 18 tests (filterByConfidence, parseCritiqueOutput, runCritique with mocks)
- `context.test.ts` — 6 tests (PR metadata, diff text, file paths, memory/rules)

### Key Architectural Decisions This Cycle
1. **Line-based comments** — Migrated from deprecated `position` to `line`/`side` params. Simplified linemap.ts from `Map<file, Map<line, position>>` to `Map<file, Set<line>>`.
2. **Checked-in dist/** — `dist/index.js` is committed per JS Action convention (needed for `uses: ./`).
3. **Dual tsconfig** — `tsconfig.json` excludes tests (for rollup build), `tsconfig.test.json` includes all (for `npm run check`).
4. **Exported critique helpers** — `filterByConfidence` and `parseCritiqueOutput` now exported for testing.

### Production Code: 1,521 lines (under 3,000 budget)
### Total with tests: ~2,500 lines
