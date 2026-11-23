import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { FormEvent, ReactNode } from "react";
import { createPortal } from "react-dom";
import {
  definePluginApp,
  experimental_THREAD_ACTION_GROUPS,
  experimental_useSidebarThreads,
  useBbNavigate,
  useRealtime,
  useRpc,
} from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "./server";
import {
  type Binding,
  buildTree,
  executorTree,
  flattenTree,
  KIND_ICON,
  KIND_LABEL,
  MODULE_NAME,
  type ResolvedRole,
  ROLE_KINDS,
  type RoleKind,
  roleState,
  type RoleState,
  summarize,
  summaryLabel,
  projectWork,
  rolesForThread,
  type RowFacts,
  STATE_LABEL,
  type TreeNode,
} from "./model";
import { getState, openDialog, setState, subscribe, useStore, type DialogRequest } from "./lib/store";
import { HOST_ATTR, keepPlaced } from "./lib/anchor";
import { mountRowMarks } from "./lib/row-marks";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

export const CHANGED = "roster-changed";
const REFRESH_MS = 30_000;
const PANEL_PATH = "agents";

type Rpc = ReturnType<typeof useRpc<typeof rpcContract>>;

// ---------- data ----------

let inflight: Promise<void> | null = null;
/** One fetch at a time; every consumer reads the shared store. */
function refresh(rpc: Rpc): Promise<void> {
  inflight ??= rpc
    .call("roster_list", null)
    .then((r) => setState({ roles: r.roles as ResolvedRole[], launchDocUrl: r.launchDocUrl }))
    .catch(() => undefined)
    .finally(() => { inflight = null; });
  return inflight;
}

