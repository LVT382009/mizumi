# Mizumi Build Log

## Cycle 1 — 2026-05-23

### Research Agents Completed
1. **AI SDK 6 + Zod v4** — CONFIRMED: AI SDK 6 (v6.0.191) natively supports Zod v4 (^4.1.8+). `Output.object({ schema })` works directly. No `zod-to-json-schema` adapter needed. Breaking change: `generateObject()` deprecated, use `generateText() + Output.object()`. Return value is `{ output }` not `{ object }`.
2. **Node 24 Migration** — `using: node24` in action.yml. `@actions/core` v3.0.1 (ESM-only). `@actions/github` v9.1.1 (ESM-only). `@octokit/rest` v22.0.1.
3. **reviewdog + SourceAnt + diff0 patterns** — Detailed analysis of position mapping, fingerprint dedup, suggestion block formatting, and 422 fallback strategies.

### Research Agents Spawned (Running)
4. **TypeScript compilation verifier** — npm install + tsc --noEmit
5. **Security audit (sanitize.ts)** — checking for bypass vectors

### Phase 0 Progress
- [x] action.yml — using: node24, 10 inputs, 3 outputs, MIZUMI_ANTHROPIC_API_KEY naming
- [x] package.json — ESM, all 14 deps, dev deps
- [x] tsconfig.json — strict, ES2024 target, bundler moduleResolution
- [x] src/main.ts — full pipeline: rules → review → critique → post → memory
- [x] src/config.ts — .github/mizumi.yml parser + BYOK provider selection + getApiKey()
- [x] src/diff.ts — fetchDiff (3 strategies), parseDiff with rawDiff, PII stripping
- [x] src/linemap.ts — buildLineMapFromRawDiff (diff0 pattern) + buildLineMap fallback, 4-strategy resolvePosition, buildPositionHint
- [x] src/context.ts — diff + memory + rules + PR metadata assembly
- [x] src/review.ts — AI SDK 6 Output.object() + Zod v4 structured output, BYOK multi-provider, profile-aware system prompt
- [x] src/critique.ts — two-pass "subterfuge" framing, cheap model for critique
- [x] src/post.ts — reviewdog pattern: inline suggestions + HTML marker dedup + 422 fallback + output screening
- [x] src/sanitize.ts — Comment-and-Control defense, recursive HTML comment strip, output screening, canary-ready
- [x] src/memory.ts — MEMORY.md reader/writer, ~2KB bounded, consolidation at 80%
- [x] src/rules.ts — deterministic regex checks: auth middleware, hardcoded secrets, SQL injection
- [x] rollup.config.ts — Rollup >=4.59.0, better-sqlite3 external
- [x] .github/workflows/review.yml — pull_request + issue_comment trigger
- [x] .gitignore

### Next Steps
- [ ] npm install + tsc --noEmit passes (verifier agent running)
- [ ] Fix any TS errors found
- [ ] Write unit tests for linemap.ts, sanitize.ts, config.ts
- [ ] Build with rollup and verify dist/index.js output
