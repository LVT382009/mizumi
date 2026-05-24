# Mizumi — Self-Learning PR Review Agent

> AI generates code 10x faster. Reviewing it is your #1 bottleneck.

Mizumi is a GitHub Action that reviews pull requests using AI, learns from past reviews, and posts actionable findings — with deterministic rules that never hallucinate.

**The numbers:** Teams with high AI adoption merge 98% more PRs — but review time increases 91% and PRs merging with zero review are up 31% ([Faros AI](https://www.getfaros.com), [AI Engineering Report 2026](https://dev.to/code-board/the-review-bottleneck-why-faster-code-generation-isnt-faster-delivery-4273)). Mizumi closes this gap: instant, consistent AI review for every PR.

**Why not use Anthropic's own Code Review?** It costs $15–$25 per review and takes ~20 minutes. Mizumi's BYOK model costs $0.001–$0.08 per review — a 100–10,000x price gap — and runs in seconds, not minutes. Plus Mizumi works with any provider, not just Anthropic.

## Features

- **BYOK from day 1** — Bring your own key for Anthropic, OpenAI, Google, NVIDIA NIM, OpenRouter, or any OpenAI-compatible endpoint (Together AI, Groq, DeepSeek, Fireworks, Ollama, llama.cpp, LM Studio)
- **Self-learning** — Remembers past review patterns per repository via `.github/mizumi-memory.md`
- **Deterministic rules** — Catches hardcoded secrets, missing auth middleware, and SQL injection WITHOUT any LLM call
- **Two-pass review** — LLM review + self-critique on a cheaper model to reduce false positives
- **Noise control** — `chill` profile (default) only flags bugs and security issues. `assertive` adds style/docs
- **Input sanitization** — Defends against prompt injection from malicious PR content
- **Output screening** — Redacts secrets, external URLs, and shell commands from review output
- **Spend tracking** — JSONL append-only log with token usage per review
- **Webhook idempotency + SHA dedup** — Prevents duplicate reviews from webhook retries
- **Slop detection** — Skips deep review for low-quality AI-generated PRs
- **VS Code deep-links** — Each review comment includes a `vscode://file/` link
- **Tier routing** — Small diffs route to a cheaper model to reduce cost
- **Confidence calibration** — Dual-model voting on borderline findings (high/medium/low badges)
- **Ticket compliance** — Checks if PR changes match referenced GitHub Issues (3-tier: fully/partially/not)
- **Change Stack** — Reorganizes large PR output into dependency order (data models → contracts → logic → consumers → tests)
- **Auto-fix on 👍** — React with thumbs-up on any Mizumi suggestion to auto-apply the fix
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
      - uses: mizumi-dev/mizumi@v0.1
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

## License

MIT — See [LICENSE](LICENSE) for details.

## Disclaimer

**This review was AI-generated by Mizumi. Always verify findings before acting. Not a substitute for human security review.**

Users are responsible for ensuring they have rights to send code to their chosen LLM provider. Mizumi does not verify data rights. Review output may contain inaccuracies — treat all findings as suggestions requiring human validation.
