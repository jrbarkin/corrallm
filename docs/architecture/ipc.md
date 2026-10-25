# IPC channels and preload

[Architecture index](overview.md) · [Canonical instructions](../../AGENTS.md)

## `src/preload/`

Preload script (sandboxed; may import only 'electron' and src/shared).

Exposes window.api: a function per remaining session-panel channel and onSessionEvent, and one per GUI operation (GUI_OPS, camel-cased: app.info → appInfo, canvas.create → canvasCreate), each a call over the window's port to the core, which core.ts asks main for as it loads (core:connect) and keeps in a CoreLink.

## `src/shared/`

Types shared by all processes, including the IPC contract (ipc.ts), the catalog (adapter.ts: what every adapter declares, ID_PATTERN, JOBS, and lookups over it), the connected-session protocol (session.ts; also JsonSchema, the type of the registry's JSON Schemas), what a terminal view is shown (terminal.ts), usage readings and rules (usage.ts: their types and checks) and a canvas's id (canvas.ts: CanvasId, and canvasIdOf, the .corral format and version check main and model/file.ts share), and CoreLink (link.ts: typed requests, answers as values, a result or an error, and events over a port, which checks that only plain data crosses; main, the core process and the preload speak it), and a window's link to the core over it (gui-link.ts: CoreGuiSide, what the core answers a window, `call` and, until the hand-written channels move, `channel`; 'core:port'; GuiApi, window.api's function per GUI operation).

No Node, Electron or DOM imports here.

## Adding an IPC channel

A window's call is an operation (see The registry). A hand-written channel is only for the session panels that X13 has not rewired yet (`session:*`). Runs are core-owned; there is no run read/save/ready channel. To add one:

1. Declare it in `IpcContract` in `src/shared/ipc.ts`: `'domain:action': { args: [path: string]; result: Thing }`. Add the matching method to `InvokeApi` (part of `AppApi`) and its channel to `API_CHANNELS`.
2. Add an entry to `createHandlers` in `src/main/core/channels.ts`: `'domain:action': { parseArgs, handler }`. `parseArgs` receives `unknown[]` from an untrusted renderer and must validate every argument (type, length, allowed values) or throw. Use `noArgs` for channels without arguments.
3. Expose it in `src/preload/index.ts`: `action: (path) => invoke(API_CHANNELS.action, path)`.
4. Call it from the renderer as `window.api.action(...)`.
5. Extend `src/main/core/channels.test.ts` (argument validation and window identity) and `src/preload/index.test.ts`. If the UI uses it, stub it in `src/renderer/App.test.tsx` via `stubApi`.

The compiler enforces that main, preload and renderer agree on argument and result types, and that no contract channel is missing a core handler or an `AppApi` method. Usage has no hand-written channel: reads and edits use the generated `usage.get`, `usage.setRule` and `usage.simulate` operations through core.call, and the renderer follows the usage topic.

Core-to-renderer events: declare the event in `IpcEvents` in `src/shared/ipc.ts` (`'domain:event': [agentId: string, thing: Thing]`), add a function to `EventApi` and its event to `API_EVENTS` (the compiler checks none is missing), expose it in the preload with `core.listen` (returning a function that stops listening), and send it with `Channels.emit` over the window's port to the canvas's windows only. Topic state uses the port's `topic(change)` contract.

The window's link answers the core one fixed request, `drafts.flush` (`GuiSide` in `src/shared/gui-link.ts`, B11 Design §16.5): before a quit's shutdown barrier, main asks the core (`flushDrafts`), which asks each window over its own port, at most 5 s each. The preload answers it once every listener the page set with `draftsOnFlush` (one fixed function, taking only a listener) has settled, at once with none; the renderer sets `useDraft.ts`'s `answerDraftFlushes` from `main.tsx`, so what is being typed is committed, each field's operation answered, first. It carries no run, pause, checkpoint or token, and is no generic channel. Runs are saved by the core’s shutdown barrier, not by a window acknowledgement.

`session:interrupt` takes only the agent; the parser rejects extra arguments. The core resolves the canvas from the calling window as for other session channels. Every interrupt uses the same connection behavior; neither a process id nor a thread id comes from the renderer.

<<<<<<< HEAD
`session:send`, `session:record` and `session:unqueue` are fixed transitional calls for AgentView until X13. Send validates a bounded UserMessage but admits it only as you, from the port’s shown canvas, into the core’s durable Delivery mailbox; caller-supplied origin/from/task never confer identity or run ownership. Its result is the core message id. Record keeps a view-handled command as a completed message without dispatch. Unqueue validates a message id and checks that it is your message to that agent. Each obeys the core shutdown write barrier. No window message/withdraw audience or image-capable operation schema is registered by this bridge. The native session query channels remain for X13.
=======
`session:send` also accepts the bounded `origin: 'queue'` marker and bounded `task: { agent, item, attempt }` reference the shared engine supplies for run work; other origins, incomplete references and task references without queue origin are refused. The core uses it only to route a stalled retry to the owning run, never as CLI data or authorization. A core-only `retry-task` event travels over the existing canvas-scoped `session:event` channel to reserve/cancel a renderer-owned retry or update its backend hold. It is produced only by the user-only stalled reply path and core usage updates; no new renderer invocation or generic event-sending function is exposed.

Until the renderer runtime cutover, `session:availability` reads one agent's readiness using the calling window's canvas. It takes only a bounded agent id and returns readiness and a sentence, never a directory. The canvas-scoped `session:availability` event invalidates pending checks and options; `onSessionAvailability` returns its listener's remover. `session:options` additionally accepts an optional bounded agent id for a contextual read. These remain fixed preload functions, not generic channels.
>>>>>>> origin/main
