# Security Policy

Report vulnerabilities privately through GitHub Security Advisories for
`agent-teams-ai/engineering-foundation`.

Do not include credentials, access tokens, private repository contents, or
unredacted user data in an issue.

Release invariants:

- public packages are built only from protected `main`;
- GitHub Actions dependencies are pinned to commit SHAs;
- npm publishing uses trusted publishing with OIDC after bootstrap;
- package contents pass an isolated tarball inspection before publication;
- no long-lived npm write token is stored after trusted publishing is enabled.
