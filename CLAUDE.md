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

Windows are named `scott <model> windows <n>` (older layouts used
`windows scott <model> <n>`). Any window whose name contains both `scott`
and `windows` belongs to the Ozy projects, whatever its number:

| Role   | Window name pattern            | Notes                                   |
|--------|--------------------------------|-----------------------------------------|
| Hub    | `scott fable windows <n>`      | the one Mark is talking to              |
| Coder  | `scott opus windows <n>`       | every opus window is a coder; 2+ means  |
|        |                                | parallel coding tasks                   |
| Ops    | `scott sonnet windows <n>`     |                                         |

A second or third opus window, or a second fable window, that matches this
pattern is for this project. Assume it without asking. Spread independent
tasks across the opus windows; give dependent tasks to the same window.

## Startup routine (every new fable session on these projects)

1. Run `ListAgents` and take every online window matching `scott … windows`
   as part of this project's tree. Only ask Mark if none match.
2. Confirm at least one opus and one sonnet window are present. Use `SendMessage` with the
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
