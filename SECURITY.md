# Security policy

Thanks for helping keep Writer Studio and its users safe.

## Reporting a vulnerability

Please **do not** file a public GitHub issue for security problems.

- Preferred: [private vulnerability report](https://github.com/dirghaai/writer-studio/security/advisories/new) through GitHub's Security Advisories.
- Alternative: email `security@dirgha.ai` with the word `SECURITY` in the subject and `writer-studio` in the body.

We will acknowledge within **24 hours** (business days) and aim to triage within **72 hours**. We will keep you informed through remediation and credit you in the advisory unless you prefer to remain anonymous.

## Scope

In scope:

- Source code in this repository.
- Production dependencies declared in `package.json`.
- Official release artifacts (npm, Docker, GitHub Releases) shipped under this repo.

Out of scope:

- Issues in example code or fixtures explicitly labeled as illustrations.
- Vulnerabilities that require a user to run a modified or untrusted build.
- Social-engineering attacks.
- Denial-of-service via third-party provider rate limits.
- Third-party services the project integrates with — report those to the provider.

## What counts as a security issue

High priority:

- Remote code execution, sandbox escape, or unauthorized privilege escalation.
- Authentication or authorization bypass.
- Credential leakage — logs, persistence, telemetry, or transmission of secrets to unintended destinations.
- Supply-chain compromise in a pinned dependency.
- Injection vulnerabilities (SQL, prompt, command, path traversal).

Lower priority but still reportable:

- Insecure defaults in a supported configuration.
- TOCTOU or race conditions.
- Missing security headers on API responses.

## Responsible disclosure

We ask that you:

- Give us reasonable time to remediate before public disclosure (90 days is typical).
- Do not access or retain user data beyond what is needed to demonstrate the issue.
- Do not run destructive tests against production infrastructure — a minimal proof-of-concept is sufficient.

## Hall of fame

Contributors who report valid issues are credited in the GitHub Security Advisory, unless they opt out.

## PGP

If you need to encrypt your report, request a public key at `security@dirgha.ai`.
