# Unsuccessful local-model trials

These are evidence, not supported examples. They are excluded from repository
typechecking and the host Storybook. The harness still typechecks every candidate
it validates.

`callouts-thinking-enabled` is the initial complete-plugin attempt. Pi's provider
configuration omitted the reasoning capability and chat-template format required
to send `enable_thinking: false`. One response used its entire 8,192-token output
limit on reasoning and wrote no source. The attempt was cancelled after about
293 seconds; its report also records a concurrent SDK fingerprint change. The
original report, scaffold and revision history are preserved. A request-level
regression test now verifies the setting actually sent by Pi.

`callouts-checkout-moved` was interrupted when another process moved all three
plugin packages out of the shared checkout. Its partial sources, revisions and
run log are retained; it has no completed validation report. Subsequent work
used an isolated checkout. The attempt also exposed a missing transitive type
in the supplied API context: `TextChange` is now included, with a generic
insertion example. Storybook guidance now demonstrates editing, explicit focus
and textarea-value assertions.
