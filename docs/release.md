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
- verify public exports and CLI startup;
- reject unexpected or sensitive package contents.
