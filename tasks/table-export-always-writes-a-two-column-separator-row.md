---
status: open
created: 2026-11-04
---

# Table export always writes a two-column separator row

Found the same way (2026-11-04). tableFormatter in packages/plugin-tables/src/export.ts writes | --- | --- | after the first row whatever the column count. GitHub-flavored Markdown needs one separator cell per column, so a three-column table such as the audit's ranked gaps stops being a table: exported Markdown shows it as plain pipe lines, and HTML renders only the two-column table. tablesFormatters also isn't in plugin-tables' package exports, so gooi imports src/export.ts directly.
