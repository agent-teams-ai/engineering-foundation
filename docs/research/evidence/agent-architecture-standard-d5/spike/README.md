# D5 operations spike

This directory is a disposable research prototype, not an AAS implementation or
consumer. It uses only Node built-ins and never reads, writes, or executes a
target repository.

Run from this directory with Node 24 or another current Node release:

```sh
node --test
node src/measure.js
```

`PREREGISTRATION.md` fixes the original decision rule.
`PREREGISTRATION-V2.md` fixes the post-review adversarial gate before the
remediation implementation. `fixtures/scenarios.json` holds the adversarial and
clean-control matrix. `EVIDENCE.md` keeps the original evidence and records the
clearly separated remediation result and its limitations.
