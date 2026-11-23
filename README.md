# Агенты (agent-roster)

BB plugin: a list of agent **roles** — assistant, project orchestrators, agents,
external employees — on top of ordinary BB threads. Threads of a role change; its
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
- **Role mark on thread rows**: bb row status (shown by default in bb's list; it
  never hides running, error or waiting) and a row-metadata mark (Machine Tabs
  always draws it; bb's list with Rows → Metadata on).
- **For agents**: a short hint in every thread (its own role and how to get the
  list), the `agent_roster_list` tool and `bb agent-roster list|add|update|remove|set-thread`.
  Messages between agents use the standard `bb thread tell`.

Commands: [skills/agent-roster/SKILL.md](skills/agent-roster/SKILL.md).

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
- Does not change any other plugin.

## Develop

```sh
npm install
npm test          # vitest: rules, server harness, frontend (jsdom)
npm run typecheck
bb plugin build
```
