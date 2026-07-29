# Release Procedure

The first public `@agent-teams/engineering-foundation` release is bootstrapped
manually with npm 2FA after `pnpm check` passes. After that release:

1. configure this repository and release workflow as the package's npm trusted
   publisher;
2. enable GitHub OIDC publishing and automatic provenance;
3. revoke any temporary automation write token;
4. require the release PR and complete CI before publication.

Changesets maintains versions and release notes. The release workflow publishes
only from protected `main`.

Before every publication:

- build from a clean checkout;
- run lint, typecheck, tests, publint, and Are The Types Wrong;
- pack the real tarball;
- install it into an isolated consumer;
- verify public exports, CLI startup, and package self-check;
- verify that local tarball overrides are rejected as registry provenance;
- verify development-only dependency placement;
- reject unexpected or sensitive package contents.

The test suite also exercises the production operation lock across real child
processes, including live-owner rejection and stale-lock recovery after the
owner is killed. Mutation-boundary recovery remains covered by deterministic
state fixtures. Windows does not claim POSIX-equivalent hard power-loss
durability because Node cannot portably fsync directories there.
