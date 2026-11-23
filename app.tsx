import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import type { ExperimentalThreadRowMetadataProps } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "./server";
import {
  type Binding,
  buildTree,
  executorCounts,
  flattenTree,
  KIND_ICON,
  KIND_LABEL,
  MODULE_NAME,
  type ResolvedRole,
  ROLE_KINDS,
  type RoleKind,
  roleState,
  type RoleState,
  rolesForThread,
  type RowFacts,
  STATE_LABEL,
  type TreeNode,
} from "./model";
import { getState, openDialog, setState, subscribe, useStore, type DialogRequest } from "./lib/store";
import { HOST_ATTR, keepPlaced } from "./lib/anchor";
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
function useRows(): { rows: RowFacts[]; byId: Map<string, RowFacts> } {
  const { threads } = experimental_useSidebarThreads();
  return useMemo(() => {
    const rows: RowFacts[] = (threads ?? []).map((t) => ({
      id: t.id,
      parentThreadId: t.parentThreadId,
      status: String(t.status),
      indicator: String(t.indicator),
      hasPendingInteraction: Boolean(t.hasPendingInteraction),
      isArchived: Boolean(t.isArchived),
      isHidden: Boolean(t.isHidden),
    }));
    return { rows, byId: new Map(rows.map((r) => [r.id, r])) };
  }, [threads]);
}

// ---------- pieces ----------

const STATE_CLASS: Record<RoleState, string> = {
  running: "bg-sky-500 animate-pulse",
  waiting: "bg-amber-500",
  error: "bg-red-500",
  idle: "bg-muted-foreground/40",
  none: "border border-muted-foreground/50 bg-transparent",
  external: "bg-violet-400",
};

export function RoleIcon({ role, className }: { role: { icon: string; kind: RoleKind }; className?: string }) {
  if (role.icon) return <span className={cn("inline-flex w-4 shrink-0 justify-center text-[13px] leading-none", className)} aria-hidden="true">{role.icon}</span>;
  return <Icon name={KIND_ICON[role.kind]} className={cn("size-4 shrink-0", className)} aria-hidden="true" />;
}

