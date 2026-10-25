# @agent-teams/release-checks

## 0.1.0

### Minor Changes

- [#421](https://github.com/agent-teams-ai/engineering-foundation/pull/421) [`059d557`](https://github.com/agent-teams-ai/engineering-foundation/commit/059d557b1c65e3515f392c719d72b058b049ba20) Thanks [@777genius](https://github.com/777genius)! - Introduce an independent development library that checks a frozen release-engine
  plan against the complete observed candidate. It validates exact version and
  intent effects, manifest content, source bindings and permitted file changes.
  Repository Hosts retain generation, content policy, authentication and
  publication; Changesets remains the version engine.

### Patch Changes

- [#446](https://github.com/agent-teams-ai/engineering-foundation/pull/446) [`69d5740`](https://github.com/agent-teams-ai/engineering-foundation/commit/69d57408a0ccc9297986f69797d53f872d857738) Thanks [@777genius](https://github.com/777genius)! - Record the bootstrap-only release history so ordinary Changesets versioning preserves the changelog title and existing entries.

## 0.0.0

Bootstrap-only artifact; do not adopt. Use a supported release instead.
