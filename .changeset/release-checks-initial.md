---
"@agent-teams/release-checks": minor
---

Introduce an independent development library that checks a frozen release-engine
plan against the complete observed candidate. It validates exact version and
intent effects, manifest content, source bindings and permitted file changes.
Repository Hosts retain generation, content policy, authentication and
publication; Changesets remains the version engine.