/** Keeps the shared roster fresh: on mount, on the server's signal, every 30 s. */
function useRosterSync(): Rpc {
  const rpc = useRpc<typeof rpcContract>();
  const reload = useCallback(() => void refresh(rpc), [rpc]);
  useEffect(() => {
    reload();
    const timer = window.setInterval(reload, REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [reload]);
  useRealtime(CHANGED, reload);
  return rpc;
}

function useRoles(): ResolvedRole[] | null {
  return useStore((s) => s.roles);
}

/** bb's sidebar rows, reduced to what the module reads. */
export interface Row extends RowFacts {
  title: string;
  projectId: string | null;
}
function useRows(): { rows: Row[]; byId: Map<string, Row> } {
  const { threads } = experimental_useSidebarThreads();
  return useMemo(() => {
    const rows: Row[] = (threads ?? []).map((t) => ({
      id: t.id,
      parentThreadId: t.parentThreadId,
      status: String(t.status),
      indicator: String(t.indicator),
      hasPendingInteraction: Boolean(t.hasPendingInteraction),
      isArchived: Boolean(t.isArchived),
      isHidden: Boolean(t.isHidden),
      title: String(t.displayTitle ?? t.title ?? t.id),
      projectId: typeof t.projectId === "string" ? t.projectId : null,
    }));
    return { rows, byId: new Map(rows.map((r) => [r.id, r])) };
  }, [threads]);
}

// ---------- pieces ----------

/** State like bb's thread rows: a spinner while working, otherwise a dot. */
function StateMark({ state, label }: { state: RoleState; label?: string }) {
  const aria = label ?? STATE_LABEL[state];
  if (state === "running" || state === "executors") {
    return (
      <span data-state-mark="" role="status" aria-label={aria} title={aria} className="inline-flex size-3.5 shrink-0 items-center justify-center">
        <span className={cn("size-3 animate-spin rounded-full border-[1.5px]", state === "running" ? "border-muted-foreground/30 border-t-muted-foreground" : "border-muted-foreground/20 border-t-muted-foreground/60")} />
      </span>
    );
  }
  return (
    <span data-state-mark="" role="status" aria-label={aria} title={aria} className="inline-flex size-3.5 shrink-0 items-center justify-center">
      <span className={cn("size-1.5 rounded-full", STATE_CLASS[state])} />
    </span>
  );
}

const STATE_CLASS: Record<RoleState, string> = {
  running: "bg-muted-foreground",
  executors: "bg-muted-foreground",
  waiting: "bg-amber-500",
  error: "bg-red-500",
  idle: "bg-muted-foreground/40",
  none: "border border-muted-foreground/50 bg-transparent",
  external: "bg-violet-400",
};

/** A channel the record is reachable by (not a role icon): Telegram's paper plane. */
function ChannelMark({ label }: { label: string }) {
  return (
    <span data-agent-roster-channel="telegram" role="img" aria-label={label} title={label} className="inline-flex size-3.5 shrink-0 items-center justify-center text-sky-500">
      <svg viewBox="0 0 24 24" className="size-3" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M21 4 3 11l6 2 2 6 3-4 5 4z" /><path d="m9 13 12-9" /></svg>
    </span>
  );
}

export function RoleIcon({ role, className }: { role: { icon: string; kind: RoleKind }; className?: string }) {
  if (role.icon) return <span data-role-icon="" className={cn("inline-flex w-4 shrink-0 justify-center text-[13px] leading-none", className)} aria-hidden="true">{role.icon}</span>;
  return <span data-role-icon="" className="inline-flex shrink-0" aria-hidden="true"><Icon name={KIND_ICON[role.kind]} className={cn("size-4 shrink-0", className)} /></span>;
}

// ---------- per-record UI state, remembered ----------

const EXPANDED_KEY = "agent-roster:expanded";
function readExpanded(): Set<string> {
  try {
    const raw = JSON.parse(window.localStorage.getItem(EXPANDED_KEY) ?? "[]");
    return new Set(Array.isArray(raw) ? raw.filter((x) => typeof x === "string").slice(0, 200) : []);
  } catch {
    return new Set();
  }
}
let expanded = readExpanded();
const expandedListeners = new Set<() => void>();
function toggleExpanded(id: string) {
  expanded = new Set(expanded);
  if (expanded.has(id)) expanded.delete(id); else expanded.add(id);
  try { window.localStorage.setItem(EXPANDED_KEY, JSON.stringify([...expanded])); } catch { /* private mode */ }
  for (const fn of [...expandedListeners]) fn();
}
function useExpanded(id: string): boolean {
  return useSyncExternalStore(
    (fn) => { expandedListeners.add(fn); return () => expandedListeners.delete(fn); },
    () => expanded.has(id),
    () => false,
  );
}

/** "What it is doing" lines, refetched only when a thread's status or update time changes. */
function useActivity(roles: readonly ResolvedRole[], rows: ReadonlyMap<string, Row>): Record<string, string | null> {
  const rpc = useRpc<typeof rpcContract>();
  const ids = roles.flatMap((r) => (r.active.kind === "thread" ? [r.active.threadId] : []));
  const key = ids.map((id) => `${id}:${rows.get(id)?.status ?? ""}:${rows.get(id)?.indicator ?? ""}`).join("|");
  const [lines, setLines] = useState<Record<string, string | null>>({});
  useEffect(() => {
    if (ids.length === 0) return;
    let live = true;
    const timer = window.setTimeout(() => {
      rpc.call("roster_activity", { threadIds: ids.slice(0, 50) }).then((r) => { if (live) setLines(r); }, () => undefined);
    }, 400);
    return () => { live = false; window.clearTimeout(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, rpc]);
  return lines;
}

// ---------- a record ----------

interface RowProps {
  node: TreeNode<ResolvedRole>;
  rows: { rows: Row[]; byId: Map<string, Row> };
  activity: string | null;
  dense: boolean;
}

function RecordMenu({ role, onClose, onWrite }: { role: ResolvedRole; onClose: () => void; onWrite: () => void }) {
  const rpc = useRpc<typeof rpcContract>();
  const open = useOpenRole();
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const away = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) onClose(); };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", esc);
    return () => { document.removeEventListener("mousedown", away); document.removeEventListener("keydown", esc); };
  }, [onClose]);
  const items: { id: string; label: string; run: () => void; danger?: boolean; disabled?: boolean }[] = [
    { id: "open", label: "Открыть", run: () => open(role) },
    { id: "write", label: "Написать…", run: onWrite, disabled: role.active.kind !== "thread" },
    { id: "edit", label: "Изменить роль…", run: () => openDialog({ mode: "edit", roleId: role.id }) },
    { id: "move", label: "Перевести на другой тред…", run: () => openDialog({ mode: "move", roleId: role.id }), disabled: role.kind === "external" },
    { id: "remove", label: "Снять роль", danger: true, run: () => { void rpc.call("roster_remove", { id: role.id }).then(() => refresh(rpc)); } },
  ];
  return (
    <div ref={ref} role="menu" data-agent-roster-menu="" className="absolute right-1 top-7 z-50 min-w-48 rounded-md border border-border bg-popover p-1 text-sm text-popover-foreground shadow-md">
      {items.map((item) => (
        <button key={item.id} type="button" role="menuitem" disabled={item.disabled}
          className={cn("flex w-full items-center rounded-sm px-2 py-1.5 text-left hover:bg-accent disabled:opacity-40", item.danger && "text-red-500")}
          onClick={() => { onClose(); item.run(); }}>
          {item.label}
        </button>
      ))}
    </div>
  );
}

