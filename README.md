# Агенты (agent-roster)

BB plugin: a list of agent **roles** on top of ordinary BB threads:

- **agent** — a full agent on the platform: its own installation, threads that
  replace each other (a personal assistant is an agent with its own icon);
- **orchestrator** — a project thread promoted to a role (crown mark);
- **external employee** — an agent in another BB, reachable by a link.

 Threads of a role change; its
name, icon and place in the hierarchy stay.

## What it adds

- **Sidebar block** «Агенты» between thread search and the thread list: a tree by
  "reports to", each record with icon, name, state (working, waiting for the
  owner, error, idle), number of executors under it and how many failed. Click
  opens the role's active thread. Works with bb's own list and with the Machine
  Tabs list; when the spot is not found the block is not drawn and nothing else
  changes.
- **Page** «Агенты» in the navigation: the same tree, adding, editing every field,
  removing a role; the badge counts roles waiting for the owner.
- **Thread menu**: «Сделать оркестратором…», «Изменить роль…», «Снять роль».
- **One role mark — the crown** for agents and orchestrators (an external employee
  keeps a link glyph); the kind is text in the tooltip, card and settings. One
  record may be **main** (`--primary on`, or the record dialog): its crown is the
  plugin's only colour, a calm gold; marking another record main clears the old one.
  A role with several threads: the active one gets the crown, the others the same
  crown muted ("резервный тред роли").
- **Composite icon (0.3.1)**: the record and its thread look alike — the project's
  logo (monochrome) wearing the crown on top, the provider glyph in its corner, a
  small Telegram plane in the bottom-right corner when the role is on Telegram. The
  main record is a large gold crown. In Machine Tabs' list this comes through its
  thread marks (`place: top`, `size: large` for the main record, a `telegram`
  corner mark).
- **Role mark on thread rows**: one small mark before the row title (next to the
  project icon), drawn by a stylesheet; bb's own state glyph on the right (running,
  unread, error, waiting) is never replaced. Works in bb's list and Machine Tabs.
- **For agents**: a short hint in every thread (its own role and how to get the
  list), the `agent_roster_list` tool and `bb agent-roster list|add|update|remove|set-thread`.
  Messages between agents use the standard `bb thread tell`.

Commands: [skills/agent-roster/SKILL.md](skills/agent-roster/SKILL.md).

### 0.2: work with an agent from the block

- Roles stand side by side (no nesting of roles); "reports to" is text in the
  tooltip and on the page.
- A record expands to its executors: subthreads and their subthreads (two levels,
  deeper ones as "ещё N"), finished and archived hidden behind a switch; the
  expansion is remembered.
- A line under the name: what the active thread is doing now or what it finished with.
- «ждёт тебя»: the active thread or one of its executors waits for the owner; the
  pill opens exactly that thread.
- Work in the role's project: spinner and "own · others" — running subthreads of the
  role (any depth) vs other running threads of the same project; another role's
  threads are not counted. Expanded: two labelled groups.
- Channels: a small Telegram mark when the bridge reports the role's thread or pair
  bound to a chat (read-only `status` RPC of the bridge plugin; no data — no mark).
- Quick message to the active thread (standard `threads.send`), and a record menu:
  open, write, change role, move to another thread, remove role.
- Data comes from bb's sidebar thread data (live), plus server reads on change; no
  polling more often than every few seconds.

### 0.5.0: a new employee on the platform from «＋»

«＋» in the block → «Сотрудник на Vallis» opens the install screen. The plugin calls the platform's one
installer entry on the employee's server and shows its state; the steps, questions and checks come from the
installer as data (contract: install-state.md of the platform, format 1). The plugin names no step and no
parameter — a new installer step or parameter appears on the screen without a plugin release.

1. **Machine.** Pick a connected machine of this BB; no server in the list → bb's own way to add a machine
   (Settings → Machines, `bb machine enroll`) and the launch document (setting «Адрес документа запуска»).
