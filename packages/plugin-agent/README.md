# nooq plugin agent

A bounded Pi SDK runner that uses a local model to generate a developer-bundled
nooq block plugin, its DOM view, and its Storybook interaction tests. Pi is
pinned to **0.85.1**. Generated plugins are ordinary TypeScript packages, never
Pi extensions. The current recipe is one inline-text block, an insertion
command, target-field commands, one view, and a set of CSF3 stories.

## Generate and inspect

For the additive v2 authoring slice, use `briefs/callout-rich.json`. It requests
declarative fields/standard commands, host-owned rich text, and a RichFormatting
story. `briefs/callout-complete.json` retains the legacy textarea recipe. See
[proposal 0004](../../proposals/0004-plugin-authoring-v2.md) for the scope and
remaining milestones.

From the repository root:

```sh
bun install
bun run plugin-agent run packages/plugin-agent/briefs/callout-complete.json \
  --model Qwen3.8-27B-Q8_0 --out /absolute/path/to/new-run
bun run plugin-agent preview /absolute/path/to/new-run
bun run plugin-agent check packages/plugin-agent/briefs/callout-complete.json \
  /absolute/path/to/new-run
```

`preview` prints a loopback URL. Its playground runs the actual generated view
beside a peer without that plugin. Text edits, field actions, slash insertion,
and peer changes operate on real editors. Each preview is a disposable document;
there is no connection to application documents or model credentials.

The default model endpoint is `http://127.0.0.1:8000/v1`. Credentials come from
`OMLX_API_KEY`, or `auth.api_key` in `~/.omlx/settings.json`; `--omlx-settings`
selects another settings file. Credentials stay in controller memory. Only
loopback HTTP endpoints are accepted. Select a model explicitly when the server
lists multiple models; draft checkpoints may not serve independently.

Runs default to a new OS temporary directory. `--out` must name a new directory
and never overwrites one. Validation requires macOS `sandbox-exec` and Playwright
Chromium (`cd packages/plugin-agent && bunx playwright install chromium`).
Model inference is never part of the test suite.

## What the model owns

Only three files are editable:

- `src/index.ts`: inert block/command/plugin definitions, default plugin export;
- `src/dom.ts`: a default `defineDOMPlugin` export with a view and insertion menu;
- `src/plugin.stories.ts`: standard Storybook CSF3 metadata and named stories.

The harness owns the brief, acceptance cases, manifests, dependencies, test
runners, preview host, and reports. It exposes `read_api(section)`, `read_file`,
`write_file`, `check_plugin(stage)`, and `report_api_gap`. API sections cover the
headless contract, declarative recipes, DOM lifecycle, and Storybook authoring
separately. Rich-text briefs use `mountRichText`; their independent browser checks
reject a textarea substitute and exercise real formatting and Unicode marks.

A brief declares initial fields/text, diagnostic expectations, command cases,
an insertion command, accessible view labels, a displayed field, and required
story exports. `clearBlock` on insertion consumes exactly `/` in the same
transaction; if the text changed, the command must decline. Missing, deleted,
wrong-type, and invalid-field targets must decline field commands.

## Storybook guidance and execution

The agent is explicitly guided to use `Meta`/`StoryObj` from
`@storybook/html-vite`, awaited `expect` calls from `storybook/test`, and
role/label queries scoped to `canvas`. Interactions use `userEvent` and assert
the resulting behavior. A test that merely renders a component is insufficient.
Use `mountPluginStory` from `@nooq/plugin-agent/storybook` for an isolated editor
and return `disposePluginStories` from `beforeEach` as cleanup.

Rich contenteditable values use `toHaveTextContent`; textarea values use
`toHaveValue`. RichFormatting selects text and invokes the host formatting
shortcut, then asserts the rendered mark. The protected browser suite separately
checks formatting over an emoji and retention of an unknown mark.

The Callouts recipe requires Default, Warning, Success, InvalidTone,
KeyboardCycle, and NestedContent. They cover editing, visible state, a
non-destructive invalid-data path, native-button keyboard activation, and child
preservation. Button text must be part of its accessible name; display the
changing tone separately from the action label.

The scaffold demonstrates `userEvent.clear/type` and `toHaveValue`. The guide
also explains explicit keyboard focus and querying nested textareas by role and
value. The protected Default-story check requires an actual input event, so a
render-only replacement cannot satisfy that story's editing requirement.

The protected browser harness composes stories with the pinned Storybook HTML
renderer and runs their full `.run()` lifecycle, including `play`, in Chromium.
It supplies Storybook's `within` and `userEvent` context, runs light and dark
variants, and performs an independent axe scan after each story. Generated code
cannot turn that scan off through story parameters. Named stories must include
play functions. These tests remain separate from the independent plugin checks.

Reviewed story files can also be added explicitly to a host's normal Storybook
`stories` glob. Keep failed runs out of that glob. The artifacts use workspace
dependencies; they are intended for this repository, not standalone npm release.

