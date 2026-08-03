---
description: Explicitly merge a completed Harness pull request into stage or promote stage to production
---

Request exactly one explicit merge operation. Supported forms:

- `/merge stage`
- `/merge stage #<issue>`
- `/merge prod`

Merge is never automatic. Production is promoted only from `stage` to `main`.