function QuickMessage({ role, onDone }: { role: ResolvedRole; onDone: () => void }) {
  const rpc = useRpc<typeof rpcContract>();
  const [text, setText] = useState("");
  const [state, setStateLocal] = useState<"idle" | "sending" | "error">("idle");
  const [error, setError] = useState<string | null>(null);
  const send = async () => {
    const body = text.trim();
    if (!body || state === "sending") return;
    setStateLocal("sending");
    try {
      await rpc.call("roster_send", { roleId: role.id, text: body });
      setText("");
      onDone();
    } catch (cause) {
      setStateLocal("error");
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };
  return (
    <div data-agent-roster-compose="" className="mx-1 mb-1 rounded-md border border-border bg-background p-1">
      <textarea
        autoFocus
        value={text}
        rows={2}
        placeholder={`Сообщение для «${role.name}» (Enter — отправить, Esc — закрыть)`}
        aria-label={`Сообщение для ${role.name}`}
        className="w-full resize-none bg-transparent px-1 text-sm outline-none"
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") onDone();
          if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void send(); }
        }}
      />
      <div className="flex items-center gap-1">
        <span className="flex-1 truncate text-[11px] text-red-500">{error}</span>
        <Button size="sm" variant="ghost" className="h-6 px-2 text-xs" onClick={onDone}>Отмена</Button>
        <Button size="sm" className="h-6 px-2 text-xs" disabled={!text.trim() || state === "sending"} onClick={() => void send()}>Отправить</Button>
      </div>
    </div>
  );
}

function Executors({ role, rows, dense, others }: { role: ResolvedRole; rows: { rows: Row[]; byId: Map<string, Row> }; dense: boolean; others: string[] }) {
  const navigate = useBbNavigate();
  const rpc = useRpc<typeof rpcContract>();
  const [showFinished, setShowFinished] = useState(false);
  const [archived, setArchived] = useState<Row[]>([]);
  const rootId = role.active.kind === "thread" ? role.active.threadId : null;
  useEffect(() => {
    if (!showFinished || !rootId) { setArchived([]); return; }
    let live = true;
    rpc.call("roster_executors", { threadId: rootId }).then((r) => {
      if (!live) return;
      setArchived(r.threads.filter((t) => t.isArchived).map((t) => ({
        id: t.id, parentThreadId: t.parentThreadId, status: t.status, indicator: "none",
        hasPendingInteraction: false, isArchived: true, isHidden: false, title: t.title, projectId: null,
      })));
    }, () => undefined);
    return () => { live = false; };
  }, [showFinished, rootId, rpc]);
  const all = useMemo(() => {
    if (archived.length === 0) return rows.rows;
    const known = new Set(rows.rows.map((r) => r.id));
    return [...rows.rows, ...archived.filter((r) => !known.has(r.id))];
  }, [rows.rows, archived]);
  if (!rootId) return null;
  const nodes = executorTree(rootId, all, showFinished);
  const finished = executorTree(rootId, rows.rows, true).length - executorTree(rootId, rows.rows, false).length;
  const byId = new Map(all.map((r) => [r.id, r]));
  const groupLabel = (text: string) => (
    <li className="pt-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground/80" style={{ paddingLeft: dense ? 26 : 32 }}>{text}</li>
  );
  return (
    <ul data-agent-roster-executors="" className="flex flex-col">
      {groupLabel("Под управлением")}
      {nodes.map((n) => (
        <li key={n.row.id} data-executor={n.row.id} data-depth={n.depth} data-state={n.state} className="flex items-center">
          <button type="button" title={`${(byId.get(n.row.id) as Row | undefined)?.title ?? n.row.id} — ${STATE_LABEL[n.state]}${n.row.isArchived ? " (архив)" : ""}`}
            onClick={() => navigate.toThread(n.row.id)}
            className={cn("flex min-w-0 flex-1 items-center gap-1.5 rounded-md text-left text-[13px] text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-foreground", dense ? "h-6" : "h-8")}
            style={{ paddingLeft: `${(dense ? 30 : 36) + (n.depth - 1) * 14}px`, paddingRight: 8 }}>
            <span className={cn("min-w-0 flex-1 truncate", n.row.isArchived && "line-through opacity-70")}>{(byId.get(n.row.id) as Row | undefined)?.title ?? n.row.id}</span>
            {n.hiddenBelow > 0 ? <span className="shrink-0 text-[11px]">ещё {n.hiddenBelow}</span> : null}
            <StateMark state={n.state} />
          </button>
        </li>
      ))}
      {nodes.length === 0 && finished === 0 && !showFinished ? (
        <li className="py-0.5 text-[12px] text-muted-foreground" style={{ paddingLeft: dense ? 30 : 36 }}>исполнителей нет</li>
      ) : null}
      <li>
        <button type="button" data-agent-roster-show-finished="" className="py-0.5 text-[11px] text-muted-foreground underline-offset-2 hover:underline" style={{ paddingLeft: dense ? 30 : 36 }}
          onClick={() => setShowFinished((v) => !v)}>
          {showFinished ? "скрыть завершённые и архивные" : `показать завершённые и архивные${finished > 0 ? ` (${finished}+)` : ""}`}
        </button>
      </li>
      {others.length > 0 ? (
        <>
          {groupLabel("Не под управлением")}
          {others.map((id) => (
            <li key={id} data-unmanaged={id} className="flex items-center">
              <button type="button" title={`${rows.byId.get(id)?.title ?? id} — работает, не под управлением роли`} onClick={() => navigate.toThread(id)}
                className={cn("flex min-w-0 flex-1 items-center gap-1.5 rounded-md text-left text-[13px] text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-foreground", dense ? "h-6" : "h-8")}
                style={{ paddingLeft: dense ? 30 : 36, paddingRight: 8 }}>
                <span className="min-w-0 flex-1 truncate">{rows.byId.get(id)?.title ?? id}</span>
                <StateMark state="running" />
              </button>
            </li>
          ))}
        </>
      ) : null}
    </ul>
  );
}

