# Architecture overview

[AGENTS.md](../../AGENTS.md) is the canonical instructions file. Read the area's doc before changing it; behaviour and documentation change together.

Main owns native windows and dialogs. The Electron-free core owns profile stores, canvas documents, delivery and sessions; `corrallm serve` hosts the same core under Node. The preload gives each trusted window fixed typed calls over its own port. The renderer mirrors topics and sends gestures as operations. The shared model and engine run on either side of that boundary.

| Area | Document |
| --- | --- |
| Composition, services, host and process ownership | [Core](core.md) |
| SQLite, durability, recovery, snapshots and dump | [Store](store.md) |
| Operations, scopes, authorization, rules and topics | [Registry](registry.md) |
| Delivery, withdrawals and read positions | [Messages](messages.md) |
| CLI, outside tokens, serve and wait | [Headless](headless.md) |
| Documents, rows, identity and pure edits | [Canvas](canvas.md) |
| Checkpoints, restoration and canvas switching | [Run recovery](run-recovery.md) |
| Adapter descriptors and catalog consumers | [Catalog](catalog.md) |
| Manager, settings, session protocol and watchdog | [Sessions](sessions.md) |
| Terminal and Agent SDK details | [Claude Code](claude-code.md) |
| Terminal and App Server details | [Codex](codex.md) |
| Readings, gauges and spending rules | [Usage](usage.md) |
| Canvas, agent, queue, terminal and search views | [Renderer](renderer.md) |
| Queue execution, session stores and needs | [Engine](engine.md) |
| Shared contracts, preload and transitional channels | [IPC](ipc.md) |
| Trust, identity, URLs, CSP and permissions | [Security](security.md) |
| Native dependencies and self-tests | [Native modules](native-modules.md) |
| Commands, configuration, builds and pins | [Toolchain](toolchain.md) |
| Fakes, fixtures, property tests and system gates | [Testing](testing.md) |