2. **Form** from `<entry> employee --describe --json` on that machine: `string`, `choice`, `bool`; a `secret`
   field only says which key will come through the secret store — the screen has no input for it and never
   takes a secret. Field → parameter: the field's `flag`, else kebab-case id → `--<id> <value>`; bool true —
   a bare flag; false and empty — not passed; secret — never. Values are separate arguments, no shell.
3. **Run** in the background with bb's terminal on that machine; the entry's first output line names its state
   file. The screen reads the file with one command per read, only while the screen is open and the install is
   going, at most every 10 s; one read on opening.
4. **Steps** by `title` and `state` as the installer reports them (an unknown step or state is shown as is).
   «Ждёт человека»: `what`, `how`, `copy`, `show` and the installer's buttons (`continue` — run again with the
   same parameters, `retry` — with its `params`, `cancel` — TERM to the entry); `auto` — the screen just waits.
   An error: its text, «подробности» (the last log lines), «повторить» when `retry`. Hung (going and the
   heartbeat older than three intervals) — said in words, with «повторить».
5. **Result** → an «агент» record: name and «за что отвечает» from `result.role`, links from `result.links`.

In the block, an install that is going shows «устанавливается: <step>» and «ждёт» when a step waits for the
owner (the last read state: no reads while the screen is closed). A newer format or no installer — a message
and the launch document. Setting «Вход установщика сотрудника на машине» — the entry's command (default
`vallis-install`).

### 0.4.5: the role's thread title «Name — project»

For a role with the switch «Вести название треда» on (default for an orchestrator; off for
an agent, whose platform or bridge names its threads; never for an external employee) and a
project, the plugin keeps the active thread's title «Name — project» with bb's ordinary
thread rename:

- it renames when the role is added, its name or project changes, the switch is turned on,
  or the role moves to another thread (`set-thread`); a title that already matches is left;
- the title the thread had before is remembered in the plugin's data and comes back when the
  role leaves the thread (removed, moved to another thread, switch off) — if the title is
  still the plugin's; a title the owner changed by hand stays;
- a thread renamed by hand after the plugin keeps the owner's title until the role itself
  changes;
- `bb agent-roster title-previous <thread> "<old title>"` records the old title of a thread
  renamed to «Name — project» by hand before the plugin, so it can come back.

The list JSON (format 1) carries `managesTitle` for every role.

### 0.4.3: the block reads like bb's thread list

- **A press anywhere on a record opens its active thread** (icon, name, status line,
  empty space); the pointer is a hand over the whole record. Only the chevron expands a
  record. Executor rows open their own threads.
- **Grid.** The «Агенты» header, the record icon, the name and the right edge stand on
  the same lines as bb's «Last 5» header and thread rows. «⋯» takes no place of its own:
  with a mouse it shows over the state cell on hover; on touch screens it is always shown.
- **Order.** The main record first; the rest by the latest activity of the active thread
  and its executors, newest first; equal → by name. The block reorders at most every
  45 s, and never while the pointer is over it or a record is expanded. The page lists
  all records in the same order.
- **«↓ Показать ещё».** The block shows the first N records (setting «Сколько записей
  показывать в блоке», default 5), then «↓ Показать ещё» with «shown / total»;
  «↑ Свернуть» after. A record that waits for the owner or has an error is always shown.
- **Live executors — one rule for the counter and the list.** A live executor is a
  subthread at any depth that is not archived — idle and finished ones included; hidden
  subthreads and their branches are not counted. The record's «↳N» is exactly the number
  of rows the expanded record lists (levels below the second are counted as «+N» on their
  parent, the rows beyond 7 as «ещё N»). Archived executors are behind «архивные (N)».
- **Expanded record.** The executors hang under the record with an indent and a thin
  guide, like bb's subthreads. No executors → one line «исполнителей нет» and
  «архивные (N)». Group labels («под управлением» / «не под управлением») only when both
  groups are there. Every service line uses one small font; expandable ones have a
  chevron that shows their state, a hover highlight and the hand pointer.