function RoleRow({ node, rows, activity, dense }: RowProps) {
  const { role } = node;
  const open = useOpenRole();
  const navigate = useBbNavigate();
  const isOpen = useExpanded(role.id);
  const [menu, setMenu] = useState(false);
  const [writing, setWriting] = useState(false);
  const allRoles = useRoles() ?? [];
  const summary = summarize(role.active, rows.rows, rows.byId);
  const work = projectWork(role, role.active, rows.rows, allRoles);
  const workLabel = `в проекте работают: под управлением ${work.own.length}, не под управлением ${work.others.length}`;
  const anyWork = work.own.length + work.others.length > 0;
  // Work in the project shows as a spinner even while the role itself waits ("ждёт тебя" stays as a pill).
  const quietWithWork = anyWork && (summary.state === "idle" || summary.state === "waiting");
  const label = quietWithWork ? `${summaryLabel(summary)}; ${workLabel}` : summaryLabel(summary);
  const title = [
    `${role.name} — ${KIND_LABEL[role.kind]}`,
    role.responsibility,
    `Подчиняется: ${role.parentName ?? "владельцу"}`,
    `Состояние: ${label}`,
    summary.total ? `Исполнителей: ${summary.total}${summary.errors ? `, с ошибкой: ${summary.errors}` : ""}` : "",
  ].filter(Boolean).join("\n");
  const pad = dense ? 4 : 8;
  return (
    <li data-agent-roster-role={role.id} data-state={summary.state} className="relative">
      <div className="group/role flex items-center">
        <button type="button" aria-label={isOpen ? `Свернуть ${role.name}` : `Раскрыть ${role.name}`} aria-expanded={isOpen}
          data-agent-roster-toggle=""
          className={cn("flex size-4 shrink-0 items-center justify-center rounded text-muted-foreground hover:text-sidebar-foreground", role.active.kind !== "thread" && "invisible")}
          style={{ marginLeft: pad }}
          onClick={() => toggleExpanded(role.id)}>
          <svg viewBox="0 0 24 24" className={cn("size-3 transition-transform", isOpen && "rotate-90")} fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m9 6 6 6-6 6" /></svg>
        </button>
        <button type="button" title={title} onClick={() => open(role)}
          className={cn("flex min-w-0 flex-1 flex-col justify-center rounded-md pl-1 pr-1 text-left hover:bg-sidebar-accent focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring", dense ? "min-h-7 py-0.5" : "min-h-9 py-1")}>
          <span className="flex w-full min-w-0 items-center gap-1.5 text-sm">
            <RoleIcon role={role} />
            <span className="min-w-0 flex-1 truncate">{role.name}</span>
            {summary.total > 0 ? (
              <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground" aria-label={`исполнителей ${summary.total}`}>
                ↳{summary.total}
                {summary.errors > 0 ? <span className="ml-1 text-red-500" aria-label={`с ошибкой ${summary.errors}`}>⊗{summary.errors}</span> : null}
              </span>
            ) : null}
            {work.own.length + work.others.length > 0 ? (
              <span data-agent-roster-work="" title={workLabel} aria-label={workLabel} className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
                {work.own.length} · {work.others.length}
              </span>
            ) : null}
            {(role.channels ?? []).map((c) => <ChannelMark key={c.kind} label={c.label} />)}
            <StateMark state={quietWithWork ? "executors" : summary.state} label={label} />
            {!dense ? <span className="hidden w-40 shrink-0 truncate text-xs text-muted-foreground sm:inline">{label}</span> : null}
          </span>
          {!dense ? <span data-agent-roster-parent="" className="block w-full truncate pl-[22px] text-[11px] text-muted-foreground">{KIND_LABEL[role.kind]} · подчиняется: {role.parentName ?? "владельцу"}</span> : null}
          {activity ? <span data-agent-roster-activity="" className="block w-full truncate pl-[22px] text-[11px] text-muted-foreground">{activity}</span> : null}
        </button>
        {summary.waitingThreadId ? (
          <button type="button" data-agent-roster-waiting="" title="Открыть тред, который ждёт твоего ответа"
            className="mr-0.5 shrink-0 rounded-full bg-amber-500/15 px-1.5 text-[11px] font-medium text-amber-600 hover:bg-amber-500/25"
            onClick={() => navigate.toThread(summary.waitingThreadId!)}>
            ждёт тебя
          </button>
        ) : null}
        <button type="button" aria-label={`Действия: ${role.name}`} aria-haspopup="menu" data-agent-roster-menu-button=""
          className="flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground opacity-60 hover:bg-sidebar-accent hover:opacity-100 focus-visible:opacity-100"
          onClick={() => setMenu((v) => !v)}>
          <svg viewBox="0 0 24 24" className="size-3.5" fill="currentColor" aria-hidden="true"><circle cx="5" cy="12" r="1.8" /><circle cx="12" cy="12" r="1.8" /><circle cx="19" cy="12" r="1.8" /></svg>
        </button>
      </div>
      {menu ? <RecordMenu role={role} onClose={() => setMenu(false)} onWrite={() => setWriting(true)} /> : null}
      {writing ? <QuickMessage role={role} onDone={() => setWriting(false)} /> : null}
      {isOpen ? <Executors role={role} rows={rows} dense={dense} others={work.others} /> : null}
    </li>
  );
}