References: [interaction tests](https://storybook.js.org/docs/writing-tests/interaction-testing)
and [portable stories](https://storybook.js.org/docs/api/portable-stories/portable-stories-jest).

## Independent checks

The report separates five gates, each `passed`, `failed`, or `not-run`:

| Gate | Evidence |
| --- | --- |
| Types | All three files compile; per-file import/global policy holds |
| Headless | Defaults, diagnostics, invalid arguments, preservation, core/Yjs equivalence and convergence |
| Runtime | Real Editor dispatch, insertion argument/parent validation, atomic insertion, preview purity, provenance, per-editor isolation, disposal, reader/missing-genesis denial and signed admission |
| Browser | Real view, native keyboard activation, text/caret preservation, composition-event rebasing, missing-plugin peer, root/nested insertion and selection, cleanup and error/network checks |
| Storybook | Required play functions execute and axe passes in both themes |

`check --stage types` and `check --stage runtime` are faster repair steps.
Their reports have `complete: false`. Only the full suite can complete a run.
The controller rechecks the final bytes independently of the model's claims.
Regression tests prove that broken generated story assertions fail even when
all independent plugin checks pass.

The headless/runtime bundle executes in a separate macOS sandbox with a clean
environment, no network or subprocess spawning, and only its bundle, scratch
space, and necessary OS/runtime files available. Candidate source is bundled,
never imported by the controller. Browser code runs in a fresh Chromium context
inside an opaque-origin sandboxed frame. CSP and request interception restrict
browser traffic to the in-memory preview document. The saved preview retains
its frame sandbox and CSP; it does not run a server or model itself.

These boundaries contain execution but do not prove an adversarial candidate
cannot tamper with checks in the same JavaScript realm. Human source review
remains a gate. No run automatically installs, merges, or publishes code.

## Bounds and evidence

Defaults are three rounds, 240 seconds per model round, 32 tool calls, 12 file
revisions, six model-requested validations, 20 seconds per runtime sandbox, and
90 seconds per browser suite. Each model request declares 32K context and an
8K output limit. Thinking is requested off; actual usage is recorded because
servers may ignore the request. Automatic SDK retries and compaction are off.
Pi loads no user/project extensions, skills, prompts, or agent context.

Every run preserves the brief, API sections, source revisions, three source
files, manifest, README, report JSON/HTML, and (when browser validation ran) a
working `preview.html` plus screenshot. Reports contain per-file/package hashes,
SDK/oracle fingerprint, model identity, usage, elapsed time, checks, and remaining
gates. The fingerprint includes implementation and validation files, not only
prompt excerpts; a changing contract invalidates the run.

Native IME beyond simulated composition events, browser latency budgets,
format exports, and broader plugin archetypes remain separate work. A complete
report means this recipe passed its stated gates, not that every seed release
requirement is complete. Async jobs, dependency composition, media, tables, and
layout are not yet generated. There is no queue or parallel inference yet.

## Complete Callouts trial

The original textarea trial below is historical. The additive rich-text trial is
recorded separately in [callouts-rich](examples/callouts-rich/README.md).

The [complete Callouts package](examples/callouts-complete/README.md) was generated
by oMLX's **Qwen3.8-27B-Q8_0** against the pinned API on 2026-10-31. Its
[original report](examples/callouts-complete/report.json) records **138.8 seconds**,
one model round, eight file revisions and 20 tool calls. All five gates passed:
20 headless checks, nine runtime checks, nine browser checks, and six Storybook
stories run in both themes (12 play/a11y executions). Model usage reported zero
reasoning tokens after the provider-setting fix. No generated source was edited
by the host to obtain that result.

The reviewed CSF file is explicitly included in `packages/design/.storybook/main.ts`.
The normal host suite passes **116 stories across both themes**, including these
12 new executions. Run the interactive playground with:

```sh
bun run plugin-agent preview packages/plugin-agent/examples/callouts-complete
```

Earlier unsuccessful attempts are preserved under [trials](examples/trials/README.md).
This is one completed recipe trial, not a throughput or general acceptance-rate
benchmark. Human review, native IME, performance and export gates still apply.

At that integration checkpoint, host verification passed typechecking and **476
unit/integration tests (7 skipped)**, and the generated source and SDK/oracle hashes
matched the original report. The work was integrated into the primary checkout,
preserving the ProseMirror changes and trust-test timeouts. Frozen dependency
installation, the full suite, host Storybook, and independent checks were rerun.
See the
[host verification record](examples/callouts-complete/host-checks.json).

## Rich Callouts trial

The [rich-text package](examples/callouts-rich/README.md) was generated by the same
local model using schema and standard-command helpers. Its successful run took
134.5 seconds, two model rounds, seven revisions, and 20 tool calls. All five
gates passed, including seven CSF stories in both themes. The generated headless
source is 682 bytes versus 4,018 in the earlier example; this is a source-size
comparison for one recipe, not a general throughput benchmark.

The earlier [import-gap attempt](examples/trials/callouts-rich-import-gap/REVIEW.md)
is retained. The successful generated source was integrated without edits. A
later host-check fixture replaces platform-dependent Home/arrow selection setup
with explicit DOM ranges; the source hash is unchanged, and the new oracle
fingerprint is recorded separately in
[host-checks.json](examples/callouts-rich/host-checks.json). Its browser suite
passed three consecutive runs. Host Storybook passes 130 tests across both
themes, and its static build passes. Repository checks passed typechecking and
490 tests (7 opt-in performance tests skipped).

```sh
bun run plugin-agent preview packages/plugin-agent/examples/callouts-rich
```

## Legacy pilot

The original [callout source](examples/callout.ts) and
[report](examples/callout.report.json) remain unchanged. That one-file trial used
Qwen3.8-27B-Q8_0, took 62 seconds, and passed 20 headless checks. Its static preview
is not the new interactive artifact and its timing is not a v2 throughput claim.
Legacy sources remain checkable:

```sh
bun run plugin-agent check packages/plugin-agent/briefs/callout.json \
  packages/plugin-agent/examples/callout.ts
bun test --timeout 90000 packages/plugin-agent/test
```
