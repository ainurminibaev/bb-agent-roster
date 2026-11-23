import { createContext, Fragment, useCallback, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { FormEvent, ReactNode } from "react";
import { createPortal } from "react-dom";
import type * as React from "react";
import type { ExperimentalThreadRowMetadataProps, PluginSidebarThread } from "@get-bb/plugin-sdk/app";
import {
  definePluginApp,
  experimental_THREAD_ACTION_GROUPS,
  experimental_useSidebarThreads,
  experimental_useSidebarThreadSplit,
  experimental_ThreadStatusGlyph as ThreadStatusGlyph,
  experimental_resolveThreadStatus,
  useBbContext,
  useBbNavigate,
  useRealtime,
  useRpc,
} from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "./server";
import {
  type Binding,
  executorTree,
  type ExecutorNode,
  mergeOrder,
  orderRoles,
  visibleRecords,
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
    .then((r) => setState({ roles: r.roles as ResolvedRole[], launchDocUrl: r.launchDocUrl, iconMarks: r.iconMarks === true, blockLimit: typeof r.blockLimit === "number" && r.blockLimit > 0 ? r.blockLimit : 5 }))
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
  /** bb's own row, for bb's status glyph; absent for archived rows read from the server. */
  raw?: PluginSidebarThread;
  /** Latest activity (bb's update or attention time), for the block's order. */
  activeAt?: number;
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
      raw: t,
      activeAt: Math.max(Number(t.updatedAt) || 0, Number(t.latestAttentionAt) || 0),
    }));
    return { rows, byId: new Map(rows.map((r) => [r.id, r])) };
  }, [threads]);
}

// ---------- pieces ----------

/**
 * bb's own status glyph for a thread row — the same sign bb's list draws for the
 * same state (⊗ for an error or a failed queued message, the spinner for work,
 * the dot, the waiting sign). A record stands for its thread with its executors
 * as hidden subthreads, like a collapsed row. No raw row (archived, read from the
 * server) → bb's archive glyph.
 */
function BbStatus({ thread, hidden, archived, quiet }: { thread: PluginSidebarThread | undefined; hidden?: readonly PluginSidebarThread[]; archived?: boolean; quiet?: boolean }) {
  const titlesOff = useContext(CardOpen);
  if (archived || !thread) {
    return <span data-state-mark="" data-indicator="archived" className="inline-flex shrink-0"><ThreadStatusGlyph indicator="none" archived size="compact" /></span>;
  }
  const status = resolveStatus(thread, hidden ?? []);
  if (!status) return null;
  const label = indicatorLabel(status.indicator) ?? status.label ?? undefined;
  return (
    <span data-state-mark="" data-indicator={status.indicator} role="status" aria-label={label} title={titlesOff || quiet ? undefined : label} className="inline-flex shrink-0">
      <ThreadStatusGlyph indicator={status.indicator} size="compact" />
    </span>
  );
}

/** bb's own status resolution, read tolerantly: missing fields take bb's defaults; a failure draws nothing. */
const NO_ACTIVITY = { workflows: 0, backgroundAgents: 0, backgroundCommands: 0, planMode: 0 };
function safeThread(t: PluginSidebarThread): PluginSidebarThread {
  return { ...t, activity: t.activity ?? NO_ACTIVITY, queuedWork: t.queuedWork ?? "none", runtimeStatus: t.runtimeStatus ?? t.status, hasPendingInteraction: Boolean(t.hasPendingInteraction), isUnread: Boolean(t.isUnread) } as PluginSidebarThread;
}
export function resolveStatus(thread: PluginSidebarThread, hidden: readonly PluginSidebarThread[]) {
  try {
    return experimental_resolveThreadStatus({ thread: safeThread(thread), hiddenThreads: hidden.map(safeThread), hasUnsubmittedDraft: false, rowStatus: null });
  } catch {
    return null;
  }
}

/** Russian words for bb's indicators where the reason matters (card, tooltips). */
export function indicatorLabel(indicator: string): string | null {
  switch (indicator) {
    case "queued-failed": return "в очереди сообщение, которое не отправилось";
    case "unread-error": return "ошибка";
    case "waiting-for-input": return "ждёт ответа владельца";
    case "runtime": return "работает";
    case "queued-waiting": return "в очереди ждёт сообщение";
    default: return null;
  }
}

/** Live descendants of a thread among bb's rows (a record's executors). */
function descendantRows(rootId: string, rows: readonly Row[]): PluginSidebarThread[] {
  const children = new Map<string, Row[]>();
  for (const r of rows) if (r.parentThreadId && !r.isArchived) (children.get(r.parentThreadId) ?? children.set(r.parentThreadId, []).get(r.parentThreadId)!).push(r);
  const out: PluginSidebarThread[] = [];
  const stack = [...(children.get(rootId) ?? [])];
  const seen = new Set<string>([rootId]);
  while (stack.length) {
    const r = stack.pop()!;
    if (seen.has(r.id)) continue;
    seen.add(r.id);
    if (r.raw) out.push(r.raw);
    stack.push(...(children.get(r.id) ?? []));
  }
  return out;
}

