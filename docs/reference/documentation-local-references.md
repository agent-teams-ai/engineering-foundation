# Local Markdown references

`documentation.local-references` checks all Markdown files beneath the explicit
consumer-owned `markdownRoots`. It retains the CommonMark/GFM parser, directory
README resolution, selected anchor profile, containment and symbolic-link
checks. It does not fetch external URLs or resolve absolute local targets.

## Version 1

The published `documentation-local-references/v1` schema and its ordinary
reference behavior remain unchanged. Its only properties are `schemaVersion`,
`markdownRoots` and `anchorProfile`. Absolute local references remain errors.

## Version 2: exact historical artifacts

The additive `documentation-local-references/v2` contract is implemented in the
current source. Installing a package that publishes this schema and adopting it
in a consumer are explicit, separate steps.

Version 2 retains every v1 field and requires `historicalArtifacts`: one to 100
explicit records. Each record has these fields:

| Field | Contract |
| --- | --- |
| `path` | Exact, case-sensitive repository-relative Markdown path beneath a configured root; no globs, aliases, traversal or exclusions; at most 300 characters. |
| `sha256` | Exactly 64 lowercase hexadecimal digits identifying the raw file bytes. |
| `references` | One to 1,000 exact absolute-reference occurrences. Each has `kind` (`link`, `image` or `definition`), one-based `line` and `column`, and the existing Markdown observation's `rawTarget`. |

Duplicate paths or occurrence identities reject. A line is at most 50,000,
a column at most 4,194,304 and a target at most 16,384 characters, within the
existing bounded observation and configuration readers.

The consumer owns the decision that an artifact is historical, its provenance
and any independent immutable-evidence gate. Foundation does not infer that
classification from a directory name, document date, frontmatter or a failed
link. No declaration is generated or refreshed automatically.

### All-or-nothing admission

Foundation still observes the complete configured roots and resolves every
reference under the existing rules. It admits a declared artifact only when:

1. A regular, readable Markdown file was actually observed at that exact path.
2. Its raw-byte SHA-256 matches the declaration.
3. The declared occurrence set equals the complete observed set classified by
   the existing resolver as `unsafe` / `absolute-path`.

The digest uses the same observation as reference parsing. The Markdown reader
rejects malformed UTF-8, retains BOM and line endings, and returns the original
source unchanged; UTF-8 encoding therefore preserves the observed raw bytes.
The checker does not reread a different file to authorize that observation.
This is evidence about observed bytes, not a repository lock or an authenticity
signature.

Changed bytes, a missing file, a case alias, a symbolic link, a stale declaration,
or a newly undeclared absolute occurrence produces
`documentation.local-references.historical-artifact-invalid`. Every ordinary
absolute-reference error for that artifact remains visible. A declaration
outside the configured roots is invalid configuration even if no matching
reference was observed.

Only a fully admitted artifact produces
`documentation.local-references.historical-absolute-reference` information
diagnostics. Every occurrence keeps its source location, target, original rule
and reason, and artifact hash. Its absolute target is never read and is not
claimed to exist.

### Results and remaining checks

A check containing only these admitted historical diagnostics passes with a
nonzero information count. The real CLI JSON report retains those diagnostics
and its summary. Any ordinary diagnostic still produces a violation, including
missing relative files, missing anchors, repository escapes and invalid
encoding inside an otherwise admitted artifact. Other files and roots receive
the same complete checks.

There is no file exclusion, generic waiver, findings baseline, inline suppression,
promotion command or automatic hash update. Consumers must review changed
declarations and retain their own immutable release evidence.
