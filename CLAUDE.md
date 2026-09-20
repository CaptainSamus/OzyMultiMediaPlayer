# Multi-window Claude workflow (Ozy projects)

Mark works on the Ozy projects (OzyMultiMediaPlayer desktop app and the
OzyBoards website) through a tree of three Claude Code windows on this
machine. One fable window is the hub; it owns the conversation with Mark and
relays work to two peer windows.

## Roles

- **Fable window (hub)** — talks with Mark, brainstorms ideas, writes plans
  and specs, and decides how to fix anything the other windows get stuck on.
  Does not do bulk coding itself.
- **Opus window (coder)** — does the hard implementation work handed to it by
  fable. When it hits a problem that needs deeper thinking, it reports back
  to fable instead of guessing; fable plans the fix and sends it back.
- **Sonnet window (ops)** — commits, pushes, PRs, GitHub tags/releases,
  Vercel deployments, and other small routine tasks that are too expensive
  to spend opus on.

Problems flow up (opus → fable), plans and tasks flow down (fable → opus or
sonnet). Mark only needs to talk to fable.

## Window names

Windows are named `<layout> scott <model> <n>`. The current layout is:

| Role   | Window name              |
|--------|--------------------------|
| Hub    | `windows scott fable 1`  |
| Coder  | `windows scott opus 1`   |
| Ops    | `windows scott sonnet 1` |

## Startup routine (every new fable session on these projects)

1. Ask Mark which window tree we are using this session (the layout name and
   the window names). Default to the table above if he says nothing changed.
2. Run `ListAgents` to find the open Claude sessions on this machine and
   confirm the opus and sonnet windows are present. Use `SendMessage` with the
   exact names listed to hand work to them.
3. If a named window is missing, tell Mark which one before dispatching work
   to it; do not silently do that window's job in the hub.

Peer windows: when you receive a task from the hub, reply to the hub window
by name when done or when blocked.

## Existing rules that still apply

- Plan approval is not execution approval; wait for Mark to say start.
- Test Ozy with a separate `--user-data-dir`; never touch Mark's running
  instance or settings. Close any app/console windows you opened.
- When cutting a feature, comment it out in place rather than deleting it.