function RoleRow({ node, rows, onOpen, onEdit, dense }: {
  node: TreeNode<ResolvedRole>;
  rows: { rows: RowFacts[]; byId: Map<string, RowFacts> };
  onOpen: (role: ResolvedRole) => void;
  onEdit?: (role: ResolvedRole) => void;
  dense: boolean;
}) {
  const { role, depth } = node;
  const state = roleState(role.active, rows.byId);
  const counts = role.active.kind === "thread" ? executorCounts(role.active.threadId, rows.rows) : { total: 0, errors: 0 };
  const title = [
    `${role.name} — ${KIND_LABEL[role.kind]}`,
    role.responsibility,
    `Состояние: ${STATE_LABEL[state]}`,
    counts.total ? `Исполнителей: ${counts.total}${counts.errors ? `, с ошибкой: ${counts.errors}` : ""}` : "",
  ].filter(Boolean).join("\n");
  return (
    <li data-agent-roster-role={role.id} data-state={state} className="group/role flex items-center">
      <button
        type="button"
        title={title}
        onClick={() => onOpen(role)}
        className={cn(
          "flex min-w-0 flex-1 items-center gap-1.5 rounded-md text-left text-sm hover:bg-sidebar-accent focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring",
          dense ? "h-7 px-2" : "h-9 px-3",
        )}
        style={{ paddingLeft: `${(dense ? 8 : 12) + depth * 14}px` }}
      >
        <RoleIcon role={role} />
        <span className="min-w-0 flex-1 truncate">{role.name}</span>
        {counts.total > 0 ? (
          <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground" aria-label={`исполнителей ${counts.total}`}>
            ↳{counts.total}
            {counts.errors > 0 ? <span className="ml-1 text-red-500" aria-label={`с ошибкой ${counts.errors}`}>⊗{counts.errors}</span> : null}
          </span>
        ) : null}
        <span className={cn("size-2 shrink-0 rounded-full", STATE_CLASS[state])} role="img" aria-label={STATE_LABEL[state]} />
        {!dense ? <span className="hidden w-32 shrink-0 truncate text-xs text-muted-foreground sm:inline">{STATE_LABEL[state]}</span> : null}
      </button>
      {onEdit ? (
        <Button variant="ghost" size="icon" className="size-8 shrink-0 text-muted-foreground" aria-label={`Настроить ${role.name}`} onClick={() => onEdit(role)}>
          <Icon name="agent-roster/edit" className="size-4" />
        </Button>
      ) : null}
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

function RosterTree({ dense, editable }: { dense: boolean; editable: boolean }) {
  const roles = useRoles();
  const rows = useRows();
  const open = useOpenRole();
  const flat = useMemo(() => flattenTree(buildTree(roles ?? [])), [roles]);
  if (roles === null) return null;
  return (
    <ul className="flex flex-col" role="tree" aria-label={MODULE_NAME}>
      {flat.map((node) => (
        <RoleRow key={node.role.id} node={node} rows={rows} onOpen={open} dense={dense}
          onEdit={editable ? (role) => openDialog({ mode: "edit", roleId: role.id }) : undefined} />
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
            Роли: помощник, оркестраторы проектов, агенты и внешние сотрудники. Нажатие открывает действующий тред роли.
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
        id: editing?.id,
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
            <Field label="Кому подчиняется">
              <select className={selectClass} value={draft.parentId} onChange={(e) => patch({ parentId: e.target.value })}>
                <option value="">владельцу</option>
                {parents.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
              </select>
            </Field>
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

// ---------- app-wide owner ----------

/** Mounted once per window: keeps data fresh, draws the block into its spot, owns the dialog. */
export function RosterOverlay() {
  useRosterSync();
  const host = useStore((s) => s.host);
  return (
    <>
      {host ? createPortal(<SidebarBlock />, host) : null}
      <RoleDialog />
    </>
  );
}

function useBadge() {
  useRosterSync();
  const roles = useRoles();
  const rows = useRows();
  if (!roles) return null;
  const waiting = roles.filter((r) => roleState(r.active, rows.byId) === "waiting").length;
  return waiting > 0 ? { count: waiting, tone: "warning" as const, label: `ждут владельца: ${waiting}` } : null;
}

/** Row mark for lists that draw metadata (Machine Tabs always; bb's list with Metadata on). */
function RoleMark({ thread, data }: ExperimentalThreadRowMetadataProps<ResolvedRole[] | null>) {
  const own = data ? rolesForThread(data, thread.id) : [];
  const role = own[0];
  if (!role) return null;
  const label = `${KIND_LABEL[role.kind]}: ${role.name}`;
  return (
    <span className="inline-flex items-center text-amber-500" title={label} aria-label={label} role="img" data-agent-roster-mark="">
      <RoleIcon role={role} className="size-3.5 w-3.5 text-[11px]" />
    </span>
  );
}

function useMarkData() {
  return useRoles();
}

function useActionData() {
  const rpc = useRpc<typeof rpcContract>();
  const roles = useRoles();
  return { rpc, roles: roles ?? [] };
}

/** Row status for bb's own list: drawn by default, never hides running, error or waiting. */
function mountRowStatus(setRowStatus: ((threadId: string, status: { icon: string; label: string } | null) => void) | undefined) {
  if (!setRowStatus) return () => undefined;
  let marked = new Set<string>();
  const paint = () => {
    const roles = getState().roles ?? [];
    const next = new Map<string, { icon: string; label: string }>();
    for (const role of roles) {
      const threads = role.binding.mode === "pinned" ? (role.binding.threadId ? [role.binding.threadId] : []) : role.binding.mode === "group" ? role.binding.threadIds : [];
      for (const id of threads) if (!next.has(id)) next.set(id, { icon: KIND_ICON[role.kind], label: `${KIND_LABEL[role.kind]}: ${role.name}` });
    }
    for (const id of marked) if (!next.has(id)) setRowStatus(id, null);
    for (const [id, status] of next) setRowStatus(id, status);
    marked = new Set(next.keys());
  };
  const unsubscribe = subscribe(paint);
  paint();
  return () => {
    unsubscribe();
    for (const id of marked) setRowStatus(id, null);
  };
}

export default definePluginApp((app) => {
  app.contentScripts.register({
    id: "sidebar-block",
    mount({ signal, experimental_setThreadRowStatus }) {
      const host = document.createElement("div");
      host.setAttribute(HOST_ATTR, "");
      host.dataset.bbPlugin = "agent-roster";
      const stopPlacing = keepPlaced(host, signal, (placed) => setState({ host: placed ? host : null }));
      const stopMarks = mountRowStatus(experimental_setThreadRowStatus);
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

  app.slots.experimental_threadRowMetadata<ResolvedRole[] | null>({
    id: "role-mark",
    order: 1,
    useData: useMarkData,
    component: RoleMark,
  });

  app.slots.experimental_threadAction({
    id: "role",
    title: "Роль агента",
    icon: "agent-roster/crown",
    group: experimental_THREAD_ACTION_GROUPS.organize,
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
    order: 1,
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
