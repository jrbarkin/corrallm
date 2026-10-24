# Engine

[Architecture index](overview.md) · [Canonical instructions](../../AGENTS.md)

## `src/shared/engine/`

One canvas's engine, run wherever it is hosted: in the renderer (GraphEditor), its sessions in main over IPC; in the core (core/engines.ts), its sessions in the same process. engine.ts is Engine: the run and the sessions it sends to, wired to each other, following the canvas's nodes (update) and saved and restored together (checkpoint, restore).

Whoever hosts it gives it its sessions' backend (transcript/receive.ts SessionBackend), its timers, its clock, the usage readings, the locale it tells times of day in, and the EngineCatalog (catalog.ts, made from the catalog: an agent's adapter and connection, the default adapter, its actions, the usage it spends, the modes a connection starts in and those that never ask, whether its view is a Terminal, how a connection and a usage backend are named); it reads no table of its own, nor any catalog but that one, and never the renderer (ESLint's app/boundaries-shared). delivery/mailbox.ts is SessionStore, every agent's session and what is queued for it (submission-state.ts saves its manual messages' records); transcript/ drives each session (driver.ts: receive.ts's ConnectedDriver plays native session events from main onto it, reduce.ts reduces them; unavailable.ts refuses unsupported connectors without a reply; history.ts merges a resumed session's history into the transcript: what it lacks goes where it happened, a turn a Terminal session showed in short is filled in). run/ runs the queues (runner.ts, RunStore, a store like SessionStore): each agent works through its queue, read from the model's nodes (RunStore.update, heldAsks), never React Flow's.

A message goes to its native session, or, aimed at another agent, to that one's, and is done when that turn ends (failed if it failed or was interrupted).

A connected agent's steps go to its session too (run/turns.ts words them: a slash command as it is, a tool as a short instruction to use it; with what the step is to do in the user's words, QueueStep.instruction, edited in the step's row: a command's arguments, or after the tool, then a paragraph asking for SUCCEEDED or FAILED on the reply's last line), judged only by an exact final SUCCEEDED or FAILED line.

Missing verdicts are uncertain; native execution errors take precedence over a declared verdict.

Messages and slash commands use native turn completion.

Unhandled failure, cancellation and uncertainty hold the original task for the user; authored If failed/repeat recovery handles only a task's own failure (its FAILED, or a step expected to fail that passed), never a native one.

A step expected to fail (QueueStep.expect, set from a tool's action in its row, then shown as an "expect: fails" chip under the step; in .corral files) asks the agent the same, and is turned round once judged: failing is its success, passing its failure, so Ifs, repeats and waits read whether it went as expected (AgentRun.asExpected, on its row: "failed, as expected" or "passed, but was expected to fail"); a tool's native execution failure is not an expected task failure; a missing verdict stays uncertain.

A connected agent's conditions are real (never chance): "the output contains" is matched, exactly, against what it replied in the checked task's turn (RunIO.send's `done`: SessionStore's turnReply, its top-level text; for a Terminal agent, the Stop hook's last reply).

With `wholeLine: true`, the text must occupy its own line (surrounding whitespace allowed); Review loop uses this so NOT APPROVED does not end it.

A condition in the user's words is asked of it in its own session, yes or no ("corrallm asks: …"; an unclear or failed answer holds Needs you for retry or a human yes/no); Where corrallm can't hear an agent's replies (its session said `unheard`: its CLI's settings turn off the hooks a Terminal session listens to; RunIO.unheard), tool verdicts and output/own-words conditions stay uncertain, and the run says why once per run.

Stop pauses with a cancelled attempt; Resume holds it for a decision and Run again explicitly starts fresh.

A send's take-back, Kill and the composer's Stop all use the connection's interrupt behavior, including stopping commands started by the interrupted turn where its connection supports it.

Stop (and Run again) takes back what the run sent that is still going (RunIO.send returns it: SessionStore.send's take-back, off the session's queue or interrupting its turn), and no longer hears those turns end.

Waits hold until their target is done or their time limit passes, delays until their time comes, OKs until the user decides (RunStore.decide: approve, ask for changes, which go to the agent's session, as a message like any other with the images pasted into it, before it asks again, or stop, which stops whatever waits on it; while it asks, a slash command typed in a connected agent's composer runs as a command instead, as its ask bar says).

A repeat runs in rounds (AgentRun.rounds), its condition decided once per round of the round's last task that ran; out of rounds it fails and goes on, or asks (decide: one more round, what to try next, or go on).

A wait in a repeat for a step in another repeat waits for that round of it (#resultOf); one outside waits for the repeat to end.

A repeat that follows another holds at the end of each round until its leader goes round, and ends with it (#follow).

Delays and limits are the run's own, on the real clock (RunIO.now, one alarm re-checked at least once a minute); Go on now (RunStore.goOn) ends a hold early.

A task whose session would not start (an Agent SDK agent on a Claude subscription: its message stays in that session's queue, RunIO.send's `refused`) neither fails nor goes on: its agent asks the user (AgentRun.refused: the session's words, and Switch to Terminal, which RunIO.connect does), and works again once that agent runs another way (`update`), its session sending what it kept. run/asks.ts derives what each hold for the user asks (never stored), shown on its row, All queues' lane head, the Needs you sidebar and above the agent's composer (for a Terminal agent, in the bar under its terminal, with a box of its own for the reply); needs.ts derives everything that waits for the user once (`needsOf`: those holds, every session's open prompts, what Terminal CLIs ask, and the agents whose sessions won't start while messages wait for them, from delivery), for the sidebar and, worded as NeedsItems in the host's locale (`needs`), the core; run/controls.ts says where an agent's or group's own Pause, Kill and Resume leave it.

A run that has done nothing has nothing to resume: pausing or stopping it leaves it as it was.

## Read-only runtime views (B11 preparation)

`src/shared/model/run.ts` holds the run's data types; RunStore still lives in `src/shared/engine/run/runner.ts`, which re-exports them for existing callers. `src/shared/model/views.ts` defines RunView, SessionSummary, SessionView, MessageView and the view-only AuthoredRow | MessageRow queue union. Projections detach and freeze their output without freezing engine snapshots, and retain unchanged agents, attempts and transcript entries by reference when given the previous view. SessionSummary matches `session.get`; entry views count pasted images without their bytes. Message provenance is an explicit runtime input, never inferred from the sender, task link or withdrawal's `by` field. Queue projections keep message rows out of authored items and runner input.

The pure display queries live beside the views: `src/shared/model/run-display.ts` supplies task state, pause words and card/dock status; `src/shared/model/run-words.ts` supplies hold words and answers; `src/shared/model/queue-marks.ts` supplies queue marks. Their former engine/renderer modules re-export them, so today's engine remains the caller and owner. The snapshot projectors do not publish topics or run per text delta; B11's later publisher owns incremental updates. No runtime ownership or subscription changes in this preparation.

The user’s stalled-turn Interrupt and resend decision reaches the owning engine as a core-only `retry-task` event. It reserves the running task’s current attempt, waits for its cancelled held problem, then uses the existing Retry choice, preserving the original attempt and linking the new one with `retryOf` in run JSON. It waits through agent/group/global pauses, usage and permission holds; core backend-exhaustion updates reach the renderer owner too. A different task or attempt, Kill, reset, session close or refused interrupt cancels the reservation. Queue/run sends carry an `origin: 'queue'` marker and their exact owner/item/attempt reference across the session boundary, so another task queued to the same recipient is never retried and the core never mistakes run work for manual messages. The reference is checked again just before the native cancelled end is reduced; a task already taken back cannot be revived. This routing metadata is not passed to a CLI.

For a window-owned manual submission the same core-only event carries `messages` instead of task references. The existing engine reserves only its live running submissions, confirms their exact native cancelled end (including a prompt typed directly in a Terminal), then sends each new manual submission once the normal agent/group, usage, permission and session holds allow it. Each new submission keeps `retryOf` in its checkpoint; its images remain live-only. Holds are rechecked between native sends. Cancel, session close, restore and reset drop the reservation. This never composes a core Engine or makes the core a second journal writer for that canvas.
