# Independent archive content review

**CODE_GO** for the exact replacement bootstrap content pin only. No actionable finding.

- Source head: `f45eb951acad644c6bc7cb4cac01a04d325133d8`, base `059d557b1c65e3515f392c719d72b058b049ba20`.
- Package tree: `d9d922a360ba81eebcbecb50fa4baeddf9faa9bf`.
- Archive SRI: `sha512-N3Sfwq4C8TUdSHMJfzB1TjTOPo3I6/xlcPzSJJuHAKQKpFJ0z3XK4ywfwjV7duEjEkAKGKTaqKLgoCYRcEJ35g==`.
- Archive SHA-256: `d26d094111315e41fb8175f6389689fcee9da21b0d7a1857d584731af7059d32`.

Both actual archives were inspected in memory without execution or extraction. The new archive has 44 regular mode-0644 files, safe unique contained names, exactly two terminal zero tar blocks, and no links, special files or hidden trailing payload. Four new files are the private conformance-input helper and its declarations/maps. Nothing was removed. Packed manifests are byte-identical, including the closed public exports, exact development compiler pin and absence of runtime/peer/optional dependencies. All nine existing declarations differ only in string quote style.

Static JavaScript AST comparison found all eight non-conformance modules equivalent. Reassembling the private helper declarations with the conformance body reproduces the old 20-statement AST exactly. All 12 case IDs, bodies, expected outcomes, diagnostics, package changes and freezing remain intact. Package README/CHANGELOG/root LICENSE match their bound source; map references stay within existing source. Strict project and existing conformance/testing ownership include the helper. No accepted ADR or API baseline bytes changed.

The retained provider metadata binds run `40029541925`, attempt `1`, artifact `12534816890`, and writer merge `aa401f68fe23c412ba32d4bd057afc845a4a8cdf` with parents `059d557b1c65e3515f392c719d72b058b049ba20` and `5bd94850879b40f4cd2f0fef4949ecd40337c36b`. Its full tree equals the locally available 5bd tree; the writer and current f45 package trees match. The original approved archive independently matches the retained Lvt9 SRI and base package tree `76a214bd459937b28786880b4deb08cb20916da7`.

The writer's rejection of the old approval is correct. Root may update the existing catalog's exact tree/SRI to this reviewed pair. This review does not mark that failed writer or the incomplete run successful, and does not authorize provider effects. Root still owns final-head/current-base CI and approved-writer reproduction. No tests, builds, installs or network requests were run. See the JSON for full hashes, payload rosters and evidence limits.
