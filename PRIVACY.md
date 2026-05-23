# Privacy Policy

## What Mizumi Processes

When Mizumi reviews a pull request, it processes:

| Data | Source | Sent to LLM? | Stored? |
|---|---|---|---|
| PR diff (code changes) | GitHub API | Yes (sanitized) | No |
| PR title and description | GitHub API | Yes (sanitized) | No |
| Review comments | GitHub API | Yes (sanitized) | No |
| `.github/mizumi-memory.md` | Repository | Yes | Updated in repo |
| `.github/mizumi.yml` config | Repository | No (parsed locally) | No |
| `REVIEW.md` / `CLAUDE.md` | Repository | Yes (as rules context) | No |

## What Mizumi Does NOT Process

- Repository secrets or environment variables (beyond API keys needed for LLM calls)
- Code outside the PR diff
- User profile data
- CI/CD logs or artifacts
- Issue content (unless referenced in PR description)

## Data Flow

```
GitHub PR → Mizumi Action → Input Sanitization → LLM Provider → Output Screening → GitHub Comment
```

1. PR content is fetched via GitHub API
2. PII (commit author name/email) is stripped before LLM call
3. Sanitized content is sent to the user's chosen LLM provider
4. LLM output is screened for secrets/URLs/commands
5. Filtered output is posted as a PR review comment

## Data Retention

- **Mizumi does NOT operate a server.** It runs entirely within GitHub Actions.
- **No data is sent to Mizumi's infrastructure.** All LLM calls go directly to the user's configured provider.
- **Memory persistence** is a flat file (`.github/mizumi-memory.md`) stored in the repository. Teams control this data directly.
- **GitHub Actions logs** may contain non-sensitive metadata (file counts, finding counts). Secrets are never logged.

## User Control

- Users choose their own LLM provider and API key via GitHub Secrets
- Users control which files are excluded from review via `.github/mizumi.yml`
- Users can disable auto-review and trigger manually with `/mizumi`
- Users can delete or edit `.github/mizumi-memory.md` at any time
- The `chill` profile minimizes unnecessary data processing by focusing only on bugs and security

## GDPR Compliance

- **Data Controller:** The repository owner (not Mizumi)
- **Data Processing:** Occurs within the repository owner's GitHub Actions infrastructure
- **Right to Erasure:** Delete `.github/mizumi-memory.md` and any review comments
- **Data Portability:** All Mizumi data is in human-readable markdown files in the repository

## Recommendations

1. Use dedicated API keys with minimum required permissions
2. Rotate API keys periodically
3. Review `.github/mizumi-memory.md` content for sensitive patterns
4. Use `exclude:` patterns in `.github/mizumi.yml` to skip files containing sensitive logic