/** State like bb's thread rows: a spinner while working, otherwise a dot. */
function StateMark({ state, label }: { state: RoleState; label?: string }) {
  const aria = label ?? STATE_LABEL[state];
  const title = useContext(CardOpen) ? undefined : aria;
  if (state === "running" || state === "executors") {
    return (
      <span data-state-mark="" data-spinning="" role="status" aria-label={aria} title={title} className="inline-flex size-3.5 shrink-0 items-center justify-center text-muted-foreground">
        <Icon name="Loading" className="size-3 animate-spin" />
      </span>
    );
  }
  return (
    <span data-state-mark="" role="status" aria-label={aria} title={title} className="inline-flex size-3.5 shrink-0 items-center justify-center">
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

const TELEGRAM_PATH = "M21.4 3.6 2.9 10.8c-1.2.5-1.2 1.2-.2 1.5l4.7 1.5 1.8 5.6c.2.6.4.8.9.8.4 0 .6-.2.9-.4l2.3-2.2 4.8 3.5c.9.5 1.5.2 1.7-.8L22.9 5c.3-1.3-.5-1.9-1.5-1.4Z";

function Glyph({ path, size, className, style }: { path: string; size: number; className?: string; style?: React.CSSProperties }) {
  return <svg viewBox="0 0 24 24" width={size} height={size} fill="currentColor" aria-hidden="true" className={className} style={style}><path d={path} /></svg>;
}

const CROWN_VIEWBOX = "-1 -0.5 14 11.5";
/** The crown outline; also the declared icon `agent-roster/crown` (icons/crown.svg). */
export const CROWN_PATH = "M1 4.2 3.3 6.2 6 1.8 8.7 6.2 11 4.2 9.8 10H2.2Z";
const CROWN_OUTLINE = CROWN_PATH;
const CROWN_BODY = "M1 4.2 3.3 6.2 6 1.8 8.7 6.2 11 4.2 10.1 8.2H1.9Z";
const CROWN_BAND = "M1.9 8.2H10.1L9.8 10H2.2Z";
const CROWN_TIPS = [[1, 4], [6, 1.6], [11, 4]] as const;
const GOLD_HI = "#e8c24a";
const GOLD_LO = "#8f6c0e";

/**
 * The crown — the same drawing as on thread rows (Machine Tabs): two tones,
 * balls on the points, a thin contour in the background colour. `width` is the
 * crown's visible width in px.
 */
export function Crown({ width, gold, className }: { width: number; gold?: boolean; className?: string }) {
  const k = width / 12;
  const halo = 1.1 / k;
  const hi = gold ? GOLD_HI : "color-mix(in srgb, var(--sidebar-foreground) 32%, var(--sidebar))";
  const lo = gold ? GOLD_LO : "color-mix(in srgb, var(--sidebar-foreground) 82%, transparent)";
  return (
    <svg data-crown-drawing="" viewBox={CROWN_VIEWBOX} width={14 * k} height={11.5 * k} aria-hidden="true" className={className}>
      <path d={CROWN_OUTLINE} fill="none" stroke="var(--sidebar)" strokeWidth={2 * halo} strokeLinejoin="round" />
      {CROWN_TIPS.map(([x, y]) => <circle key={x} cx={x} cy={y} r={0.95 + halo} fill="var(--sidebar)" />)}
      <path d={CROWN_BODY} fill={hi} stroke={lo} strokeWidth=".45" strokeLinejoin="round" />
      <path d={CROWN_BAND} fill={lo} />
      {CROWN_TIPS.map(([x, y]) => <circle key={`b${x}`} cx={x} cy={y} r=".95" fill={hi} stroke={lo} strokeWidth=".35" />)}
    </svg>
  );
}

/**
 * The record's sign, 24×22: the project logo (16px) wearing the crown — on the
 * logo's axis, a third of the crown over its top — the same sign as on the
 * role's thread rows, only larger. The main record is one larger gold crown.
 * A Telegram channel adds a small plane bottom right, no plate. An external
 * employee keeps the link.
 */
/**
 * The project picture, monochrome from outside, its file untouched: a PNG the way
 * Machine Tabs draws it (grayscale), an SVG as a mask filled with the text colour —
 * inside an <img> an SVG's `currentColor` is black, which turned dark logos into
 * black blots; a mask keeps only the shape, whatever fills or fill rules it uses.
 */
export function ProjectLogo({ url }: { url: string }) {
  if (url.startsWith("data:image/svg+xml")) {
    const mask = `url("${url}") center / contain no-repeat`;
    return <span data-project-logo="mask" className="absolute left-1 top-1.5 size-4 bg-current opacity-85" style={{ mask, WebkitMask: mask }} />;
  }
  return <img data-project-logo="image" src={url} alt="" className="absolute left-1 top-1.5 size-4 object-contain opacity-85" style={{ filter: "grayscale(1)" }} />;
}

export function RoleIcon({ role, className, logo, telegram }: { role: { icon: string; kind: RoleKind; primary?: boolean }; className?: string; logo?: string | null; telegram?: string | null }) {
  const titlesOff = useContext(CardOpen);
  const external = role.kind === "external";
  const base = !external && !role.primary && (role.icon || logo) ? (role.icon ? "icon" : "logo") : null;
  return (
    <span data-role-icon="" data-primary={role.primary ? "" : undefined} data-base={base ?? (external ? "link" : "crown")}
      className={cn("relative block h-[22px] w-6 shrink-0 text-muted-foreground", className)} aria-hidden="true">
      {external ? <span className="flex h-[22px] w-6 items-center justify-center"><Icon name={KIND_ICON.external} className="size-4" /></span>
        : base ? (
          <>
            {base === "icon"
              ? <span className="absolute left-1 top-1.5 flex size-4 items-center justify-center text-[14px] leading-none">{role.icon}</span>
              : <ProjectLogo url={logo!} />}
            <span data-crown="top" className="absolute left-[6.2px] top-0 leading-[0]"><Crown width={10} /></span>
          </>
        )
        : <span data-crown="alone" className="absolute left-[-1px] top-0 leading-[0]"><Crown width={role.primary ? 21 : 18} gold={role.primary} /></span>}
      {telegram ? (
        <span data-telegram-corner="" title={titlesOff ? undefined : telegram} aria-label={telegram} className="absolute -right-1 bottom-0 flex size-[11px] items-center justify-center pb-px">
          <svg viewBox="0 0 24 24" width={10} height={10} aria-hidden="true" style={{ overflow: "visible" }}>
            <path d={TELEGRAM_PATH} fill="currentColor" stroke="var(--sidebar)" strokeWidth={3} strokeLinejoin="round" paintOrder="stroke" />
          </svg>
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
          className="flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground hover:text-sidebar-foreground">
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

/** Live rows shown before "ещё N". */
export const LIVE_LIMIT = 7;

/** Service lines of the block (group labels, «ещё N», «архивные (N)», empty state, «Показать ещё»): one font, Machine Tabs' pager. */
const SERVICE_TEXT = "text-[9.5px] leading-[14px] text-muted-foreground";

function ServiceChevron({ open }: { open: boolean }) {
  return <svg viewBox="0 0 24 24" className={cn("size-2.5 shrink-0 transition-transform", open && "rotate-90")} fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m9 6 6 6-6 6" /></svg>;
}

/** An expandable service line: chevron that shows the state, hover highlight, pointer. */
function ServiceToggle({ open, onToggle, children, className, ...data }: { open: boolean; onToggle: () => void; children: ReactNode; className?: string } & Record<`data-${string}`, string>) {
  return (
    <button type="button" aria-expanded={open} {...data} onClick={onToggle}
      className={cn(SERVICE_TEXT, "inline-flex cursor-pointer items-center gap-0.5 rounded px-1 text-left hover:bg-sidebar-accent hover:text-sidebar-foreground", className)}>
      <ServiceChevron open={open} />{children}
    </button>
  );
}

function ExecutorRow({ n, byId, dense, currentThreadId }: { n: ExecutorNode; byId: Map<string, Row>; dense: boolean; currentThreadId: string | null }) {
  const title = byId.get(n.row.id)?.title ?? n.row.id;
  const raw = byId.get(n.row.id)?.raw;
  return (
    <li data-executor={n.row.id} data-depth={n.depth} data-state={n.state} data-archived={n.row.isArchived ? "" : undefined} data-active={n.row.id === currentThreadId ? "" : undefined}
      title={`${title} — ${STATE_LABEL[n.state]}${n.row.isArchived ? " (архив)" : ""}`}
      className={cn("relative flex cursor-pointer items-center gap-2 rounded-md text-[13px] text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-foreground", dense ? "h-6" : "h-7", n.row.id === currentThreadId && "bg-sidebar-accent text-sidebar-foreground")}
      style={{ paddingLeft: `${8 + (n.depth - 1) * 12}px` }}>
      <ThreadLink threadId={n.row.id} href={byId.get(n.row.id)?.href ?? null} label={`Открыть ${title}`} />
      <span className={cn("pointer-events-none min-w-0 flex-1 truncate", n.row.isArchived && "opacity-70")}>{title}</span>
      {n.hiddenBelow > 0 ? <span className="pointer-events-none shrink-0 text-[11px] tabular-nums" aria-label={`и ещё ${n.hiddenBelow} глубже`}>+{n.hiddenBelow}</span> : null}
      <span className="pointer-events-none flex h-5 w-7 shrink-0 items-center justify-center"><BbStatus thread={raw} archived={n.row.isArchived} /></span>
    </li>
  );
}

/**
 * Executors of a record, nested under it like bb's subthreads (indent + a thin guide).
 * Live = not archived, idle included — the same rule as the record's ↳N. At most
 * LIVE_LIMIT rows, then «ещё N»; archived ones behind «архивные (N)», folded each time.
 * Group labels only when both groups (managed / not managed) are there.
 */
function Executors({ role, rows, dense, others }: { role: ResolvedRole; rows: { rows: Row[]; byId: Map<string, Row> }; dense: boolean; others: string[] }) {
  const rpc = useRpc<typeof rpcContract>();
  const { threadId: currentThreadId } = useBbContext();
  const [showArchived, setShowArchived] = useState(false);
  const [showAllLive, setShowAllLive] = useState(false);
  const [archived, setArchived] = useState<Row[]>([]);
  const rootId = role.active.kind === "thread" ? role.active.threadId : null;
  useEffect(() => {
    if (!rootId) return;
    let live = true;
    Promise.resolve().then(() => rpc.call("roster_executors", { threadId: rootId })).then((r) => {
      if (!live) return;
      setArchived(r.threads.filter((t) => t.isArchived).map((t) => ({
        id: t.id, parentThreadId: t.parentThreadId, status: t.status, indicator: "none",
        hasPendingInteraction: false, isArchived: true, isHidden: false, title: t.title, projectId: null, href: null,
      })));
    }, () => undefined);
    return () => { live = false; };
  }, [rootId, rpc]);
  const all = useMemo(() => {
    if (archived.length === 0) return rows.rows;
    const known = new Set(rows.rows.map((r) => r.id));
    return [...rows.rows, ...archived.filter((r) => !known.has(r.id))];
  }, [rows.rows, archived]);
  if (!rootId) return null;
  const liveNodes = executorTree(rootId, rows.rows, false);
  const liveIds = new Set(liveNodes.map((n) => n.row.id));
  const doneNodes = executorTree(rootId, all, true).filter((n) => !liveIds.has(n.row.id));
  const byId = new Map(all.map((r) => [r.id, r]));
  const shownLive = showAllLive ? liveNodes : liveNodes.slice(0, LIVE_LIMIT);
  const bothGroups = liveNodes.length > 0 && others.length > 0;
  const label = (text: string) => <li data-agent-roster-group="" className={cn(SERVICE_TEXT, "px-1 pt-0.5")}>{text}</li>;
  const archivedToggle = doneNodes.length > 0
    ? <ServiceToggle data-agent-roster-show-finished="" open={showArchived} onToggle={() => setShowArchived((v) => !v)}>архивные ({doneNodes.length})</ServiceToggle>
    : null;
  return (
    // The whole expanded part belongs to its record: one indent, one guide under the record's icon.
    <ul data-agent-roster-executors="" className="ml-4 flex flex-col border-l border-sidebar-border pl-px">
      {liveNodes.length === 0 && others.length === 0 ? (
        <li data-agent-roster-empty="" className={cn(SERVICE_TEXT, "flex items-center gap-2 px-1 py-0.5")}>
          <span>исполнителей нет</span>{archivedToggle}
        </li>
      ) : null}
      {bothGroups ? label("под управлением") : null}
      {shownLive.map((n) => <ExecutorRow key={n.row.id} n={n} byId={byId} dense={dense} currentThreadId={currentThreadId} />)}
      {liveNodes.length > LIVE_LIMIT ? (
        <li><ServiceToggle data-agent-roster-more-live="" open={showAllLive} onToggle={() => setShowAllLive((v) => !v)}>{showAllLive ? "свернуть" : `ещё ${liveNodes.length - shownLive.length}`}</ServiceToggle></li>
      ) : null}
      {(liveNodes.length > 0 || others.length > 0) && archivedToggle ? <li>{archivedToggle}</li> : null}
      {showArchived ? <li><ul data-agent-roster-archived="" className="flex flex-col">{doneNodes.map((n) => <ExecutorRow key={n.row.id} n={n} byId={byId} dense={dense} currentThreadId={currentThreadId} />)}</ul></li> : null}
      {others.length > 0 ? (
        <>
          {bothGroups ? label("не под управлением") : null}
          {others.map((id) => (
            <li key={id} data-unmanaged={id} data-active={id === currentThreadId ? "" : undefined} title={`${rows.byId.get(id)?.title ?? id} — работает, не под управлением роли`}
              className={cn("relative flex cursor-pointer items-center gap-2 rounded-md pl-2 text-[13px] text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-foreground", dense ? "h-6" : "h-7", id === currentThreadId && "bg-sidebar-accent text-sidebar-foreground")}>
              <ThreadLink threadId={id} href={rows.byId.get(id)?.href ?? null} label={`Открыть ${rows.byId.get(id)?.title ?? id}`} />
              <span className="pointer-events-none min-w-0 flex-1 truncate">{rows.byId.get(id)?.title ?? id}</span>
              <span className="pointer-events-none flex h-5 w-7 shrink-0 items-center justify-center"><BbStatus thread={rows.byId.get(id)?.raw} /></span>
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
      className={cn("absolute inset-0 cursor-pointer rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring", className)}
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
  const [cardOpen, setCardOpen] = useState(false);
  // The card opens just under the record at the pointer's x (fixed when it opens: it does not follow the mouse).
  const pointerX = useRef(0);
  const [cardX, setCardX] = useState(0);
  const allRoles = useRoles() ?? [];
  const summary = summarize(role.active, rows.rows, rows.byId);
  const work = projectWork(role, role.active, rows.rows, allRoles);
  const anyWork = work.own.length + work.others.length > 0;
  const quietWithWork = anyWork && (summary.state === "idle" || summary.state === "waiting");
  const workLabel = `работают: свои ${work.own.length}, чужие ${work.others.length}`;
  const label = quietWithWork ? `${summaryLabel(summary)}; ${workLabel}` : summaryLabel(summary);
  const threadId = role.active.kind === "thread" ? role.active.threadId : null;
  const canExpand = threadId !== null;
  const active = threadId !== null && threadId === currentThreadId;
  const second = activity ?? (role.active.kind === "external" ? "в другом BB — откроется ссылка" : summaryLabel(summary));
  const projectName = useProjectName(role, rows);
  const projectId = useProjectId(role, rows);
  const projectLogo = useProjectLogo(projectId);
  return (
    <li data-agent-roster-role={role.id} data-state={summary.state} data-active={active ? "" : undefined}>
      <CardOpen.Provider value={cardOpen}>
      <HoverCard openDelay={450} closeDelay={200} onOpenChange={(open) => { if (open) setCardX(pointerX.current); setCardOpen(open); }}>
        <HoverCardTrigger asChild>
          <div data-agent-roster-line=""
            onPointerMove={(e) => { if (!cardOpen) pointerX.current = Math.max(0, e.clientX - e.currentTarget.getBoundingClientRect().left); }}
            className={cn("group/role relative flex cursor-pointer items-center gap-1 rounded-md py-0.5 pl-1 hover:bg-sidebar-accent", active && "bg-sidebar-accent")}>
            {threadId ? (
              <ThreadLink threadId={threadId} href={rows.byId.get(threadId)?.href ?? null} label={`Открыть ${role.name}`} />
            ) : (
              <button type="button" aria-label={`Открыть ${role.name}`} className="absolute inset-0 rounded-md"
                onClick={(e) => { if (role.active.kind === "external") navigate.openUrl(role.active.url); else openDialog({ mode: "edit", roleId: role.id }); closeMobileDrawer(e.currentTarget); }} />
            )}
            <RoleIcon role={role} logo={projectLogo} telegram={(role.channels ?? []).find((c) => c.kind === "telegram")?.label ?? null} className="pointer-events-none" />
            <span data-agent-roster-text="" className="pointer-events-none relative flex min-w-0 flex-1 flex-col">
            <span data-agent-roster-name-line="" className="pointer-events-none relative flex h-5 min-w-0 items-center gap-2 text-sm">
              {/* The project wraps to a hidden second line when fewer than ~5 characters of it fit: no lone dash. */}
              <span data-agent-roster-title="" className="flex h-5 min-w-0 flex-1 flex-wrap items-baseline overflow-hidden leading-5">
                <span className={cn("max-w-full shrink-0 truncate", active && "font-medium")}>{role.name}</span>
                {projectName ? <span data-agent-roster-project="" className="min-w-[6ch] flex-1 basis-0 truncate pl-1 text-muted-foreground">— {projectName}</span> : null}
              </span>
              <Counter own={work.own.length} others={work.others.length} total={summary.total} />
              {summary.errors > 0 ? <span className="shrink-0 text-[11px] tabular-nums text-red-500" aria-label={`с ошибкой ${summary.errors}`}>⊗{summary.errors}</span> : null}
              {summary.waitingThreadId ? (
                <button type="button" data-agent-roster-waiting="" title={cardOpen ? undefined : "Ждёт тебя: открыть тред, который ждёт твоего ответа"} aria-label="Ждёт тебя: открыть ждущий тред"
                  className="pointer-events-auto relative z-10 shrink-0 rounded-full bg-amber-500/15 px-1.5 text-[11px] font-medium leading-4 text-amber-600 hover:bg-amber-500/25"
                  onClick={(e) => { navigate.toThread(summary.waitingThreadId!); closeMobileDrawer(e.currentTarget); }}>
                  ждёт
                </button>
              ) : null}
              <button type="button" data-agent-roster-toggle="" aria-label={isOpen ? `Свернуть ${role.name}` : `Раскрыть ${role.name}`} aria-expanded={isOpen}
                title={cardOpen ? undefined : isOpen ? "Свернуть исполнителей" : "Показать исполнителей"}
                disabled={!canExpand}
                className="pointer-events-auto relative z-10 flex size-5 cursor-pointer disabled:cursor-default shrink-0 items-center justify-center rounded text-muted-foreground hover:text-sidebar-foreground disabled:opacity-30"
                onClick={() => toggleExpanded(role.id)}>
                <svg viewBox="0 0 24 24" className={cn("size-3.5 transition-transform", isOpen && "rotate-90")} fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m9 6 6 6-6 6" /></svg>
              </button>
              {/* bb's row order: chevron, then the state cell at the right edge. */}
              <span data-agent-roster-trailing="" className="flex h-5 w-7 shrink-0 items-center justify-center">
                {threadId ? <BbStatus thread={rows.byId.get(threadId)?.raw} hidden={descendantRows(threadId, rows.rows)} /> : null}
              </span>
              {/* «⋯» takes no place of its own: with a mouse it shows over the state cell on hover, on the row's hover
                  colour (bb's hover actions do the same); on touch screens it is always shown, in the flow. */}
              <span data-agent-roster-menu-slot=""
                className="pointer-events-auto invisible absolute right-0 top-0 z-20 flex h-5 items-center rounded bg-sidebar-accent group-hover/role:visible group-focus-within/role:visible has-[[data-state=open]]:visible [@media(hover:none)]:visible [@media(hover:none)]:static [@media(hover:none)]:bg-transparent">
                <RecordMenu role={role} dense={dense} projectId={projectId} onWrite={() => setWriting(true)} />
              </span>
            </span>
            {/* Part of the record's link: a press here opens the thread, expanding is the chevron's job only. */}
            <span data-agent-roster-status="" className="block h-4 w-full min-w-0 truncate pr-12 text-left text-[11px] leading-4 text-muted-foreground">
              {second}
            </span>
            </span>
          </div>
        </HoverCardTrigger>
        <HoverCardContent side="bottom" align="start" alignOffset={cardX + 8} sideOffset={2} collisionPadding={8} avoidCollisions className="w-80 p-3" data-agent-roster-card-popup="">
          <RoleCard role={role} rows={rows} />
        </HoverCardContent>
      </HoverCard>
      </CardOpen.Provider>
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

/** While a record's details card is open, its small marks show no tooltip of their own. */
const CardOpen = createContext(false);

/** One counter style, like bb's "↳N": own · others while work runs, else the muted total. */
function Counter({ own, others, total }: { own: number; others: number; total: number }) {
  const cardOpen = useContext(CardOpen);
  // ↳N is the number of executor rows the expanded record lists (live = not archived, idle included);
  // "· M" — threads of the project working outside the role, listed under «не под управлением».
  if (total + others === 0) return null;
  const text = total === 0 ? `· ${others}` : others > 0 ? `↳${total} · ${others}` : `↳${total}`;
  const aria = [total > 0 ? `исполнителей ${total}, из них работают ${own}` : null, others > 0 ? `не под управлением работают ${others}` : null].filter(Boolean).join("; ");
  return <span data-agent-roster-total="" data-count={total} title={cardOpen ? undefined : aria} aria-label={aria} className={cn("shrink-0 text-[11px] tabular-nums", own + others > 0 ? "text-muted-foreground" : "text-muted-foreground/70")}>{text}</span>;
}

/** Details of a record: the long-hover card and the "Сведения" dialog show the same. */
function RoleCard({ role, rows }: { role: ResolvedRole; rows: { rows: Row[]; byId: Map<string, Row> } }) {
  const navigate = useBbNavigate();
  const activeRaw = role.active.kind === "thread" ? rows.byId.get(role.active.threadId)?.raw : undefined;
  const stateWords = (() => {
    if (role.active.kind !== "thread") return role.active.kind === "external" ? "в другом BB" : "нет действующего треда";
    if (!activeRaw) return null;
    // The role's own thread first: a failed queued message or an error is named in words even while executors work.
    const own = resolveStatus(activeRaw, []);
    if (own && ["queued-failed", "unread-error", "waiting-for-input"].includes(own.indicator)) return indicatorLabel(own.indicator);
    const st = resolveStatus(activeRaw, descendantRows(role.active.threadId, rows.rows));
    if (!st) return null;
    return indicatorLabel(st.indicator) ?? (st.isWorking ? "работает" : "простаивает");
  })();
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
        {fact("Состояние", stateWords)}
        {role.kind === "orchestrator" ? fact("Правила", role.rulesEnabled ? "общие правила оркестратора включены" : "общие правила оркестратора выключены") : null}
        {fact("Проект", project ? (projectId && revealSupported()
          ? <button type="button" data-agent-roster-card-project="" className="text-left underline-offset-2 hover:underline" onClick={() => { if (!revealProject(projectId)) navigate.toProject(projectId); }}>{project}</button>
          : project) : null)}
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

/** How often the block may reorder itself (not while the pointer is over it or a record is open). */
const REORDER_MS = 45_000;

function anyExpanded(ids: readonly string[]): boolean {
  return ids.some((id) => expanded.has(id));
}

/** Latest activity of a record: its active thread and that thread's live executors. */
function recordActiveAt(role: ResolvedRole, rows: readonly Row[], byId: ReadonlyMap<string, Row>): number {
  if (role.active.kind !== "thread") return 0;
  const rootId = role.active.threadId;
  let at = byId.get(rootId)?.activeAt ?? 0;
  for (const r of descendantRows(rootId, rows)) if (!r.isArchived) at = Math.max(at, (r as Row).activeAt ?? 0);
  return at;
}

function RosterTree({ dense }: { dense: boolean; editable?: boolean }) {
  const roles = useRoles();
  const rows = useRows();
  const limit = useStore((s) => s.blockLimit);
  const activity = useActivity(roles ?? [], rows.byId);
  const [showAll, setShowAll] = useState(false);
  const hovered = useRef(false);
  // Fresh order: main record first, then by activity; it is applied at most every REORDER_MS
  // and never under the pointer or with a record open, so rows do not jump while being read.
  const fresh = useMemo(() => orderRoles(roles ?? [], (r) => recordActiveAt(r, rows.rows, rows.byId)).map((r) => r.id), [roles, rows]);
  const freshRef = useRef(fresh);
  freshRef.current = fresh;
  const [applied, setApplied] = useState<string[]>([]);
  useEffect(() => {
    const apply = () => {
      if (hovered.current || anyExpanded(freshRef.current)) return;
      setApplied((prev) => (prev.join() === freshRef.current.join() ? prev : freshRef.current));
    };
    apply();
    const timer = window.setInterval(apply, REORDER_MS);
    return () => window.clearInterval(timer);
  }, []);
  if (roles === null) return null;
  const byRole = new Map(roles.map((r) => [r.id, r]));
  const order = mergeOrder(applied, fresh).filter((id) => byRole.has(id));
  // A record that waits for the owner or failed is never hidden under «Показать ещё».
  const mustShow = new Set(roles.filter((r) => {
    const st = summarize(r.active, rows.rows, rows.byId);
    return st.state === "waiting" || st.state === "error" || st.errors > 0;
  }).map((r) => r.id));
  const { shown, hidden } = dense ? visibleRecords(order, limit, mustShow, showAll) : { shown: order, hidden: 0 };
  const pager = dense && (hidden > 0 || (showAll && order.length > limit));
  return (
    <>
      <ul className={cn("flex flex-col", dense && "pl-2.5")} aria-label={MODULE_NAME}
        onPointerEnter={() => { hovered.current = true; }} onPointerLeave={() => { hovered.current = false; }}>
        {shown.map((id) => {
          const role = byRole.get(id)!;
          return (
            <RoleRow key={id} node={{ role, depth: 0, children: [] }} rows={rows} dense={dense}
              activity={role.active.kind === "thread" ? activity[role.active.threadId] ?? null : null} />
          );
        })}
      </ul>
      {pager ? (
        <div data-agent-roster-pager="" className={cn(SERVICE_TEXT, "flex items-center gap-3 pl-2.5 pr-3 pt-0.5")}>
          <button type="button" data-agent-roster-show-more="" aria-expanded={showAll}
            className="inline-flex cursor-pointer items-center gap-[3px] rounded px-0.5 underline-offset-2 hover:text-sidebar-foreground hover:underline"
            onClick={() => setShowAll((v) => !v)}>
            {showAll ? "↑ Свернуть" : "↓ Показать ещё"}
          </button>
          <span data-agent-roster-page-count="" className="ml-auto text-[9px] tabular-nums opacity-70">{showAll ? order.length : order.length - hidden} / {order.length}</span>
        </div>
      ) : null}
    </>
  );
}

const ADD_REQUEST: DialogRequest = { mode: "add", kind: "orchestrator", threadId: null, projectId: null };

/** The block in the sidebar, between thread search and the thread list. */
export function SidebarBlock() {
  const roles = useRoles();
  const navigate = useBbNavigate();
  if (roles === null) return null;
  return (
    <section data-agent-roster-section="" aria-label={MODULE_NAME} className="mb-1.5 ml-2 mt-1 border-b border-border pb-1.5">
      {/* The same header line as bb's «Last 5»: x, size, weight and colour. */}
      <div data-agent-roster-header="" className="flex h-6 items-center px-1 text-xs font-semibold text-sidebar-foreground">
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
  rulesEnabled: boolean;
  /** Keep the thread title «Name — project»; null — not touched in the dialog (default by kind). */
  manageTitle: boolean | null;
}

function draftFor(request: DialogRequest, roles: ResolvedRole[]): Draft | null {
  if (request.mode === "add") {
    return {
      name: "", kind: request.kind, responsibility: "", icon: "", parentId: "", projectId: request.projectId,
      bindMode: "pinned", threadId: request.threadId ?? "", threadIds: "", bridgeTopicId: "", url: "",
      primary: false,
      rulesEnabled: true,
      manageTitle: null,
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
    rulesEnabled: role.rulesEnabled,
    manageTitle: null,
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
  const [proposalFor, setProposalFor] = useState<string | null>(null);
  const fromThread = request?.mode === "add" && request.threadId !== null;
  const editing = request?.mode === "edit" ? roles?.find((r) => r.id === request.roleId) ?? null : null;

  useEffect(() => {
    setError(null);
    setProposalFor(null);
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
      const saved = await rpc.call("roster_upsert", {
        ...(editing ? { id: editing.id } : {}),
        name: draft.name,
        kind: draft.kind,
        responsibility: draft.responsibility,
        icon: draft.icon,
        parentId: draft.parentId || null,
        projectId: draft.projectId,
        binding: bindingOf(draft),
        primary: draft.primary,
        ...(draft.kind === "orchestrator" ? { rulesEnabled: draft.rulesEnabled } : {}),
        ...(draft.manageTitle !== null && draft.kind !== "external" ? { manageTitle: draft.manageTitle } : {}),
      });
      await refresh(rpc);
      // A fresh orchestrator: offer its AGENTS.md section before closing.
      if (!editing && saved.kind === "orchestrator") setProposalFor(saved.id);
      else close();
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
        {proposalFor ? (
          <div className="flex flex-col gap-3">
            <p className="text-sm">Роль сохранена. Конкретику роли (за что отвечает, границы, куда что записывать) держим в AGENTS.md проекта — вот заготовка раздела:</p>
            <AgentsMdPanel roleId={proposalFor} />
            <DialogFooter><Button type="button" onClick={close}>Готово</Button></DialogFooter>
          </div>
        ) : draft ? (
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
            {draft.kind === "orchestrator" ? (
              <label className="flex items-start gap-2 text-sm" data-agent-roster-rules="">
                <input type="checkbox" className="mt-0.5" checked={draft.rulesEnabled} onChange={(e) => patch({ rulesEnabled: e.target.checked })} />
                <span>Общие правила оркестратора<span className="block text-xs text-muted-foreground">Короткий текст роли из плагина в инструкции треда и указатель на раздел роли в AGENTS.md проекта.</span></span>
              </label>
            ) : null}
            {draft.kind !== "external" ? (
              <label className="flex items-start gap-2 text-sm" data-agent-roster-title-switch="">
                <input type="checkbox" className="mt-0.5"
                  checked={draft.manageTitle ?? (editing && editing.kind === draft.kind ? editing.manageTitle : draft.kind === "orchestrator")}
                  onChange={(e) => patch({ manageTitle: e.target.checked })} />
                <span>Вести название треда<span className="block text-xs text-muted-foreground">Название действующего треда — «Имя — проект»; прежнее вернётся, когда роль уйдёт с треда. У агента обычно выключено: его треды называет платформа или мост.</span></span>
              </label>
            ) : null}
            {editing && editing.kind === "orchestrator" ? (
              <details className="text-sm">
                <summary className="cursor-pointer select-none text-xs text-muted-foreground">Раздел роли в AGENTS.md</summary>
                <div className="mt-2"><AgentsMdPanel roleId={editing.id} /></div>
              </details>
            ) : null}
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

/** Proposes the role's AGENTS.md section: shows it and appends it on request; never rewrites an existing one. */
function AgentsMdPanel({ roleId }: { roleId: string }) {
  const rpc = useRpc<typeof rpcContract>();
  const [info, setInfo] = useState<{ status: string; path: string | null; section: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let live = true;
    rpc.call("roster_agents_md", { roleId, append: false }).then((r) => { if (live) setInfo(r); }, (e) => { if (live) setError(String(e?.message ?? e)); });
    return () => { live = false; };
  }, [rpc, roleId]);
  const append = async () => {
    setBusy(true);
    try { setInfo(await rpc.call("roster_agents_md", { roleId, append: true })); } catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  };
  if (error) return <p className="text-xs text-red-500">{error}</p>;
  if (!info) return <p className="text-xs text-muted-foreground">Проверяю AGENTS.md…</p>;
  const note: Record<string, string> = {
    "no-project": "У роли не указан проект с папкой — дописать некуда. Скопируй заготовку сам.",
    "no-file": `AGENTS.md нет (${info.path}). Кнопка создаст файл с этим разделом.`,
    missing: `Раздела нет в ${info.path}. Кнопка допишет его в конец файла; остальное не меняется, коммит не делается.`,
    present: `Раздел уже есть в ${info.path} — плагин его не трогает.`,
    appended: `Раздел дописан в конец ${info.path}. Поправь его и закоммить сам.`,
  };
  return (
    <div data-agent-roster-agents-md={info.status} className="flex flex-col gap-2">
      <p className="text-xs text-muted-foreground">{note[info.status] ?? ""}</p>
      {info.status !== "present" ? <pre className="max-h-48 overflow-auto whitespace-pre-wrap rounded-md border border-border bg-muted/40 p-2 text-xs">{info.section}</pre> : null}
      {info.status === "missing" || info.status === "no-file" ? (
        <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => void append()}>Дописать раздел в AGENTS.md</Button>
      ) : null}
    </div>
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
