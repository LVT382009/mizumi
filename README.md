# Mizumi — Self-Learning PR Review Agent

> AI generates code 10x faster. Reviewing it is your #1 bottleneck.

Mizumi is a GitHub Action that reviews pull requests using AI, learns from past reviews, and posts actionable findings — with deterministic rules that never hallucinate.

**The numbers:** Teams with high AI adoption merge 98% more PRs — but review time increases 91% and PRs merging with zero review are up 31% ([Faros AI](https://www.getfaros.com), [AI Engineering Report 2026](https://dev.to/code-board/the-review-bottleneck-why-faster-code-generation-isnt-faster-delivery-4273)). AI review adoption grew from 14.8% to 51.4% in 2025 ([Jellyfish](https://jellyfish.co)), with 1.3M repos now using AI-assisted review ([GitHub Octoverse 2025](https://octoverse.github.com)). Yet 40% of organizations report a capacity gap in code review. Mizumi closes this gap: instant, consistent AI review for every PR.

**Why not Copilot Review?** 67% of engineers already use Copilot Review ([Jellyfish](https://jellyfish.co), Dec 2025). It's everywhere — but it's surface-level: generic style comments, no self-learning, no deterministic rules, and vendor lock-in. Mizumi is the specialist: BYOK with 7 providers (Anthropic, OpenAI, Google, NVIDIA NIM, OpenRouter, local models, any OpenAI-compatible endpoint), self-learning memory that adapts to your repo, deterministic secret/auth/SQL rules that never hallucinate, and Mermaid diagrams that visualize your change architecture. At $0.001–$0.08/review (your own API key), it's 100–10,000x cheaper than Anthropic's Code Review ($15–$25/review, ~20 min/PR).

## Features

- **BYOK from day 1** — Bring your own key for Anthropic, OpenAI, Google, NVIDIA NIM, OpenRouter, or any OpenAI-compatible endpoint (Together AI, Groq, DeepSeek, Fireworks, Ollama, llama.cpp, LM Studio)
- **Self-learning** — Remembers past review patterns per repository via `.github/mizumi-memory.md`
- **Deterministic rules** — Catches hardcoded secrets, missing auth middleware, and SQL injection WITHOUT any LLM call
- **Persistent rule engine** — Custom regex/glob rules in `.github/mizumi-rules.yml`, auto-discovered rules from PR review history, and rule decay that retires stale patterns
- **Two-pass review** — LLM review + self-critique on a cheaper model to reduce false positives
- **Noise control** — `chill` profile (default) only flags bugs and security issues. `assertive` adds style/docs
- **Input sanitization** — Defends against prompt injection from malicious PR content
- **Output screening** — Redacts secrets, external URLs, and shell commands from review output
- **Prompt injection defense framework** — Multi-layer defense-in-depth with content provenance tagging and behavioral anomaly detection (first AI code review tool with explicit defense architecture)
- **Spend tracking** — JSONL append-only log with token usage per review
- **Webhook idempotency + SHA dedup** — Prevents duplicate reviews from webhook retries
- **Slop detection** — Skips deep review for low-quality AI-generated PRs
- **VS Code deep-links** — Each review comment includes a `vscode://file/` link
- **Tier routing** — Small diffs route to a cheaper model to reduce cost
- **Confidence calibration** — Dual-model voting on borderline findings (high/medium/low badges)
- **Ticket compliance** — Checks if PR changes match referenced GitHub Issues (3-tier: fully/partially/not)
- **Change Stack** — Reorganizes large PR output into dependency order (data models → contracts → logic → consumers → tests)
- **Auto-fix on 👍** — React with thumbs-up on any Mizumi suggestion to auto-apply the fix
- **CI-validated fix loop** — Apply suggestions, poll CI checks, revert on failure, and retry (only Macroscope has similar)
- **Fuzzy dedup** — Suppresses near-duplicate findings and cleans stale comments using rapid-fuzzy matching
- **SQLite learning** — Tracks suggestion acceptance rates, promotes/demotes categories based on past feedback
- **Mermaid diagrams** — Auto-generates architecture and severity distribution diagrams in review output (GitHub renders natively)
- **Learning persistence** — Commits memory, feedback, and skills back to the repo so they survive between Action runs

## Quick Start

```yaml
# .github/workflows/review.yml
name: Mizumi Review
on:
  pull_request:
    types: [opened, synchronize, ready_for_review]
  issue_comment:
    types: [created]

jobs:
  review:
    if: >
      github.event_name == 'pull_request' ||
      (github.event_name == 'issue_comment' &&
       startsWith(github.event.comment.body, '/mizumi'))
    runs-on: ubuntu-latest
    permissions:
      pull-requests: write
      contents: write
      issues: write
    steps:
      - uses: actions/checkout@v4
        with:
          persist-credentials: false
      - uses: LVT382009/mizumi@v0.1
        with:
          anthropic_api_key: ${{ secrets.ANTHROPIC_API_KEY }}
          # openai_api_key: ${{ secrets.OPENAI_API_KEY }}
          # google_api_key: ${{ secrets.GOOGLE_API_KEY }}
          # nvidia_api_key: ${{ secrets.NVIDIA_NIM_API_KEY }}
          model: claude-sonnet-4-6
          provider: anthropic
          profile: chill
```

## Configuration

### Action Inputs

| Input | Default | Description |
|---|---|---|
| `anthropic_api_key` | — | Anthropic API key |
| `openai_api_key` | — | OpenAI API key |
| `google_api_key` | — | Google AI API key |
| `openrouter_api_key` | — | OpenRouter API key |
| `nvidia_api_key` | — | NVIDIA NIM API key (`nvapi-*`) |
| `local_api_key` | `"dummy"` | API key for local/self-hosted model (Ollama/llama.cpp/LM Studio usually don't need one) |
| `custom_api_key` | — | API key for custom OpenAI-compatible endpoint (Together AI, Groq, DeepSeek, etc.) |
| `base_url` | — | Custom base URL for OpenAI-compatible endpoint |
| `model` | `claude-sonnet-4-6` | Model to use (any model ID supported by your provider) |
| `provider` | `anthropic` | `anthropic` \| `openai` \| `google` \| `openrouter` \| `nvidia` \| `local` \| `custom` |
| `profile` | `chill` | `chill` (bugs/security) \| `assertive` (+ style) \| `followup` (+ check prior comments) |
| `max_comments` | `15` | Max inline comments per review |
| `self_critique` | `true` | Enable two-pass self-critique |
| `confidence_threshold` | `80` | Filter findings with confidence < N (0-100) |
| `auto_review` | `true` | Auto-review on PR events |
| `auto_pause_after` | `5` | Stop auto-reviewing after N reviews per PR |
| `language` | `en-US` | Review comment language |
| `tier_routing` | `true` | Route small diffs to a cheaper model |
| `small_diff_threshold` | `50` | Line count threshold for tier routing |
| `compliance_check` | `true` | Check ticket-to-code compliance |
| `auto_fix` | `false` | Auto-apply suggestions on 👍 reaction |
| `confidence_calibration` | `true` | Dual-model voting on borderline findings |
| `change_stack` | `true` | Reorganize output into dependency order |
| `improve_enabled` | `false` | Enable /mizumi improve (requires contents: write) |
| `rule_engine` | `true` | Enable persistent rule engine with auto-discovery |
| `ci_validated_fix` | `false` | CI-validated fix loop: apply suggestions, poll CI, revert on failure (requires `improve_enabled`) |
| `ci_fix_timeout` | `600` | Max seconds to wait for CI checks on fix commit |
| `ci_fix_max_retries` | `3` | Max fix attempts before giving up |
| `ci_fix_revert_on_failure` | `true` | Revert fix commit if CI fails |

### Per-Repository Config (`.github/mizumi.yml`)

```yaml
llm:
  model: claude-sonnet-4-6
  # base_url: https://api.together.xyz/v1   # For custom provider

review:
  profile: chill
  max_comments: 15
  confidence_threshold: 80

exclude:
  - "*.lock"
  - "dist/**"
  - "vendor/**"
  - "generated/**"
```

### Project Rules

Create `REVIEW.md` or `CLAUDE.md` in your repo root or `.github/` directory. Mizumi reads these and includes them as review context:

```markdown
# Review Rules
- Always use parameterized queries (no string concatenation)
- All API routes must call authentication middleware
- Never commit secrets — use environment variables
```

### Self-Learning Memory

Mizumi writes to `.github/mizumi-memory.md` after each review, capturing patterns from critical/high findings. This memory is injected into future reviews, helping Mizumi learn repository-specific patterns. You can edit or delete this file at any time.

### Custom Rules (`.github/mizumi-rules.yml`)

Define project-specific regex or glob rules that run deterministically before LLM review:

```yaml
rules:
  - name: no-console-log
    pattern: "console\\.log"
    file_glob: "src/**/*.ts"
    severity: low
    category: style
    message: "Avoid console.log in production code"

  - name: no-eval
    pattern: "\\beval\\s*\\("
    severity: critical
    category: security
    message: "eval() is a security risk"

  - name: check-auth-files
    type: glob
    file_glob: "src/auth/**"
    severity: medium
    category: security
    pattern: ""
    message: "Auth file modified — verify authorization logic"
```

### Auto-Discovered Rules

Mizumi mines patterns from review history stored in SQLite. When the same file+category pattern appears 3+ times with 40%+ acceptance rate, Mizumi auto-discovers a rule that flags similar files in future reviews. Discovered rules decay over time when their category has low acceptance — rules below 30 confidence are automatically retired.

### CI-Validated Fix Loop

When `ci_validated_fix` and `improve_enabled` are both `true`, Mizumi enters a self-healing loop after applying fix suggestions:

1. **Apply** — Commit suggestion blocks to the PR branch (via Git Data API)
2. **Poll** — Wait for CI checks on the fix commit (`repos.getCombinedStatusForRef` + `checks.listForRef`)
3. **Validate** — If CI passes: done. If CI fails: revert the fix commit and retry (up to `ci_fix_max_retries`)
4. **Revert** — Uses `git.updateRef` (force) to reset the branch to the pre-fix parent SHA

This prevents broken code from landing: every auto-fix is validated against your CI before being accepted. No other AI reviewer (except Macroscope) offers this.

```yaml
- uses: LVT382009/mizumi@v0.1
  with:
    improve_enabled: true
    ci_validated_fix: true
    ci_fix_timeout: 600        # 10 min max CI wait
    ci_fix_max_retries: 3      # up to 3 fix attempts
    ci_fix_revert_on_failure: true  # revert broken fixes
```

### Manual Trigger

Comment `/mizumi` on any PR to trigger a review on demand. This bypasses the `auto_pause_after` limit.

### Subcommands

| Command | Description |
|---|---|
| `/mizumi describe` | Generates a structured PR description from diff analysis |
| `/mizumi improve` | Applies ```suggestion blocks from review comments via Git Data API (one-click fix) |
| `/mizumi spend` | Shows token usage digest across reviews |
| `/mizumi test` | Generates vitest test skeletons for critical/high findings |

### Auto Skill Generation

When Mizumi detects recurring review patterns, it writes reusable skill files to `.github/mizumi-skills/`. These skills are injected into future reviews, letting Mizumi apply learned patterns deterministically without re-discovering them. You can edit or delete skill files at any time.

## NVIDIA NIM Setup

```yaml
- uses: mizumi-dev/mizumi@v0.1
  with:
    nvidia_api_key: ${{ secrets.NVIDIA_NIM_API_KEY }}
    provider: nvidia
    model: meta/llama-3.3-70b-instruct
```

## Local Model Setup (Ollama, llama.cpp, LM Studio)

```yaml
- uses: mizumi-dev/mizumi@v0.1
  with:
    provider: local
    base_url: http://localhost:11434/v1   # Ollama default
    # base_url: http://localhost:8081/v1  # llama.cpp server
    # base_url: http://localhost:1234/v1  # LM Studio
    model: llama3
```

## Custom Provider (Together AI, Groq, DeepSeek, etc.)

```yaml
- uses: mizumi-dev/mizumi@v0.1
  with:
    provider: custom
    custom_api_key: ${{ secrets.CUSTOM_API_KEY }}
    base_url: https://api.together.xyz/v1
    model: meta-llama/llama-3.3-70b-instruct
```

## Outputs

| Output | Description |
|---|---|
| `review_id` | ID of the posted PR review |
| `finding_count` | Number of findings posted |
| `risk_score` | Risk score 1-5 |
| `compliance` | Ticket-to-code compliance level (fully/partially/not/none) |
| `auto_fixed` | Number of suggestions auto-applied via 👍 reaction approval |

## Comparison

| | Mizumi | Copilot Review | CodeRabbit | Anthropic Code Review | Macroscope |
|---|---|---|---|---|---|
| **Cost/review** | $0.001–$0.08 (BYOK) | $19–$39/user/mo | Free / $24+/user/mo | $15–$25 | ~$0.95 avg |
| **Providers** | 7 + any OpenAI-compat | Multi-model | OpenAI/Anthropic | Anthropic-only | Own model + AST |
| **Self-learning** | Memory + SQLite + skills + auto-discovery | No | Learnable prefs | No | No |
| **Deterministic rules** | 12 built-in + custom YAML + auto-discovered | ESLint/CodeQL only | 40+ built-in linters | No | AST graph analysis |
| **Mermaid diagrams** | Architecture + severity | No | No | No | No |
| **Speed** | Seconds | Seconds | ~30s | ~20 min | Fast |
| **Review depth** | Two-pass + calibration | Surface (36.7% recall) | Standard (46% detect) | Deep (multi-agent) | Deep (48% detect) |
| **Custom rules** | mizumi-rules.yml + REVIEW.md + CLAUDE.md | copilot-instructions.md | .coderabbit.yaml | Custom instructions | Config file |
| **Auto-discovered rules** | Yes (SQLite mining + decay) | Suggested rules (beta) | No | No | No |
| **Auto-fix** | 👍 reaction → commit | No | Yes | No | CI-validated fix loop |
| **Platforms** | GitHub (v0.1) | GitHub-only | GitHub + GitLab + Azure + Bitbucket | GitHub-only | GitHub-only |
| **CI-validated fixes** | Yes (poll+revert+retry) | No | No | No | Yes |

> **Note:** Published detection benchmarks (including Macroscope's 48% rate, 98% precision) are vendor self-reported and should be treated as directional rather than definitive. Every vendor wins their own benchmark.

## License

MIT — See [LICENSE](LICENSE) for details.

## Disclaimer

**This review was AI-generated by Mizumi. Always verify findings before acting. Not a substitute for human security review.**

Users are responsible for ensuring they have rights to send code to their chosen LLM provider. Mizumi does not verify data rights. Review output may contain inaccuracies — treat all findings as suggestions requiring human validation.
