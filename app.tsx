import { Fragment, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { FormEvent, ReactNode } from "react";
import { createPortal } from "react-dom";
import type { ExperimentalThreadRowMetadataProps } from "@get-bb/plugin-sdk/app";
import {
  definePluginApp,
  experimental_THREAD_ACTION_GROUPS,
  experimental_useSidebarThreads,
  experimental_useSidebarThreadSplit,
  useBbContext,
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
  rowMarkFor,
  projectWork,
  rolesForThread,
  type RowFacts,
  STATE_LABEL,
  type TreeNode,
} from "./model";
import { getState, openDialog, setState, subscribe, useStore, type DialogRequest } from "./lib/store";
import { HOST_ATTR, keepPlaced } from "./lib/anchor";
import { revealProject, revealSupported } from "./lib/reveal";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "@/components/ui/hover-card";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
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
    .then((r) => setState({ roles: r.roles as ResolvedRole[], launchDocUrl: r.launchDocUrl, iconMarks: r.iconMarks === true }))
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
  href: string | null;
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
      href: typeof t.href === "string" ? t.href : null,
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
      <span data-state-mark="" data-spinning="" role="status" aria-label={aria} title={aria} className="inline-flex size-3.5 shrink-0 items-center justify-center text-muted-foreground">
        <Icon name="Loading" className="size-3 animate-spin" />
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
  external: "bg-muted-foreground/40",
};

/**
 * The one channel mark of the plugin (block, page, details card): Telegram's
 * paper plane from its mark, filled with the muted text colour. Not a role icon.
 */
export function ChannelMark({ label }: { label: string }) {
  return (
    <span data-agent-roster-channel="telegram" role="img" aria-label={label} title={label} className="inline-flex size-3.5 shrink-0 items-center justify-center text-muted-foreground">
      <svg viewBox="0 0 24 24" className="size-3" fill="currentColor" aria-hidden="true">
        <path d="M21.4 3.6 2.9 10.8c-1.2.5-1.2 1.2-.2 1.5l4.7 1.5 1.8 5.6c.2.6.4.8.9.8.4 0 .6-.2.9-.4l2.3-2.2 4.8 3.5c.9.5 1.5.2 1.7-.8L22.9 5c.3-1.3-.5-1.9-1.5-1.4Zm-3.3 3.6-8.9 8-.4 3.7-1.5-4.7 10.4-6.6c.5-.3.8 0 .4.4Z" />
      </svg>
    </span>
  );
}

/** The only colour the plugin draws: the main record's crown — one calm gold for light and dark themes. */
export const GOLD = "#c9a227";

/**
 * One role icon. Main picture: the owner's own icon if set, else the project's
 * logo (monochrome), else the role mark itself — the crown (gold for the main
 * record), or the link glyph for an external employee. When the main picture is
 * not the crown, the crown sits small in the corner.
 */
