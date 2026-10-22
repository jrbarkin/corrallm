# IPC channels and preload

[Architecture index](overview.md) · [Canonical instructions](../../AGENTS.md)

## `src/preload/`

Preload script (sandboxed; may import only 'electron' and src/shared).

Exposes window.api: a function per hand-written channel (the run's getRun, saveRun and runReady, the sessions' and usage's) and event (onRunStopping, onSessionEvent), and one per GUI operation (GUI_OPS, camel-cased: app.info → appInfo, canvas.create → canvasCreate), each a call over the window's port to the core, which core.ts asks main for as it loads (core:connect) and keeps in a CoreLink.

## `src/shared/`

Types shared by all processes, including the IPC contract (ipc.ts), the catalog (adapter.ts: what every adapter declares, ID_PATTERN, JOBS, and lookups over it), the connected-session protocol (session.ts; also JsonSchema, the type of the registry's JSON Schemas), what a terminal view is shown (terminal.ts), usage readings and rules (usage.ts: their types and checks) and a canvas's id (canvas.ts: CanvasId, and canvasIdOf, the .corral format and version check main and model/file.ts share), and CoreLink (link.ts: typed requests, answers as values, a result or an error, and events over a port, which checks that only plain data crosses; main, the core process and the preload speak it), and a window's link to the core over it (gui-link.ts: CoreGuiSide, what the core answers a window, `call` and, until the hand-written channels move, `channel`; 'core:port'; GuiApi, window.api's function per GUI operation).

No Node, Electron or DOM imports here.

## Adding an IPC channel

A window's call is an operation (see The registry). A hand-written channel is only for what the renderer's run and sessions need of the core until B11 moves them there: today `run:get`, `run:save`, `run:ready` and `session:*` (`usage:*` are left from before the usage operations, which the renderer calls instead). To add one:

1. Declare it in `IpcContract` in `src/shared/ipc.ts`: `'domain:action': { args: [path: string]; result: Thing }`. Add the matching method to `InvokeApi` (part of `AppApi`) and its channel to `API_CHANNELS`.
2. Add an entry to `createHandlers` in `src/main/core/channels.ts`: `'domain:action': { parseArgs, handler }`. `parseArgs` receives `unknown[]` from an untrusted renderer and must validate every argument (type, length, allowed values) or throw. Use `noArgs` for channels without arguments.
3. Expose it in `src/preload/index.ts`: `action: (path) => invoke(API_CHANNELS.action, path)`.
4. Call it from the renderer as `window.api.action(...)`.
5. Extend `src/main/core/channels.test.ts` (argument validation and window identity) and `src/preload/index.test.ts`. If the UI uses it, stub it in `src/renderer/App.test.tsx` via `stubApi`.

The compiler enforces that main, preload and renderer agree on argument and result types, and that no contract channel is missing a core handler or an `AppApi` method.

Core-to-renderer events: declare the event in `IpcEvents` in `src/shared/ipc.ts` (`'domain:event': [agentId: string, thing: Thing]`), add a function to `EventApi` and its event to `API_EVENTS` (the compiler checks none is missing), expose it in the preload with `core.listen` (returning a function that stops listening), and send it with `Channels.emit` over the window's port to the canvas's windows only. `run:stopping` alone stays main-to-window through `sendEvent` and `ipcRenderer`; topic state uses the port's `topic(change)` contract instead.
