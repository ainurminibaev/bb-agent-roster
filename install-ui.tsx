// The «сотрудник на Vallis» screen: machine → the installer's form → background run → the steps as the
// installer reports them → a record from the result. Knows only the fields of the format (lib/install.ts).
import { useCallback, useEffect, useState } from "react";
import type { ReactNode } from "react";
import { useBbNavigate, useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "./server";
import { setState, useStore } from "./lib/store";
import type { InstallRecord } from "./lib/install-server";
import {
  initialValues, installLine, isGoing, isProblem, isStale, missingRequired,
  type FormField, type InstallProblem, type InstallStep, type HumanAction,
} from "./lib/install";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

/** The screen polls only while it is open and the install is going, every 10 s (install-state.md, section 3). */
export const POLL_MS = 10_000;

type Rpc = ReturnType<typeof useRpc<typeof rpcContract>>;
type Values = Record<string, string | boolean>;

const STEP_WORD: Record<string, string> = {
  pending: "ожидает", running: "идёт", done: "готово", error: "ошибка", human: "ждёт человека", cancelled: "отменено", skipped: "пропущено",
};
const STEP_MARK: Record<string, string> = {
  pending: "○", running: "◐", done: "✓", error: "⊗", human: "!", cancelled: "–", skipped: "·",
};

export function openInstall(id: string | "new") {
  setState({ install: id });
}

function DocLink() {
  const url = useStore((s) => s.launchDocUrl);
  const navigate = useBbNavigate();
  if (!url) return <p className="text-xs text-muted-foreground">Документ запуска не задан в настройках плагина.</p>;
  return <button type="button" data-install-doc="" className="text-left text-sm text-primary underline-offset-2 hover:underline" onClick={() => navigate.openUrl(url)}>Документ запуска нового сотрудника</button>;
}

function Problem({ problem }: { problem: InstallProblem }) {
  return (
    <div data-install-problem={problem.problem} className="flex flex-col gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
      <p>{problem.message}</p>
      <DocLink />
    </div>
  );
}

function MachineStep({ onPick }: { onPick: (hostId: string) => void }) {
  const rpc: Rpc = useRpc<typeof rpcContract>();
  const [machines, setMachines] = useState<{ id: string; name: string; connected: boolean }[] | null>(null);
  useEffect(() => {
    let live = true;
    rpc.call("install_machines", null).then((r) => { if (live) setMachines(r.machines); }, () => { if (live) setMachines([]); });
    return () => { live = false; };
  }, [rpc]);
  return (
    <div className="flex flex-col gap-3" data-install-machines="">
      <p className="text-sm text-muted-foreground">Сервер сотрудника — машина вашего BB. Выберите её:</p>
      {machines === null ? <p className="text-sm text-muted-foreground">Загружаю машины…</p> : (
        <ul className="flex flex-col gap-1">
          {machines.map((m) => (
            <li key={m.id}>
              <button type="button" data-install-machine={m.id} disabled={!m.connected} onClick={() => onPick(m.id)}
                className="flex w-full cursor-pointer items-center justify-between rounded-md border border-border px-3 py-2 text-left text-sm hover:bg-state-hover disabled:cursor-default disabled:opacity-50">
                <span>{m.name}</span><span className="text-xs text-muted-foreground">{m.connected ? "в сети" : "не в сети"}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="flex flex-col gap-1 rounded-md bg-muted/40 p-3 text-xs text-muted-foreground" data-install-enroll="">
        <p><b>Сервера нет в списке?</b> Подключите его к BB штатно: в BB — «Настройки → Машины → Добавить машину», BB выдаст команду; выполните её на сервере, и он появится здесь. Из терминала того же BB — <code>bb machine enroll</code>.</p>
        <DocLink />
      </div>
    </div>
  );
}

function FieldInput({ field, value, onChange }: { field: FormField; value: string | boolean | undefined; onChange: (v: string | boolean) => void }) {
  if (field.type === "secret") {
    // The form never takes a secret: the field only says which key will come through the secret store.
    return (
      <div data-install-secret={field.id} className="rounded-md bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
        <span className="font-medium text-foreground">{field.title}</span>{field.secret ? <> — ключ <code>{field.secret}</code></> : null}
        {field.hint ? <span className="block">{field.hint}</span> : null}
      </div>
    );
  }
  const label = <span className="text-sm">{field.title}{field.required ? " *" : ""}</span>;
  const hint = field.hint ? <span className="block text-xs text-muted-foreground">{field.hint}</span> : null;
  if (field.type === "bool") {
    return <label className="flex items-start gap-2" data-install-field={field.id}><input type="checkbox" className="mt-1" checked={value === true} onChange={(e) => onChange(e.target.checked)} /><span>{label}{hint}</span></label>;
  }
  if (field.type === "choice" && field.choices.length) {
    return (
      <label className="flex flex-col gap-1" data-install-field={field.id}>{label}
        <select className="h-8 rounded-md border border-border bg-transparent px-2 text-sm" value={typeof value === "string" ? value : ""} onChange={(e) => onChange(e.target.value)}>
          <option value="">—</option>
          {field.choices.map((c) => <option key={c.value} value={c.value}>{c.title}</option>)}
        </select>{hint}
      </label>
    );
  }
  return <label className="flex flex-col gap-1" data-install-field={field.id}>{label}<Input value={typeof value === "string" ? value : ""} onChange={(e) => onChange(e.target.value)} />{hint}</label>;
}

function FormStep({ hostId, onStarted, onBack }: { hostId: string; onStarted: (rec: InstallRecord) => void; onBack: () => void }) {
  const rpc: Rpc = useRpc<typeof rpcContract>();
  const [form, setForm] = useState<{ fields: FormField[] } | InstallProblem | null>(null);
  const [values, setValues] = useState<Values>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    rpc.call("install_describe", { hostId }).then((r) => {
      if (!live) return;
      setForm(r as never);
      if (!isProblem(r)) setValues(initialValues((r as { fields: FormField[] }).fields));
    }, (e: unknown) => { if (live) setForm({ problem: "missing", message: e instanceof Error ? e.message : "Машина не ответила." }); });
    return () => { live = false; };
  }, [rpc, hostId]);
  if (form === null) return <p className="text-sm text-muted-foreground">Спрашиваю у установщика, что нужно знать…</p>;
  if (isProblem(form)) return <div className="flex flex-col gap-3"><Problem problem={form} /><Button variant="outline" onClick={onBack}>Другая машина</Button></div>;
  const missing = missingRequired(form.fields, values);
  const start = async () => {
    setBusy(true); setError(null);
    try { onStarted(await rpc.call("install_start", { hostId, fields: form.fields as never, values })); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };
  return (
    <form className="flex flex-col gap-3" data-install-form="" onSubmit={(e) => { e.preventDefault(); if (!missing.length) void start(); }}>
      {form.fields.map((f) => <FieldInput key={f.id} field={f} value={values[f.id]} onChange={(v) => setValues((old) => ({ ...old, [f.id]: v }))} />)}
      {error ? <p className="text-sm text-red-500">{error}</p> : null}
      <div className="flex justify-between gap-2">
        <Button type="button" variant="outline" onClick={onBack}>Назад</Button>
        <Button type="submit" disabled={busy || missing.length > 0}>{busy ? "Запускаю…" : "Установить"}</Button>
      </div>
      {missing.length ? <p className="text-xs text-muted-foreground" data-install-missing="">Заполните: {missing.join(", ")}</p> : null}
    </form>
  );
}

function Copy({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  return (
    <div className="flex items-start gap-2">
      <code className="min-w-0 flex-1 break-all rounded bg-muted/50 px-2 py-1 text-xs">{text}</code>
      <button type="button" className="shrink-0 cursor-pointer rounded px-1 text-xs text-primary hover:underline"
        onClick={() => { void navigator.clipboard?.writeText(text).then(() => setDone(true), () => undefined); }}>{done ? "скопировано" : "копировать"}</button>
    </div>
  );
}

function StepRow({ step, act, busy }: { step: InstallStep; act: (a: HumanAction | { kind: "continue"; title: string; params: Values }) => void; busy: boolean }) {
  const [log, setLog] = useState(false);
  const word = step.state === "unknown" ? step.rawState : STEP_WORD[step.state];
  return (
    <li data-install-step={step.id} data-state={step.state === "unknown" ? step.rawState : step.state} className="flex flex-col gap-1 py-1">
      <div className="flex items-center gap-2 text-sm">
        <span className={cn("w-4 shrink-0 text-center", step.state === "error" && "text-red-500", step.state === "human" && "text-amber-600", step.state === "done" && "text-emerald-600")} aria-hidden="true">{STEP_MARK[step.state] ?? "?"}</span>
        <span className="min-w-0 flex-1 truncate">{step.title}</span>
        <span className="shrink-0 text-xs text-muted-foreground">{word}</span>
      </div>
      {step.detail ? <p className="pl-6 text-xs text-muted-foreground">{step.detail}</p> : null}
      {step.state === "human" && step.human ? (
        <div data-install-human="" className="ml-6 flex flex-col gap-1.5 rounded-md border border-amber-500/40 bg-amber-500/10 p-2 text-sm">
          <p className="font-medium">{step.human.what}</p>
          {step.human.how ? <p className="text-xs">{step.human.how}</p> : null}
          {step.human.show ? <Copy text={step.human.show} /> : null}
          {step.human.copy ? <Copy text={step.human.copy} /> : null}
          {step.human.auto ? <p className="text-xs text-muted-foreground" data-install-auto="">Установщик заметит выполнение сам — экран ждёт.</p> : null}
          {step.human.actions.length ? (
            <div className="flex flex-wrap gap-2">
              {step.human.actions.map((a, i) => (
                <Button key={i} size="sm" variant={a.kind === "cancel" ? "outline" : "default"} disabled={busy} data-install-action={a.kind} onClick={() => act(a)}>{a.title}</Button>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
      {step.state === "error" && step.error ? (
        <div data-install-error="" className="ml-6 flex flex-col gap-1.5 rounded-md border border-red-500/40 bg-red-500/10 p-2 text-sm">
          <p>{step.error.text}</p>
          <div className="flex flex-wrap gap-2">
            {step.error.log.length ? <Button size="sm" variant="outline" data-install-log-toggle="" onClick={() => setLog((v) => !v)}>{log ? "скрыть подробности" : "подробности"}</Button> : null}
            {step.error.retry ? <Button size="sm" disabled={busy} data-install-action="continue" onClick={() => act({ kind: "continue", title: "повторить", params: {} })}>повторить</Button> : null}
          </div>
          {log ? <pre data-install-log="" className="max-h-48 overflow-auto whitespace-pre-wrap rounded bg-muted/50 p-2 text-[11px]">{step.error.log.join("\n")}</pre> : null}
        </div>
      ) : null}
    </li>
  );
}

function Progress({ id }: { id: string }) {
  const rpc: Rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  const [rec, setRec] = useState<InstallRecord | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const read = useCallback(() => rpc.call("install_read", { id }).then((r) => setRec(r as InstallRecord), (e: unknown) => setError(e instanceof Error ? e.message : String(e))), [rpc, id]);
  // One read on opening; then every POLL_MS only while the install is going.
  useEffect(() => { void read(); }, [read]);
  const going = rec?.last ? isGoing(rec.last) : rec !== null && !rec.problem;
  useEffect(() => {
    if (!going) return;
    const t = window.setInterval(() => void read(), POLL_MS);
    return () => window.clearInterval(t);
  }, [going, read]);
  // Done with a result: the record goes into the list (once).
  useEffect(() => {
    if (rec?.last?.state === "done" && rec.last.result && !rec.roleId) {
      rpc.call("install_finish", { id }).then(() => void read(), (e: unknown) => setError(e instanceof Error ? e.message : String(e)));
    }
  }, [rec, rpc, id, read]);
  const act = async (a: { kind: "continue" | "retry" | "cancel"; params: Values }) => {
    setBusy(true); setError(null);
    try { setRec((await rpc.call("install_action", { id, kind: a.kind, params: a.params })) as InstallRecord); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };
  if (!rec) return <p className="text-sm text-muted-foreground">{error ?? "Читаю состояние установки…"}</p>;
  const st = rec.last;
  const stale = st ? isStale(st, Date.now()) : false;
  let body: ReactNode = null;
  if (st) {
    body = (
      <>
        <p className="text-sm" data-install-summary="">{installLine(st, Date.now()).text}</p>
        {stale ? (
          <div data-install-stale="" className="flex items-center justify-between gap-2 rounded-md border border-red-500/40 bg-red-500/10 p-2 text-sm">
            <span>Установщик давно не отмечался — похоже, он остановился.</span>
            <Button size="sm" disabled={busy} data-install-action="continue" onClick={() => void act({ kind: "continue", params: {} })}>повторить</Button>
          </div>
        ) : null}
        <ul className="flex flex-col divide-y divide-border" data-install-steps="">
          {st.steps.map((s) => <StepRow key={s.id} step={s} busy={busy} act={(a) => void act(a)} />)}
        </ul>
        {st.state === "done" && st.result ? (
          <div data-install-result="" className="flex flex-col gap-1 rounded-md border border-emerald-500/40 bg-emerald-500/10 p-2 text-sm">
            <p><b>{st.result.role.name}</b> установлен{rec.roleId ? " и добавлен в список" : ""}.</p>
            {st.result.role.about ? <p className="text-xs">{st.result.role.about}</p> : null}
            {st.result.links.map((l, i) => (
              <p key={i} className="text-xs">{l.kind}: {l.url ? <button type="button" className="text-primary underline-offset-2 hover:underline" onClick={() => navigate.openUrl(l.url!)}>{l.url}</button> : l.bot}</p>
            ))}
          </div>
        ) : null}
      </>
    );
  }
  return (
    <div className="flex flex-col gap-3" data-install-progress={id}>
      {rec.problem ? <Problem problem={rec.problem} /> : null}
      {body}
      {error ? <p className="text-sm text-red-500">{error}</p> : null}
      {!going ? (
        <div className="flex justify-end">
          <Button variant="outline" size="sm" data-install-remove="" onClick={() => { void rpc.call("install_remove", { id }).then(() => setState({ install: null })); }}>Убрать из блока</Button>
        </div>
      ) : null}
    </div>
  );
}

/** Owned by the overlay; opened from «＋ → Сотрудник на Vallis» or a running install in the block. */
export function InstallDialog() {
  const open = useStore((s) => s.install);
  const [hostId, setHostId] = useState<string | null>(null);
  const [startedId, setStartedId] = useState<string | null>(null);
  useEffect(() => { if (open === null) { setHostId(null); setStartedId(null); } }, [open]);
  const id = open && open !== "new" ? open : startedId;
  return (
    <Dialog open={open !== null} onOpenChange={(o) => { if (!o) setState({ install: null }); }}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg" data-agent-roster-install="">
        <DialogHeader>
          <DialogTitle>Сотрудник на Vallis</DialogTitle>
          <DialogDescription>Установка идёт на сервере сотрудника; шаги и вопросы приходят от установщика платформы.</DialogDescription>
        </DialogHeader>
        {id ? <Progress id={id} />
          : hostId ? <FormStep hostId={hostId} onBack={() => setHostId(null)} onStarted={(rec) => { setStartedId(rec.id); setState({ install: rec.id }); }} />
          : <MachineStep onPick={setHostId} />}
      </DialogContent>
    </Dialog>
  );
}

/** Installs in the block: «устанавливается: <шаг>», «ждёт» when a step waits for the owner. */
export function InstallRows() {
  const installs = useStore((s) => s.installs);
  const visible = installs.filter((r) => !r.roleId);
  if (!visible.length) return null;
  return (
    <ul className="flex flex-col pl-2.5" data-agent-roster-installs="">
      {visible.map((r) => {
        const line = r.problem ? { text: r.problem.message, waiting: false, failed: true } : installLine(r.last, Date.now());
        const name = r.last?.for ? `Новый сотрудник: ${r.last.for}` : "Новый сотрудник";
        return (
          <li key={r.id} data-agent-roster-install={r.id}>
            <button type="button" className="flex w-full cursor-pointer flex-col rounded-md py-0.5 pl-1 text-left hover:bg-sidebar-accent" onClick={() => openInstall(r.id)}>
              <span className="flex h-5 items-center gap-2 text-sm">
                <span className="min-w-0 flex-1 truncate">{name}</span>
                {line.waiting ? <span data-agent-roster-waiting="" className="shrink-0 rounded-full bg-amber-500/15 px-1.5 text-[11px] font-medium leading-4 text-amber-600">ждёт</span> : null}
                {line.failed ? <span className="shrink-0 pr-2 text-[11px] text-red-500" aria-label="ошибка">⊗</span> : null}
              </span>
              <span data-agent-roster-install-line="" className="h-4 truncate pr-2 text-[11px] leading-4 text-muted-foreground">{line.text}</span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}
