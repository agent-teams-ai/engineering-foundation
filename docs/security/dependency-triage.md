# Development dependency advisory triage

Reviewed: 2026-10-20. Scope: the repository's Bun and Node/pnpm development
profiles, after the Nx 23.3.0 and Verdaccio 6.10.6 refresh. This record does not
change Dependency Review policy, dismiss alerts, or declare arbitrary upstream
uses safe. See the [repository security baseline](repository-security-baseline.md).

## Patched parser selection

Nx 23.3.0 requires `smol-toml@1.9.0`; Knip 6.31.0 accepts `^1.7.1` but the
preserved Bun lock retained 1.7.1 after targeted package-manager refreshes.
The global `smol-toml: 1.9.0` override selects the compatible patched parser
in both profiles. It addresses
[GHSA-r4xh-jqrq-34v2](https://github.com/advisories/GHSA-r4xh-jqrq-34v2),
whose affected range includes versions through 1.8.0. Reassess this override
when both parent tools naturally resolve a patched parser; do not remove it
until both frozen installations and the installed-graph gate confirm that
no affected copy returns.

## Patched Nx HTTP client

Nx 23.3.0 removes Axios but pins `undici@7.29.0`. Review of every newly
introduced package coordinate found ten current advisories for that client,
including the
[BalancedPool TLS validation bypass](https://github.com/advisories/GHSA-w293-vg96-wgc3)
and [WebSocket denial of service](https://github.com/advisories/GHSA-rfgv-xxqx-mfg5).
Their corrected 7.x version is 7.29.1. The global `undici: 7.29.1` override
selects that patch in both development profiles; it does not change the
published packages' runtime dependencies.

Reassess this pin with every Nx update. Remove it only when the ordinary Nx
dependency graph resolves a patched client in both locks, the installed
graphs confirm the selection, and the existing native/tool qualification
passes. A new upstream client major requires separate compatibility review.

## Retained formatter dependency

[GHSA-hp3w-g68c-fv3c](https://github.com/advisories/GHSA-hp3w-g68c-fv3c)
still lists `sprintf-js <=1.1.3` without a patched version. However, the
[CVE Program record](https://cveawg.mitre.org/api/cve/CVE-2026-97058) marks
CVE-2026-97058 **REJECTED**, dated 2026-10-12. These upstream records disagree;
the retained package is not being described as patched.

The development dependency path is Changesets 2.31.1 →
`@manypkg/get-packages@1.1.3` → `read-yaml-file@1.1.0` → `js-yaml@3.15.2` →
`argparse@1.0.10` → `sprintf-js@1.0.3`. The inspected workspace-reading path
calls the YAML library's `safeLoad`; the argparse/formatter imports belong
to js-yaml's separate CLI entry point. A focused parsing pilot confirmed
that neither argparse nor sprintf-js was loaded. No Foundation caller
supplying an untrusted sprintf format string was identified.

Changesets 3 removes this old dependency chain, but also changes prerelease
state and command behavior, described in the
[upstream CLI changelog](https://github.com/changesets/changesets/blob/main/packages/cli/CHANGELOG.md),
that the existing release-state validators rely
on. That migration needs its own release qualification. Reassess this record
if the CVE/advisory status, Changesets integration, YAML entry point, or
format-string inputs change.

## Retained inactive response-cache dependency

[GHSA-ch52-4w7c-c8xp](https://github.com/advisories/GHSA-ch52-4w7c-c8xp)
lists `http-cache-semantics <=4.2.0` without a patched version;
CVE-2026-93748 remains published. The
[upstream maintainer disputes](https://github.com/kornelski/http-cache-semantics/issues/56#issuecomment-5975759591) the
advisory's Set-Cookie interpretation, while a narrower max-stale/directive
question remains. This record does not classify the whole report as false.

The only dependency path is Verdaccio 6.10.6 → `@verdaccio/hooks@8.1.7` →
Got 15.1.0 → `cacheable-request@13.0.19` → `http-cache-semantics@4.2.0`.
Two inspected conditions bound Foundation's use:

- The registry configuration in `scripts/registry-install-e2e.mjs` has no
  notifications. Verdaccio hooks returns before loading its request client
  when notification configuration is absent.
- Even the inspected notification request does not supply Got's `cache`
  option. Got defaults this option to undefined and enables CacheableRequest
  only for a configured cache.

The registry also binds an ephemeral loopback port, disables its web UI, and
uses no uplinks. The absent notification/cache path is the direct evidence
for this scoped assessment.

The published 4.3.0 source was compared with 4.2.0 after checking both npm
archive integrity values. It adds status access and changes Vary matching;
the max-stale branch is unchanged. A fresh minimal resolution selects 4.3.0
within the parent's `^4.2.0` range, but bounded refreshes of the preserved
Bun graph retained 4.2.0. A permanent override or broad graph refresh solely
to cross the advisory's version range would not establish a fix. Retain
4.2.0 with this limitation until an ordinary reviewed parent/lock update or
an upstream correction provides a reason to change it.

Reassess before enabling notifications, response caching, shared registry
topology, or a new cache caller, and whenever upstream changes the advisory
or relevant implementation.
