---
"@agent-teams/engineering-foundation": patch
---

Give the git calls that read repository identity in `package.public-api-compatibility`
a 60 second deadline instead of 10 seconds. A cold Windows runner could exceed ten
seconds and fail with `UNEXPECTED_PROCESS_FAILURE`.
