# Agent Architecture Standard D5 evidence manifest

Status: immutable disposable research evidence; not production code, a
conformance claim, or authorization to publish operation identifiers.

## Decision supported by this bundle

The preregistered numerical signal was positive: four representative scenarios
showed useful pre-overlay evidence, above the threshold of two. Independent
review nevertheless found that the prototype did not prove sufficiently narrow,
non-overlapping public classification and relation contracts. The accepted D5
boundary is therefore overlay-first: `validate-overlay@1` is the only initial
public operation. Classification and relation evaluation remain internal or
experimental behind replaceable ports. The prototype in this directory MUST
NOT be promoted into production.

## Source identities and chronology

- Foundation research source: repository
  `agent-teams-ai/engineering-foundation`, branch
  `docs/agent-architecture-standard-study`, source commit
  `75cc49466bb7eebef375b24a870f2a9feeb688cb`.
- Disposable research seed:
  `afe5a0013b60a1d0cb6620f433d641fda48eb86a`,
  `2026-08-26T19:53:15Z`, `chore: seed exact AAS research slice`.
- Initial preregistered spike:
  `f9251966c5a5004d26416170a9f45bbe47761860`,
  `2026-08-26T20:03:02Z`, `feat: add D5 operations spike evidence`.
- First independent review job:
  `aasv0-operations-spike-review-20260826-r1`, completed
  `2026-08-26T20:10:02.738Z`, verdict `REVISE`, P0=0, P1=4, P2=3.
- Remediation preregistration:
  `ede18414ffe6eb98aebf08e08bb1f4fd8d76efd4`,
  `2026-08-26T20:13:18Z`, `docs: preregister D5 spike remediation`.
- Remediated implementation:
  `01d724e6a051c999591be1597b0716d4046e56d2`,
  `2026-08-26T20:18:48Z`, `fix: bind D5 validation to exact plans`.
- Remediation evidence:
  `8edffd543912f9fa43838b3e0d2fd3bcbe72a322`,
  `2026-08-26T20:19:14Z`, `docs: record D5 remediation evidence`.
- Second independent review job:
  `aasv0-operations-spike-review2-20260826-r1`, completed
  `2026-08-26T20:27:34.364Z`, verdict `REVISE`; its final public-surface
  recommendation is overlay-first.
- Producer jobs:
  `aasv0-operations-spike-20260826-r3` and
  `aasv0-operations-spike-remediate-20260826-r1`.
- Transfer verification job:
  `aasv0-d5-evidence-publish-20260827-r3`; it independently verified that
  Foundation PR 201 was at
  `ca24a48f655a65a74b3882fa2e64930514fc69e7` and that reviewed commit
  `44a34de41af292a55ceed8946ae9ae272fe0dc90` was an ancestor. It made no
  remote mutation because hosted GitHub credentials were unavailable. The
  controller transferred the exact bytes over the configured hosted-worker
  channel.

The original preregistration has Git blob
`f8d1a150853de75a5844936c5c87590aac35e604` and SHA-256
`33067dbc191b9c97349472bb110c806795047b95735c94b8a5d7669a73f45849`.
The V2 preregistration has Git blob
`45dc3dc4963aab9bcc7c0a184aa75c0994e5b8ae` and SHA-256
`d1a6db2d7eb7e79faae431d0407e3d1f87dcb0c0cdd6a392909523764a19f92b`.
The initial evidence body at `f9251966c5a5004d26416170a9f45bbe47761860`
has SHA-256
`f06898450db8d0b6d9669e33154cb668932cfa5195e63a5e15daadc5e306ebf1`;
the checked-in `EVIDENCE.md` adds the remediation appendix and has the digest
listed below.

## Included bytes

All source paths below were read from `/home/aasv0-research-hub-20260826-r1`
on the hosted worker unless a review/run-result source is stated explicitly.

| Target path | SHA-256 |
| --- | --- |
| `spike/PREREGISTRATION.md` | `33067dbc191b9c97349472bb110c806795047b95735c94b8a5d7669a73f45849` |
| `spike/PREREGISTRATION-V2.md` | `d1a6db2d7eb7e79faae431d0407e3d1f87dcb0c0cdd6a392909523764a19f92b` |
| `spike/PREREGISTRATION-V2.evidence.json` | `c6d0fc73f30b240d84c6a196b7c9f9c4c60303ef099fe97dc378a103dc4f3726` |
| `spike/EVIDENCE.md` | `c463ca9b877f1218f0fa89b36038644f31e6a0c1a57922d411f11f23220868de` |
| `spike/README.md` | `1c5b524d7c268feab99a00f45edcd732fdfebe33ba4b4d68b29f18f2297ef409` |
| `spike/package.json` | `454a7334c43370a2a97a4410ef1f5760741320aa2e50787a01f41b359a1df4c4` |
| `spike/fixtures/scenarios.json` | `b7a5aa9caa9b4f3fae13c9b7e6b878e66eedd893b955433a0fa4770c83c139b6` |
| `spike/probe/adversarial-probe.js` | `abd7b2f60d0f4dfac75c1f24c9abd442a6fc1daf2d8cc60a2e623e8052f2f115` |
| `spike/src/measure.js` | `66d88da012b9ef2202e9638ac50a760e1145a26212a470dd5b17e77650b34005` |
| `spike/src/operations.js` | `53c28e105b33c8d7eaaa2b909c8a1b5ecdb985834af72665b63cc03507980ff8` |
| `spike/src/workflow.js` | `ad18ef13e59541d30c59dfbffa258a762d1f11d0276118550e3687398632bc3d` |
| `spike/test/spike.test.js` | `ac787b4bc9b531506487e226caa50305783dc3ff62169d7cad04debf51e2c9b2` |
| `reviews/aasv0-operations-spike-review-20260826-r1.latest-result.json` | `097c727d38cf8294b30b06379ce3dfd8b9e82d4307853ec0ac6c0cfcafd22cbe` |
| `reviews/aasv0-operations-spike-review2-20260826-r1.latest-result.json` | `93d43afe2895d4f5a91a4d9c4e9668f299365fcd2edb9b2732fd65ba19fe2834` |
| `run-results/aasv0-operations-spike-20260826-r3.latest-result.json` | `3c0887e418f3991e671f567b405a39eae6e1313090b916760154be86acfc4474` |
| `run-results/aasv0-operations-spike-remediate-20260826-r1.latest-result.json` | `6485fe0c51c059670448526235867c8a16f36482cfa303bef0cc4992fb9e3191` |

## Reproduction

From this directory:

```sh
cd spike
node --test --test-isolation=none test/spike.test.js
node probe/adversarial-probe.js
node src/measure.js
```

To verify immutable input bytes:

```sh
shasum -a 256 spike/PREREGISTRATION.md spike/PREREGISTRATION-V2.md
find spike reviews run-results -type f -print0 | sort -z | xargs -0 shasum -a 256
```

The tests and probes reproduce prototype behavior only. The independent review
reports are authoritative for the bounded product-surface conclusion recorded
here; passing prototype tests do not override their findings.
