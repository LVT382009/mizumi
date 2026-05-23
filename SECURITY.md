# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability in Mizumi, please report it responsibly:

- **Email:** Open an issue at [github.com/mizumi-dev/mizumi/security](https://github.com/mizumi-dev/mizumi/security/advisories/new)
- **Do NOT** file a public issue for security vulnerabilities

We aim to respond within 48 hours and patch critical vulnerabilities within 7 days.

## Security Architecture

### Input Sanitization
All PR content (title, description, diff, comments) is treated as **untrusted input** before being sent to any LLM:
- HTML comments are recursively stripped (prevents "Comment and Control" attacks)
- Known prompt injection patterns are filtered
- Base64-encoded payloads are decoded and re-checked
- Diff content is wrapped in `UNTRUSTED INPUT` delimiters
- Input is capped at 10,000 lines

### Output Screening
All LLM output is screened before posting to GitHub:
- API keys (`sk-*`, `AKIA*`, `ghp_*`, etc.) are redacted
- External URLs (non-github.com) are redacted
- Shell commands are redacted
- `<img>` tags are stripped (CamoLeak defense)

### Secret Handling
- API keys are passed via GitHub Secrets (encrypted at rest)
- Mizumi never logs or stores API keys
- No secrets are included in review output

### Permissions
Mizumi requests minimal GitHub permissions:
- `pull-requests: write` — post review comments
- `contents: read` — read repository files
- `checks: write` — create check runs
- `issues: write` — post summary comments

## Threat Model

| Attack Vector | Mitigation |
|---|---|
| Prompt injection via PR content | Input sanitization + untrusted input delimiters |
| Secret exfiltration via LLM output | Output screening with regex patterns |
| CamoLeak (img tag exfiltration) | Strip `<img>` tags before URL redaction |
| Token-bomb (repeated content) | Repetition collapse at 50+ chars x 3 repeats |
| Base64-encoded injection | Decode + re-check injection patterns |
| API key exposure | GitHub Secrets + output redaction |

## Known Limitations
- Deterministic sanitization cannot catch all prompt injection variants
- LLM providers may have their own safety training that complements or conflicts with Mizumi's filtering
- This is NOT a substitute for human security review