function useOpenRole() {
  const navigate = useBbNavigate();
  return useCallback((role: ResolvedRole) => {
    if (role.active.kind === "thread") navigate.toThread(role.active.threadId);
    else if (role.active.kind === "external") navigate.openUrl(role.active.url);
    else openDialog({ mode: "edit", roleId: role.id });
  }, [navigate]);
}

function RosterTree({ dense }: { dense: boolean; editable?: boolean }) {
  const roles = useRoles();
  const rows = useRows();
  // Roles stand side by side; only a record's executors nest under it.
  const flat = useMemo(() => flattenTree(buildTree((roles ?? []).map((r) => ({ ...r, parentId: null })))), [roles]);
  const activity = useActivity(roles ?? [], rows.byId);
  if (roles === null) return null;
  return (
    <ul className="flex flex-col" aria-label={MODULE_NAME}>
      {flat.map((node) => (
        <RoleRow key={node.role.id} node={node} rows={rows} dense={dense}
          activity={node.role.active.kind === "thread" ? activity[node.role.active.threadId] ?? null : null} />
      ))}
    </ul>
  );
}

const ADD_REQUEST: DialogRequest = { mode: "add", kind: "orchestrator", threadId: null, projectId: null };

/** The block in the sidebar, between thread search and the thread list. */
export function SidebarBlock() {
  const roles = useRoles();
  const navigate = useBbNavigate();
  if (roles === null) return null;
  return (
    <section data-agent-roster-section="" aria-label={MODULE_NAME} className="mx-2 mb-1.5 mt-1 border-b border-border pb-1.5">
      <div className="flex h-7 items-center px-2 text-xs font-medium text-muted-foreground">
        <button type="button" className="flex-1 truncate text-left hover:text-sidebar-foreground" onClick={() => navigate.toPluginPanel(PANEL_PATH)}>
          {MODULE_NAME}
        </button>
        {roles.length > 0 ? (
          <button type="button" className="flex size-6 items-center justify-center rounded-md hover:bg-sidebar-accent hover:text-sidebar-foreground" aria-label="Добавить агента" title="Добавить агента" onClick={() => openDialog(ADD_REQUEST)}>
            <Icon name="Plus" className="size-3.5" />
          </button>
        ) : null}
      </div>
      {roles.length === 0 ? (
        <button type="button" className="flex h-7 w-full items-center gap-1.5 rounded-md px-2 text-left text-sm text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-foreground" onClick={() => openDialog(ADD_REQUEST)}>
          <Icon name="Plus" className="size-4" />
          Добавить первого агента
        </button>
      ) : (
        <RosterTree dense editable={false} />
      )}
    </section>
  );
}

