# IPC channels and preload

[Architecture index](overview.md) · [Canonical instructions](../../AGENTS.md)

## `src/preload/`

Preload script (sandboxed; may import only 'electron' and src/shared).

Exposes window.api: one function per GUI operation (GUI_OPS, camel-cased: app.info → appInfo, canvas.create → canvasCreate), each a call over the window's port to the core, which core.ts asks main for as it loads (core:connect) and keeps in a CoreLink.

## `src/shared/`

Types shared by all processes, including the catalog (adapter.ts: what every adapter declares, ID_PATTERN, JOBS, and lookups over it), the connected-session protocol (session.ts; also JsonSchema, the type of the registry's JSON Schemas), what a terminal view is shown (terminal.ts), usage readings and rules (usage.ts: their types and checks) and a canvas's id (canvas.ts: CanvasId, ProjectFolder, and canvasIdOf, the .corral format and version check main and model/file.ts share), and CoreLink (link.ts: typed requests, answers as values, a result or an error, and events over a port, which checks that only plain data crosses; main, the core process and the preload speak it), and a window's link to the core over it (gui-link.ts: CoreGuiSide, what the core answers a window, `call`; 'core:port'; GuiApi, window.api's function per GUI operation).

No Node, Electron or DOM imports here.

## Calls and streams

Every window call is a registered operation, generated from GUI_OPS and validated through core.call. The window port has no generic channel handler. Session sends, answers, settings and panels use operations; runtime state arrives through topics. The sole Electron IPC handler is core:connect, with an empty argument list and a trusted top-level sender frame.

The fixed terminal screen stream stays separate from runtime topics: `src/main/core/terminal-events.ts` sends only terminal events to windows showing that canvas, and preload exposes terminalOnEvent with a removable listener. Terminal attach, detach, write, resize and drops remain typed operations. CoreGuiSide has call, not a channel request. Tests in `src/main/core/gui.test.ts` and `src/preload/index.test.ts` pin that removed requests and methods cannot be used.

The window's link answers the core one fixed request, `drafts.flush` (`GuiSide` in `src/shared/gui-link.ts`, B11 Design §16.5): before a quit's shutdown barrier, main asks the core (`flushDrafts`), which asks each window over its own port, at most 5 s each. The preload answers it once every listener the page set with `draftsOnFlush` (one fixed function, taking only a listener) has settled, at once with none; the renderer sets `useDraft.ts`'s `answerDraftFlushes` from `main.tsx`, so what is being typed is committed, each field's operation answered, first. It carries no run, pause, checkpoint or token, and is no generic channel. Runs are saved by the core’s shutdown barrier, not by a window acknowledgement.