- **Project logo** — the same picture as the thread rows (Machine Tabs' icon first, the
  project's `.bb/icon.png` / `.bb/icon.svg` as a fallback). The file is not changed: a
  PNG is shown in grayscale, an SVG as a mask in the text colour, so any fills, fill
  rules or `currentColor` give the same monochrome shape.

### 0.3: orchestrator vs agent

- **Orchestrator** (a project thread promoted to a role) gets three layers:
  1. the shared role text from [orchestrator-rules.ts](orchestrator-rules.ts) — one file,
     one language (the owner's BB instruction language, Russian), same for every
     orchestrator, updates with the plugin;
  2. the role's specifics in a section `## Роль: <name>` of the project's AGENTS.md.
     On promotion the plugin shows a template and appends it to the end of the file
     only on the button (creating the file if there is none). An existing section is
     never touched; nothing is committed;
  3. in the thread instructions: layer 1 and a pointer to that section.
- A switch «общие правила оркестратора» per orchestrator (record dialog, CLI
  `--rules on|off`): on for a new promotion; **off** for orchestrators saved before 0.3.
- **Agent** records get no orchestrator rules — only the list and the active thread.
- The list JSON gains `orchestratorRules` (an addition; `formatVersion` stays 1).

## List format (stable contract)

`bb agent-roster list --json` and the `agent_roster_list` tool return the same JSON:

```json
{
  "formatVersion": 1,
  "roles": [
    {
      "id": "site",
      "name": "Site",
      "kind": "orchestrator",
      "responsibility": "website",
      "reportsTo": null,
      "reportsToName": null,
      "primary": false,
      "orchestratorRules": true,
      "projectId": "proj_…",
      "activeThreadId": "thr_…",
      "url": null
    }
  ]
}
```

- `kind`: `agent` | `orchestrator` | `external`. `primary` (added in 0.2.1): the one main record.
- `reportsTo`: role id, `null` = the owner. `activeThreadId`: `null` when the role has
  no active thread here (archived, deleted, none bound, or external). `url`: the link
  of an external employee, otherwise `null`.
- Fields are never renamed or removed; new ones are only added. A breaking change
  would raise `formatVersion`. `tests/server.test.ts` pins this.


## Install

```sh
bb plugin install 'git:https://github.com/ainurminibaev/bb-agent-roster.git@semver:^0.1.0'
```

Requires bb ≥ 0.50 (Plugin SDK ≥ 0.6.157).

## Data and compatibility

- One source of truth: the roster in the plugin's own storage (`kv: roster`),
  read tolerantly (broken records dropped, unknown values fall back, dangling or
  cyclic parents become roots). It survives disable/enable.
- Reads another plugin only through its public RPC, read-only: `chatPairStatus`
  (`{ topicId }` → `{ active }`) of the bridge plugin named in settings, for
  roles with several threads and a pair topic number. Any failure → the most
  recently active thread.
- Sidebar anchors (bb 0.50): `[data-testid="app-sidebar-body"] [data-sidebar="content"]`
  (bb's own list: the block goes first) and the first `[data-machine-tabs-list]`
  inside it (Machine Tabs: after its search, above "Last N"). Covered by
  `tests/app.test.tsx`.
- Project logo of an orchestrator (drawn monochrome, kind as a corner mark):
  `.bb/icon.svg` or `.bb/icon.png` of the project's folder read through bb's
  `files.read` (project sources from `projects.get`); fallback, read-only, the
  `project_icons` RPC of Machine Tabs (0.2.x, `{ icons: { [projectId]: data-URL } }`).
  No file, no plugin or another format → the kind icon, no error.
- "Перейти к проекту": the plugin's own small scroll to bb's
  `[data-sidebar-project-id]` section with a short accent flash (neither Machine
  Tabs nor Project Catalog exposes an entry for this). Section not in the current
  view → `navigate.toProject`. Attribute gone after a bb update → no button.
- Opening a record works like bb's thread row: a link with the thread's href,
  Cmd/Ctrl-click → split, drag → bb's split gesture
  (`experimental_useSidebarThreadSplit`); on a phone the sidebar drawer is closed
  with its own Escape close (the SDK has no "close drawer" outside the thread list).
- Does not change any other plugin.

## Develop

```sh
npm install
npm test          # vitest: rules, server harness, frontend (jsdom)
npm run typecheck
bb plugin build
```