/** The "Агенты" page. */
export function RosterPage() {
  useRosterSync();
  const roles = useRoles();
  return (
    <div className="h-full overflow-y-auto p-4 md:p-5">
      <div className="mx-auto w-full max-w-3xl space-y-4">
        <div className="flex items-center gap-2">
          <p className="flex-1 text-sm text-muted-foreground">
            Роли: агенты, оркестраторы проектов и внешние сотрудники. Нажатие открывает действующий тред роли.
          </p>
          <Button onClick={() => openDialog(ADD_REQUEST)}>
            <Icon name="Plus" className="size-4" />
            {roles && roles.length === 0 ? "Добавить первого агента" : "Добавить"}
          </Button>
        </div>
        {roles === null ? (
          <div role="status" className="rounded-lg border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground">Загрузка…</div>
        ) : roles.length === 0 ? (
          <div role="status" className="rounded-lg border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground">Список пуст.</div>
        ) : (
          <div className="rounded-lg border border-border p-1"><RosterTree dense={false} editable /></div>
        )}
      </div>
    </div>
  );
}

// ---------- dialog ----------

interface Draft {
  name: string;
  kind: RoleKind;
  responsibility: string;
  icon: string;
  parentId: string;
  projectId: string | null;
  bindMode: Binding["mode"];
  threadId: string;
  threadIds: string;
  bridgeTopicId: string;
  url: string;
}

function draftFor(request: DialogRequest, roles: ResolvedRole[]): Draft | null {
  if (request.mode === "add") {
    return {
      name: "", kind: request.kind, responsibility: "", icon: "", parentId: "", projectId: request.projectId,
      bindMode: "pinned", threadId: request.threadId ?? "", threadIds: "", bridgeTopicId: "", url: "",
    };
  }
  if (request.mode === "move") return null;
  const role = roles.find((r) => r.id === request.roleId);
  if (!role) return null;
  const b = role.binding;
  return {
    name: role.name, kind: role.kind, responsibility: role.responsibility, icon: role.icon, parentId: role.parentId ?? "",
    projectId: role.projectId, bindMode: b.mode,
    threadId: b.mode === "pinned" ? b.threadId ?? "" : "",
    threadIds: b.mode === "group" ? b.threadIds.join(", ") : "",
    bridgeTopicId: b.mode === "group" && b.bridgeTopicId !== null ? String(b.bridgeTopicId) : "",
    url: b.mode === "external" ? b.url : "",
  };
}

function bindingOf(d: Draft): Binding {
  if (d.kind === "external") return { mode: "external", url: d.url.trim() };
  if (d.bindMode === "group") {
    const topic = d.bridgeTopicId.trim();
    return {
      mode: "group",
      threadIds: d.threadIds.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean),
      bridgeTopicId: topic && /^\d+$/.test(topic) ? Number(topic) : null,
    };
  }
  return { mode: "pinned", threadId: d.threadId.trim() || null };
}

const selectClass = "h-9 w-full rounded-md border border-input bg-transparent px-2 text-sm";

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="flex flex-col gap-1 text-sm">
      <span className="text-xs text-muted-foreground">{label}</span>
      {children}
    </label>
  );
}

