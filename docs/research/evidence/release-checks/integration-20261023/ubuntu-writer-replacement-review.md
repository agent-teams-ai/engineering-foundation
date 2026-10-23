# Independent Ubuntu writer archive review

Verdict: GO. I approve the current archive as the replacement reviewed content
target for package tree `76a214bd459937b28786880b4deb08cb20916da7` and SRI
`sha512-Lvt9twVB0UhsmgYkoGrtbntxWCM9PxQ/NzvZB2ZE+xSj1jFyEFXvaLK94390rrABwjGoYPS8uO+1XzVXq4Lm8A==`.
Archive SHA-256 is `c66535759e839c1233daccd2e9bb657cfc24231b16834af6bdadbc5cd78c6d45`.
No product-source fix is required for this byte change. Catalog approval remains
unmodified by this reviewer.

Reviewer role: independent release archive reviewer. Reviewed source head is
`1aed30220e0dfa778f89ad979bafb5b3a8581566`, base
`17520f7d84d364f5bb40195785c2b7a9269663a0`. The actual writer processed PR merge
`55b9d1ee2dab5f9dbd241c39dcc416e6b974ded7`; GitHub's commit API confirms its
complete tree `5fb5f1e6416499e1bfb332bf01d3d01f54aa13ae` equals that reviewed
head's complete tree.

| Evidence | Original approved | Current writer |
| --- | --- | --- |
| Run / attempt | 39664614732 / 2 | 40010522856 / 1 |
| Job | 119463834854, `linux-bootstrap-evidence`, success | 120610925843, `linux-package`, failure at prior-SRI comparison |
| Artifact | 12376897004 | 12527205945 |
| ZIP SHA-256 | `1b6a645765e76fe85351b2dd25499df34cccaad9fca43414fdefa3b6df83a683` | `c502c05216bc3b3069525335f3e92cade98260a8d118ed5b93df7a43fbec2d69` |
| Processed source | `805d652c3b61dc69a02b2df2b852f1b26841be24` | `55b9d1ee2dab5f9dbd241c39dcc416e6b974ded7` |

Fresh `gh` metadata independently confirms both artifact digests, job attempts,
runner labels, source heads and status. Both exact-job logs show Ubuntu 24.04.5
LTS, image `ubuntu-24.04` revision `20261012.334.1`, Node 26.11.1 linux-x64,
npm 11.20.0, pnpm 11.20.0 and TypeScript 7.0.2. Current Node 24.21.0 setup is
the separate retained managed-consumer port, not the writer build runtime.
Raw executable hashes are not present in these receipts; no independent binary
download or workstation rebuild is claimed.

Both receipts' canonical digests and compressed archive SHA-256/SHA-512 values
were independently recomputed. Both archives contain exactly 40 distinct regular
files with safe `package/` paths, identical ordering and metadata, mode 0644,
UID/GID 0 and fixed timestamp 499162500. No links, traversal, duplicate portable
identities, PAX headers or out-of-policy members occur. Every retained listing,
verbose listing and normalized manifest sidecar matches its actual archive.

All 39 nonmanifest payloads are byte-identical. The only changed member is
`package/package.json`: `scripts` moves from after `version` into sorted position
before `sideEffects`. Parsed manifests are equal. The raw tar bytes outside that
member's payload are also identical. README, CHANGELOG and LICENSE match committed
source; the current manifest exactly matches committed source with its catalog
TypeScript pin resolved to 7.0.2. Package tree and its complete package-local
compiler configuration are unchanged.

The source explains this exact serialization difference. At the old input,
`scripts/pack-artifact-e2e.mjs` disabled pnpmfile loading for clean-stage packing.
Current lines 262-271 explicitly copy and enable the repository's canonical
`.pnpmfile.cjs` hook. That hook sorts top-level manifest keys after pnpm's
projection, including `scripts`. No compiler-version change, package source
change or unknown toolchain cause is needed to explain the delta.

Current job logs bind the replacement SRI and SHA-256 to its successful
`pack-test.mjs` result. The existing owner produced two independent fresh builds,
checked identical archives, and passed the installed public API/type probe plus
all 12 release-checks conformance cases before the later approval comparison.
The direct Ubuntu writer produced those same archive bytes. The approval gate
then correctly rejected the old approved SRI; that failed result is retained.

Full current CI is not passed. Record the newly reviewed SRI on PR421, retain
both old and new evidence, then require final-head/current-base complete CI and
successful approved-writer reproduction. Bootstrap readiness, protected-main CI,
publication and external adoption remain separate gates. This review ran no
local build/install/heavy tests and executed no archive code.

The complete 40-member comparison, source-input hashes and live metadata are in
`independent-writer-archive-review.json`; exact-job excerpts are in
`writer-approved-review-log.txt` and `writer-current-review-log.txt`; the sole
payload diff is retained as `writer-manifest-byte-delta.diff`.