export function RoleIcon({ role, className, logo }: { role: { icon: string; kind: RoleKind; primary?: boolean }; className?: string; logo?: string | null }) {
  const external = role.kind === "external";
  const useLogo = !role.icon && !external && !!logo;
  const corner = !external && (role.icon || useLogo);
  const crownStyle = role.primary ? { color: GOLD } : undefined;
  return (
    <span data-role-icon="" data-primary={role.primary ? "" : undefined} className={cn("relative inline-flex size-4 shrink-0 items-center justify-center", className)} aria-hidden="true">
      {role.icon ? <span className="text-[13px] leading-none">{role.icon}</span>
        : useLogo ? <img src={logo!} alt="" className="size-4 rounded-[4px] object-contain opacity-80" style={{ filter: "grayscale(1)" }} />
        : <span className="inline-flex" style={crownStyle}><Icon name={KIND_ICON[role.kind]} className="size-4" /></span>}
      {corner ? (
        <span data-kind-corner="" className="absolute -bottom-1 -right-1 flex size-[11px] items-center justify-center rounded-full bg-sidebar text-muted-foreground" style={crownStyle}>
          <Icon name={KIND_ICON[role.kind]} className="size-[9px]" />
        </span>
      ) : null}
    </span>
  );
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

function RecordMenu({ role, dense, projectId, onWrite }: { role: ResolvedRole; dense: boolean; projectId?: string | null; onWrite: () => void }) {
  const rpc = useRpc<typeof rpcContract>();
  const open = useOpenRole();
  const navigate = useBbNavigate();
  const items: { id: string; label: string; run: () => void; danger?: boolean; disabled?: boolean }[] = [
    { id: "open", label: "Открыть", run: () => open(role) },
    { id: "write", label: "Написать…", run: onWrite, disabled: role.active.kind !== "thread" },
    { id: "details", label: "Сведения", run: () => openDialog({ mode: "details", roleId: role.id }) },
    ...(projectId && revealSupported() ? [{ id: "reveal", label: "Перейти к проекту", run: () => { if (!revealProject(projectId)) navigate.toProject(projectId); } }] : []),
    { id: "edit", label: "Изменить роль…", run: () => openDialog({ mode: "edit", roleId: role.id }) },
    { id: "move", label: "Перевести на другой тред…", run: () => openDialog({ mode: "move", roleId: role.id }), disabled: role.kind === "external" },
    { id: "remove", label: "Снять роль", danger: true, run: () => { void rpc.call("roster_remove", { id: role.id }).then(() => refresh(rpc)); } },
  ];
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button type="button" aria-label={`Действия: ${role.name}`} data-agent-roster-menu-button=""
          className={cn("size-5 shrink-0 items-center justify-center rounded text-muted-foreground hover:text-sidebar-foreground data-[state=open]:flex", dense ? "hidden group-hover/role:flex group-focus-within/role:flex" : "flex")}>
          <svg viewBox="0 0 24 24" className="size-3.5" fill="currentColor" aria-hidden="true"><circle cx="5" cy="12" r="1.8" /><circle cx="12" cy="12" r="1.8" /><circle cx="19" cy="12" r="1.8" /></svg>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" data-agent-roster-menu="">
        {items.map((item, i) => (
          <Fragment key={item.id}>
            {item.danger && i > 0 ? <DropdownMenuSeparator /> : null}
            <DropdownMenuItem disabled={item.disabled} className={cn(item.danger && "text-red-500")} onSelect={() => item.run()}>{item.label}</DropdownMenuItem>
          </Fragment>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** "Сведения": the same card as the long hover, for phones where there is no hover. */
export function DetailsDialog() {
  const request = useStore((s) => s.dialog);
  const roles = useRoles();
  const rows = useRows();
  const role = request?.mode === "details" ? roles?.find((r) => r.id === request.roleId) ?? null : null;
  return (
    <Dialog open={role !== null} onOpenChange={(o) => { if (!o) setState({ dialog: null }); }}>
      <DialogContent className="sm:max-w-sm" data-agent-roster-details="">
        <DialogHeader><DialogTitle>Сведения</DialogTitle><DialogDescription className="sr-only">Сведения о записи</DialogDescription></DialogHeader>
        {role ? <RoleCard role={role} rows={rows} /> : null}
      </DialogContent>
    </Dialog>
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
  const rpc = useRpc<typeof rpcContract>();
  const { threadId: currentThreadId } = useBbContext();
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
        hasPendingInteraction: false, isArchived: true, isHidden: false, title: t.title, projectId: null, href: null,
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
    <li className="pt-1 text-[11px] text-muted-foreground/80" style={{ paddingLeft: dense ? 36 : 40 }}>{text}</li>
  );
  return (
    <ul data-agent-roster-executors="" className="flex flex-col">
      {groupLabel("под управлением")}
      {nodes.map((n) => (
        <li key={n.row.id} data-executor={n.row.id} data-depth={n.depth} data-state={n.state} data-active={n.row.id === currentThreadId ? "" : undefined}
          title={`${(byId.get(n.row.id) as Row | undefined)?.title ?? n.row.id} — ${STATE_LABEL[n.state]}${n.row.isArchived ? " (архив)" : ""}`}
          className={cn("relative flex items-center gap-1.5 rounded-md text-[13px] text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-foreground", dense ? "h-6" : "h-8", n.row.id === currentThreadId && "bg-sidebar-accent text-sidebar-foreground")}
          style={{ paddingLeft: `${(dense ? 36 : 40) + (n.depth - 1) * 14}px`, paddingRight: 8 }}>
          <ThreadLink threadId={n.row.id} href={(byId.get(n.row.id) as Row | undefined)?.href ?? null} label={`Открыть ${(byId.get(n.row.id) as Row | undefined)?.title ?? n.row.id}`} />
          <span className={cn("pointer-events-none min-w-0 flex-1 truncate", n.row.isArchived && "line-through opacity-70")}>{(byId.get(n.row.id) as Row | undefined)?.title ?? n.row.id}</span>
          {n.hiddenBelow > 0 ? <span className="pointer-events-none shrink-0 text-[11px]">ещё {n.hiddenBelow}</span> : null}
          <span className="pointer-events-none flex"><StateMark state={n.state} /></span>
        </li>
      ))}
      {nodes.length === 0 ? (
        <li className="truncate py-0.5 text-[12px] text-muted-foreground/80" style={{ paddingLeft: dense ? 36 : 40 }}>{showFinished ? "исполнителей нет" : "сейчас никто не работает"}</li>
      ) : null}
      <li>
        <button type="button" data-agent-roster-show-finished="" className="block w-full truncate py-0.5 text-left text-[11px] text-muted-foreground/80 underline-offset-2 hover:underline" style={{ paddingLeft: dense ? 36 : 40 }}
          onClick={() => setShowFinished((v) => !v)}>
          {showFinished ? "скрыть завершённые" : `завершённые и архивные${finished > 0 ? ` (${finished}+)` : ""}`}
        </button>
      </li>
      {others.length > 0 ? (
        <>
          {groupLabel("не под управлением")}
          {others.map((id) => (
            <li key={id} data-unmanaged={id} data-active={id === currentThreadId ? "" : undefined} title={`${rows.byId.get(id)?.title ?? id} — работает, не под управлением роли`}
              className={cn("relative flex items-center gap-1.5 rounded-md text-[13px] text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-foreground", dense ? "h-6" : "h-8", id === currentThreadId && "bg-sidebar-accent text-sidebar-foreground")}
              style={{ paddingLeft: dense ? 36 : 40, paddingRight: 8 }}>
              <ThreadLink threadId={id} href={rows.byId.get(id)?.href ?? null} label={`Открыть ${rows.byId.get(id)?.title ?? id}`} />
              <span className="pointer-events-none min-w-0 flex-1 truncate">{rows.byId.get(id)?.title ?? id}</span>
              <span className="pointer-events-none flex"><StateMark state="running" /></span>
            </li>
          ))}
        </>
      ) : null}
    </ul>
  );
}

/** Close the phone sidebar drawer after opening a thread, the way bb's own rows do (its Escape close). */
function closeMobileDrawer(from: Element | null) {
  const drawer = from?.closest('[role="dialog"][data-state="open"]');
  if (!drawer) return;
  const esc = new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true, cancelable: true });
  (drawer as HTMLElement).dispatchEvent(esc);
}

/**
 * A link that behaves like bb's thread row: plain click opens the thread in the
 * main view, Cmd/Ctrl-click opens a split, dragging uses bb's split gesture,
 * middle click and "open in new tab" use the real href; on a phone the sidebar
 * drawer closes.
 */
function ThreadLink({ threadId, href, label, className }: { threadId: string; href: string | null; label: string; className?: string }) {
  const navigate = useBbNavigate();
  const split = experimental_useSidebarThreadSplit(threadId);
  return (
    <a href={href ?? undefined} draggable={false} aria-label={label} data-agent-roster-link={threadId}
      {...split.splitProps}
      className={cn("absolute inset-0 rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring", className)}
      onClick={(event) => {
        if (event.button !== 0 || event.shiftKey || event.altKey) return;
        event.preventDefault();
        if ((event.metaKey || event.ctrlKey) && split.isAvailable) { navigate.toThread(threadId, { split: true }); return; }
        navigate.toThread(threadId);
        closeMobileDrawer(event.currentTarget);
      }} />
  );
}

function RoleRow({ node, rows, activity, dense }: RowProps) {
  const { role } = node;
  const navigate = useBbNavigate();
  const { threadId: currentThreadId } = useBbContext();
  const isOpen = useExpanded(role.id);
  const [writing, setWriting] = useState(false);
  const allRoles = useRoles() ?? [];
  const summary = summarize(role.active, rows.rows, rows.byId);
  const work = projectWork(role, role.active, rows.rows, allRoles);
  const anyWork = work.own.length + work.others.length > 0;
  const quietWithWork = anyWork && (summary.state === "idle" || summary.state === "waiting");
  const workLabel = `работают: свои ${work.own.length}, чужие ${work.others.length}`;
  const label = quietWithWork ? `${summaryLabel(summary)}; ${workLabel}` : summaryLabel(summary);
  const short = `${role.name} — ${KIND_LABEL[role.kind]}; ${label}`;
  const threadId = role.active.kind === "thread" ? role.active.threadId : null;
  const canExpand = threadId !== null;
  const active = threadId !== null && threadId === currentThreadId;
  const second = activity ?? (role.active.kind === "external" ? "в другом BB — откроется ссылка" : summaryLabel(summary));
  const leftPad = dense ? 12 : 16;
  const projectName = useProjectName(role, rows);
  const projectId = useProjectId(role, rows);
  const projectLogo = useProjectLogo(projectId);
  return (
    <li data-agent-roster-role={role.id} data-state={summary.state} data-active={active ? "" : undefined}>
      <HoverCard openDelay={900} closeDelay={120}>
        <HoverCardTrigger asChild>
          <div data-agent-roster-line="" title={short}
            className={cn("group/role relative flex flex-col justify-center rounded-md py-1 pr-1 hover:bg-sidebar-accent", active && "bg-sidebar-accent")}
            style={{ paddingLeft: leftPad }}>
            {threadId ? (
              <ThreadLink threadId={threadId} href={rows.byId.get(threadId)?.href ?? null} label={`Открыть ${role.name}`} />
            ) : (
              <button type="button" aria-label={`Открыть ${role.name}`} className="absolute inset-0 rounded-md"
                onClick={(e) => { if (role.active.kind === "external") navigate.openUrl(role.active.url); else openDialog({ mode: "edit", roleId: role.id }); closeMobileDrawer(e.currentTarget); }} />
            )}
            <span data-agent-roster-name-line="" className="pointer-events-none relative flex h-5 min-w-0 items-center gap-2 text-sm">
              <RoleIcon role={role} logo={projectLogo} />
              {/* The project wraps to a hidden second line when fewer than ~5 characters of it fit: no lone dash. */}
              <span data-agent-roster-title="" className="flex h-5 min-w-0 flex-1 flex-wrap items-baseline overflow-hidden leading-5">
                <span className={cn("max-w-full shrink-0 truncate", active && "font-medium")}>{role.name}</span>
                {projectName ? <span data-agent-roster-project="" className="min-w-[6ch] flex-1 basis-0 truncate pl-1 text-muted-foreground">— {projectName}</span> : null}
              </span>
              <Counter own={work.own.length} others={work.others.length} total={summary.total} />
              {summary.errors > 0 ? <span className="shrink-0 text-[11px] tabular-nums text-red-500" aria-label={`с ошибкой ${summary.errors}`}>⊗{summary.errors}</span> : null}
              {summary.waitingThreadId ? (
                <button type="button" data-agent-roster-waiting="" title="Ждёт тебя: открыть тред, который ждёт твоего ответа" aria-label="Ждёт тебя: открыть ждущий тред"
                  className="pointer-events-auto relative z-10 shrink-0 rounded-full bg-amber-500/15 px-1.5 text-[11px] font-medium leading-4 text-amber-600 hover:bg-amber-500/25"
                  onClick={(e) => { navigate.toThread(summary.waitingThreadId!); closeMobileDrawer(e.currentTarget); }}>
                  ждёт
                </button>
              ) : null}
              {(role.channels ?? []).map((c) => <ChannelMark key={c.kind} label={c.label} />)}
              <StateMark state={summary.state} label={label} />
              <button type="button" data-agent-roster-toggle="" aria-label={isOpen ? `Свернуть ${role.name}` : `Раскрыть ${role.name}`} aria-expanded={isOpen}
                disabled={!canExpand}
                className="pointer-events-auto relative z-10 flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground hover:text-sidebar-foreground disabled:opacity-30"
                onClick={() => toggleExpanded(role.id)}>
                <svg viewBox="0 0 24 24" className={cn("size-3.5 transition-transform", isOpen && "rotate-90")} fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m9 6 6 6-6 6" /></svg>
              </button>
              {projectId && revealSupported() ? (
                <button type="button" data-agent-roster-reveal="" aria-label={`Перейти к проекту${projectName ? ` ${projectName}` : ""}`} title="Перейти к проекту в списке"
                  className="pointer-events-auto relative z-10 hidden size-5 shrink-0 items-center justify-center rounded text-muted-foreground hover:text-sidebar-foreground group-hover/role:flex"
                  onClick={() => { if (!revealProject(projectId)) navigate.toProject(projectId); }}>
                  <svg viewBox="0 0 24 24" className="size-3.5" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3 7h6l2 2h10v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /><path d="M12 13h6M15 10l3 3-3 3" /></svg>
                </button>
              ) : null}
              <span className="pointer-events-auto relative z-10 flex"><RecordMenu role={role} dense={dense} projectId={projectId} onWrite={() => setWriting(true)} /></span>
            </span>
            <button type="button" data-agent-roster-status="" disabled={!canExpand} aria-label={`${second}. ${isOpen ? "Свернуть" : "Раскрыть"} исполнителей`}
              className="relative z-10 block h-4 w-full min-w-0 truncate pr-12 text-left text-[11px] leading-4 text-muted-foreground disabled:cursor-default"
              style={{ paddingLeft: 24 }}
              onClick={() => toggleExpanded(role.id)}>
              {second}
            </button>
          </div>
        </HoverCardTrigger>
        <HoverCardContent side="right" align="start" className="w-80 p-3" data-agent-roster-card-popup="">
          <RoleCard role={role} rows={rows} />
        </HoverCardContent>
      </HoverCard>
      {writing ? <QuickMessage role={role} onDone={() => setWriting(false)} /> : null}
      {isOpen ? <Executors role={role} rows={rows} dense={dense} others={work.others} /> : null}
    </li>
  );
}

function useProjectId(role: ResolvedRole, rows: { byId: Map<string, Row> }): string | null {
  const threadId = role.active.kind === "thread" ? role.active.threadId : null;
  return role.projectId ?? (threadId ? rows.byId.get(threadId)?.projectId ?? null : null);
}

/** Project logos, fetched once per set of projects and shared by every row. */
let logoCache: Record<string, string | null> = {};
const logoListeners = new Set<() => void>();
const logoAsked = new Set<string>();
function useProjectLogo(projectId: string | null): string | null {
  const rpc = useRpc<typeof rpcContract>();
  const value = useSyncExternalStore(
    (fn) => { logoListeners.add(fn); return () => logoListeners.delete(fn); },
    () => (projectId ? logoCache[projectId] ?? null : null),
    () => null,
  );
  useEffect(() => {
    if (!projectId || logoAsked.has(projectId)) return;
    logoAsked.add(projectId);
    Promise.resolve().then(() => rpc.call("roster_project_icons", { projectIds: [projectId] })).then((r) => {
      logoCache = { ...logoCache, ...r };
      for (const fn of [...logoListeners]) fn();
    }, () => undefined);
  }, [rpc, projectId]);
  return value;
}

/** The role's project name as bb lists it: the role's project, else its active thread's. */
function useProjectName(role: ResolvedRole, rows: { byId: Map<string, Row> }): string | null {
  const { projects } = experimental_useSidebarThreads();
  const threadId = role.active.kind === "thread" ? role.active.threadId : null;
  const projectId = role.projectId ?? (threadId ? rows.byId.get(threadId)?.projectId ?? null : null);
  if (!projectId) return null;
  return (projects ?? []).find((p) => p.id === projectId)?.name ?? null;
}

/** One counter style, like bb's "↳N": own · others while work runs, else the muted total. */
function Counter({ own, others, total }: { own: number; others: number; total: number }) {
  if (own + others > 0) {
    const text = own === 0 ? `· ${others}` : others > 0 ? `↳${own} · ${others}` : `↳${own}`;
    const aria = own === 0 ? `не под управлением работают: ${others}` : `работают: свои ${own}${others > 0 ? `, чужие ${others}` : ""}`;
    return <span data-agent-roster-work="" title={aria} aria-label={aria} className="shrink-0 text-[11px] tabular-nums text-muted-foreground">{text}</span>;
  }
  if (total > 0) return <span data-agent-roster-total="" aria-label={`исполнителей ${total}`} className="shrink-0 text-[11px] tabular-nums text-muted-foreground/70">↳{total}</span>;
  return null;
}

/** Details of a record: the long-hover card and the "Сведения" dialog show the same. */
function RoleCard({ role, rows }: { role: ResolvedRole; rows: { rows: Row[]; byId: Map<string, Row> } }) {
  const rpc = useRpc<typeof rpcContract>();
  const { projects } = experimental_useSidebarThreads();
  const allRoles = useRoles() ?? [];
  const [details, setDetails] = useState<{ activity: string | null; model: string | null; providerId: string | null; lastActiveAt: number | null } | null>(null);
  const threadId = role.active.kind === "thread" ? role.active.threadId : null;
  useEffect(() => {
    if (!threadId) return;
    let live = true;
    rpc.call("roster_details", { threadId }).then((d) => { if (live) setDetails(d); }, () => undefined);
    return () => { live = false; };
  }, [rpc, threadId]);
  const summary = summarize(role.active, rows.rows, rows.byId);
  const work = projectWork(role, role.active, rows.rows, allRoles);
  const projectId = role.projectId ?? (threadId ? rows.byId.get(threadId)?.projectId ?? null : null);
  const project = (projects ?? []).find((p) => p.id === projectId)?.name ?? projectId;
  const waitingTitle = summary.waitingThreadId ? rows.byId.get(summary.waitingThreadId)?.title ?? summary.waitingThreadId : null;
  const fact = (label: string, value: ReactNode) => (value ? <div className="flex gap-2"><dt className="w-24 shrink-0 text-muted-foreground">{label}</dt><dd className="min-w-0 flex-1 break-words">{value}</dd></div> : null);
  const when = details?.lastActiveAt ? new Date(details.lastActiveAt).toLocaleString() : null;
  return (
    <div data-agent-roster-card="" className="flex flex-col gap-2 text-xs">
      <div className="flex items-center gap-2 text-sm font-medium"><RoleIcon role={role} /><span className="truncate">{role.name}</span><span className="text-xs font-normal text-muted-foreground">{KIND_LABEL[role.kind]}{role.primary ? " · главная" : ""}</span></div>
      <dl className="flex flex-col gap-1">
        {fact("Отвечает за", role.responsibility)}
        {fact("Подчиняется", role.parentName ?? "владельцу")}
        {fact("Проект", project)}
        {fact("Тред", threadId ? rows.byId.get(threadId)?.title ?? threadId : role.active.kind === "external" ? role.active.url : "нет действующего")}
        {fact("Сейчас", details?.activity ?? null)}
        {fact("Исполнители", `свои работают ${work.own.length}, чужие ${work.others.length}; всего под ролью ${summary.total}${summary.errors ? `, с ошибкой ${summary.errors}` : ""}`)}
        {fact("Ждёт тебя", waitingTitle)}
        {fact("Каналы", (role.channels ?? []).length ? <span className="flex flex-col gap-0.5">{(role.channels ?? []).map((c) => <span key={c.kind} className="flex items-center gap-1"><ChannelMark label={c.label} />{c.label}</span>)}</span> : null)}
        {fact("Модель", [details?.providerId, details?.model].filter(Boolean).join(" · ") || null)}
        {fact("Активность", when)}
      </dl>
    </div>
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
  primary: boolean;
}

function draftFor(request: DialogRequest, roles: ResolvedRole[]): Draft | null {
  if (request.mode === "add") {
    return {
      name: "", kind: request.kind, responsibility: "", icon: "", parentId: "", projectId: request.projectId,
      bindMode: "pinned", threadId: request.threadId ?? "", threadIds: "", bridgeTopicId: "", url: "",
      primary: false,
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
    primary: role.primary,
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
        primary: draft.primary,
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
            <details data-agent-roster-more="" open={draft.parentId !== "" || draft.primary ? true : undefined} className="text-sm">
              <summary className="cursor-pointer select-none text-xs text-muted-foreground">Дополнительно</summary>
              <div className="mt-2 flex flex-col gap-3">
                <label className="flex items-start gap-2 text-sm" data-agent-roster-primary="">
                  <input type="checkbox" className="mt-0.5" checked={draft.primary} onChange={(e) => patch({ primary: e.target.checked })} />
                  <span>Главная запись<span className="block text-xs text-muted-foreground">Золотая корона. Главной может быть только одна запись: отметка снимется с прежней.</span></span>
                </label>
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
      <DetailsDialog />
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

/**
 * The one role mark on a thread row: a small monochrome glyph on the row's
 * metadata line after the title, beside bb's own "↳N". Nothing before the title,
 * nothing in place of bb's state glyph. Machine Tabs always shows this line; bb's
 * own list shows it with Rows → Metadata on (otherwise the role is seen in the block).
 */
function RoleMark({ thread, data }: ExperimentalThreadRowMetadataProps<ResolvedRole[] | null>) {
  const iconMarks = useStore((s) => s.iconMarks);
  const mark = data ? rowMarkFor(data, thread.id) : null;
  // Machine Tabs already shows the role on the thread icon: one mark per row.
  if (!mark || iconMarks) return null;
  return (
    <span data-agent-roster-mark="" data-tone={mark.tone} data-reserve={mark.reserve ? "" : undefined} role="img" aria-label={mark.label} title={mark.label}
      className={cn("inline-flex items-center", mark.tone === "neutral" && "text-muted-foreground", mark.reserve && "opacity-45")}
      style={mark.tone === "accent" ? { color: GOLD } : undefined}>
      <Icon name={mark.glyph === "link" ? "agent-roster/external" : "agent-roster/crown"} className="size-3" />
    </span>
  );
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
      return () => {
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

  app.slots.experimental_threadRowMetadata<ResolvedRole[] | null>({
    id: "role-mark",
    order: 1,
    useData: useRoles,
    component: RoleMark,
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