export function RoleDialog() {
  const rpc = useRosterSync();
  const request = useStore((s) => s.dialog);
  const roles = useRoles();
  const launchDocUrl = useStore((s) => s.launchDocUrl);
  const navigate = useBbNavigate();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const fromThread = request?.mode === "add" && request.threadId !== null;
  const editing = request?.mode === "edit" ? roles?.find((r) => r.id === request.roleId) ?? null : null;

  useEffect(() => {
    setError(null);
    setDraft(request ? draftFor(request, roles ?? []) : null);
    // Only a new request resets the form; a roster refresh must not wipe typing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request]);

  const close = () => setState({ dialog: null });
  const patch = (p: Partial<Draft>) => setDraft((d) => (d ? { ...d, ...p } : d));
  const parents = (roles ?? []).filter((r) => r.id !== editing?.id && r.kind !== "external");

  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (!draft || busy) return;
    setBusy(true);
    setError(null);
    try {
      await rpc.call("roster_upsert", {
        ...(editing ? { id: editing.id } : {}),
        name: draft.name,
        kind: draft.kind,
        responsibility: draft.responsibility,
        icon: draft.icon,
        parentId: draft.parentId || null,
        projectId: draft.projectId,
        binding: bindingOf(draft),
      });
      await refresh(rpc);
      close();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };
  const removeRole = async () => {
    if (!editing || busy) return;
    setBusy(true);
    try {
      await rpc.call("roster_remove", { id: editing.id });
      await refresh(rpc);
      close();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const title = editing ? `Роль: ${editing.name}` : fromThread ? "Сделать оркестратором" : "Добавить агента";
  return (
    <Dialog open={request !== null && draft !== null} onOpenChange={(open) => { if (!open) close(); }}>
      <DialogContent className="sm:max-w-md" data-agent-roster-dialog="">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            {fromThread ? "Тред получит роль и появится в блоке «" + MODULE_NAME + "»." : "Запись — это роль: её тред может меняться, имя и значок остаются."}
          </DialogDescription>
        </DialogHeader>
        {draft ? (
          <form className="flex flex-col gap-3" onSubmit={save}>
            <Field label="Имя">
              <Input value={draft.name} required maxLength={80} autoFocus onChange={(e) => patch({ name: e.target.value })} />
            </Field>
            <Field label="За что отвечает">
              <Input value={draft.responsibility} maxLength={300} onChange={(e) => patch({ responsibility: e.target.value })} />
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Значок (эмодзи, пусто — по виду)">
                <Input value={draft.icon} maxLength={16} onChange={(e) => patch({ icon: e.target.value })} />
              </Field>
              <Field label="Вид">
                <select className={selectClass} value={draft.kind}
                  onChange={(e) => patch({ kind: e.target.value as RoleKind })}>
                  {ROLE_KINDS.filter((k) => !(fromThread && k === "external")).map((k) => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}
                </select>
              </Field>
            </div>
            <details data-agent-roster-more="" open={draft.parentId !== "" ? true : undefined} className="text-sm">
              <summary className="cursor-pointer select-none text-xs text-muted-foreground">Дополнительно</summary>
              <div className="mt-2">
                <Field label="Кому подчиняется (по умолчанию — владельцу)">
                  <select className={selectClass} value={draft.parentId} onChange={(e) => patch({ parentId: e.target.value })}>
                    <option value="">владельцу</option>
                    {parents.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
                  </select>
                </Field>
              </div>
            </details>
            {draft.kind === "external" ? (
              <Field label="Ссылка на сотрудника в другом BB">
                <Input type="url" required value={draft.url} placeholder="https://…" onChange={(e) => patch({ url: e.target.value })} />
              </Field>
            ) : fromThread ? null : (
              <>
                <Field label="Как найти действующий тред">
                  <select className={selectClass} value={draft.bindMode === "external" ? "pinned" : draft.bindMode} onChange={(e) => patch({ bindMode: e.target.value as Binding["mode"] })}>
                    <option value="pinned">закреплённый тред</option>
                    <option value="group">несколько тредов одной роли</option>
                  </select>
                </Field>
                {draft.bindMode === "group" ? (
                  <>
                    <Field label="Треды роли (через запятую)">
                      <Input value={draft.threadIds} placeholder="thr_…, thr_…" onChange={(e) => patch({ threadIds: e.target.value })} />
                    </Field>
                    <Field label="Номер темы пары у моста (пусто — последний активный)">
                      <Input value={draft.bridgeTopicId} inputMode="numeric" onChange={(e) => patch({ bridgeTopicId: e.target.value })} />
                    </Field>
                  </>
                ) : (
                  <Field label="Тред (пусто — пока без треда)">
                    <Input value={draft.threadId} placeholder="thr_…" onChange={(e) => patch({ threadId: e.target.value })} />
                  </Field>
                )}
              </>
            )}
            {!editing && !fromThread && launchDocUrl ? (
              <button type="button" className="flex items-center gap-1.5 text-left text-sm text-primary underline-offset-2 hover:underline" onClick={() => navigate.openUrl(launchDocUrl)}>
                <Icon name="ExternalLink" className="size-3.5" />
                Новый сотрудник на платформе — документ запуска
              </button>
            ) : null}
            {error ? <p role="alert" className="text-sm text-red-500">{error}</p> : null}
            <DialogFooter className="gap-2">
              {editing ? (
                <Button type="button" variant="destructive" disabled={busy} onClick={removeRole}>Снять роль</Button>
              ) : null}
              <span className="flex-1" />
              <Button type="button" variant="ghost" onClick={close}>Отмена</Button>
              <Button type="submit" disabled={busy || !draft.name.trim()}>Сохранить</Button>
            </DialogFooter>
          </form>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

/** Moves a role to another thread: pick a live thread or paste an id. */
export function MoveDialog() {
  const rpc = useRpc<typeof rpcContract>();
  const request = useStore((s) => s.dialog);
  const roles = useRoles();
  const rows = useRows();
  const role = request?.mode === "move" ? roles?.find((r) => r.id === request.roleId) ?? null : null;
  const [threadId, setThreadId] = useState("");
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { setThreadId(""); setError(null); }, [request]);
  const current = role?.active.kind === "thread" ? role.active.threadId : null;
  const choices = rows.rows.filter((r) => !r.isArchived && !r.isHidden && r.id !== current).slice(0, 200);
  const close = () => setState({ dialog: null });
  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (!role || !threadId.trim()) return;
    try {
      await rpc.call("roster_set_thread", { id: role.id, threadId: threadId.trim(), replace: current && role.binding.mode === "group" ? current : null });
      await refresh(rpc);
      close();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };
  return (
    <Dialog open={role !== null} onOpenChange={(o) => { if (!o) close(); }}>
      <DialogContent className="sm:max-w-md" data-agent-roster-move="">
        <DialogHeader>
          <DialogTitle>Перевести на другой тред</DialogTitle>
          <DialogDescription>{role ? `Роль «${role.name}» перейдёт на выбранный тред; старый тред останется как есть.` : ""}</DialogDescription>
        </DialogHeader>
        <form className="flex flex-col gap-3" onSubmit={save}>
          <Field label="Тред">
            <select className={selectClass} value={threadId} onChange={(e) => setThreadId(e.target.value)}>
              <option value="">— выбрать —</option>
              {choices.map((r) => <option key={r.id} value={r.id}>{r.title}</option>)}
            </select>
          </Field>
          <Field label="или идентификатор треда">
            <Input value={threadId} placeholder="thr_…" onChange={(e) => setThreadId(e.target.value)} />
          </Field>
          {error ? <p role="alert" className="text-sm text-red-500">{error}</p> : null}
          <DialogFooter className="gap-2">
            <Button type="button" variant="ghost" onClick={close}>Отмена</Button>
            <Button type="submit" disabled={!threadId.trim()}>Перевести</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ---------- app-wide owner ----------

/** Mounted once per window: keeps data fresh, draws the block into its spot, owns the dialog. */
export function RosterOverlay() {
  useRosterSync();
  const host = useStore((s) => s.host);
  return (
    <>
      {host ? createPortal(<SidebarBlock />, host) : null}
      <RoleDialog />
      <MoveDialog />
    </>
  );
}

function useBadge() {
  useRosterSync();
  const roles = useRoles();
  const rows = useRows();
  if (!roles) return null;
  const waiting = roles.filter((r) => summarize(r.active, rows.rows, rows.byId).state === "waiting").length;
  return waiting > 0 ? { count: waiting, tone: "warning" as const, label: `ждут владельца: ${waiting}` } : null;
}

function useActionData() {
  const rpc = useRpc<typeof rpcContract>();
  const roles = useRoles();
  return { rpc, roles: roles ?? [] };
}

export default definePluginApp((app) => {
  app.contentScripts.register({
    id: "sidebar-block",
    mount({ signal }) {
      const host = document.createElement("div");
      host.setAttribute(HOST_ATTR, "");
      host.dataset.bbPlugin = "agent-roster";
      const stopPlacing = keepPlaced(host, signal, (placed) => setState({ host: placed ? host : null }));
      const stopMarks = mountRowMarks(() => getState().roles, subscribe);
      return () => {
        stopMarks();
        stopPlacing();
        setState({ host: null });
      };
    },
  });

  app.slots.experimental_appOverlay({ id: "roster", component: RosterOverlay });

  app.slots.navPanel({
    id: "agents",
    title: MODULE_NAME,
    icon: "agent-roster/roster",
    path: PANEL_PATH,
    component: RosterPage,
    experimental_useBadge: useBadge,
  });

  app.slots.experimental_threadAction({
    id: "role",
    title: "Роль агента",
    icon: "agent-roster/crown",
    group: experimental_THREAD_ACTION_GROUPS.organize,
    order: 100,
    useData: useActionData,
    item: ({ thread, data }) => {
      const own = rolesForThread(data.roles, thread.id)[0];
      if (own) {
        return { label: "Изменить роль…", detail: own.name, icon: KIND_ICON[own.kind], run: () => openDialog({ mode: "edit", roleId: own.id }) };
      }
      return {
        label: "Сделать оркестратором…",
        icon: "agent-roster/crown",
        run: () => openDialog({ mode: "add", kind: "orchestrator", threadId: thread.id, projectId: thread.projectId }),
      };
    },
  });

  app.slots.experimental_threadAction({
    id: "remove-role",
    title: "Снять роль",
    icon: "agent-roster/crown",
    group: experimental_THREAD_ACTION_GROUPS.organize,
    order: 101,
    useData: useActionData,
    item: ({ thread, data }) => {
      const own = rolesForThread(data.roles, thread.id)[0];
      if (!own) return null;
      return {
        label: "Снять роль",
        detail: own.name,
        icon: "agent-roster/crown",
        variant: "destructive",
        run: async () => {
          await data.rpc.call("roster_remove", { id: own.id });
          await refresh(data.rpc);
        },
      };
    },
  });
});
