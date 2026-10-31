# Rich Callouts: first generation attempt

Qwen3.8-27B-Q8_0 used the new schema and standard-command helpers, but its
extracted DOM mount function had an untyped `update` parameter. Its attempted
repair imported `Block` and `Immutable` from `@nooq/plugins/dom`. Those types
already existed at `@nooq/plugins`; this was an import error, not a missing API.

The candidate reported an API gap and stopped. The original source, revisions,
API context, report, and terminal output are retained here without edits. It
never passed the type gate, so runtime/browser checks did not run.

The subsequent run received explicit entry-point guidance and the example
`function mount(ctx: BlockViewContext): BlockView`, which supplies contextual
typing for `update(block)`. No API was invented to satisfy the erroneous report.
This trial remains excluded from repository compilation and Storybook.
