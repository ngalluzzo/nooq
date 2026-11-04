---
status: open
created: 2026-11-04
---

# Markdown import keeps each wrapped line as its own paragraph

Found importing docs/gap-audit.md through gooi's nooq documents (2026-11-04). In Markdown, lines that wrap without a blank line between them are one paragraph, but importMarkdown (packages/plugins/src/import.ts) makes a block per line. The audit's "Status." paragraph, wrapped over three lines, came in as three blocks, so exporting puts blank lines between them and the document's structure differs from the file.
