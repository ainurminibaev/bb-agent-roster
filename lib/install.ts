// The platform's employee installer as data (install-state.md, format 1). The plugin knows only the
// fields of the format: no step ids, no parameter names. Everything shown comes from the installer.

export const INSTALL_FORMAT = 1;

export const STEP_STATES = ["pending", "running", "done", "error", "human", "cancelled", "skipped"] as const;
export type StepState = (typeof STEP_STATES)[number];
export const ACTION_KINDS = ["continue", "retry", "cancel"] as const;
export type ActionKind = (typeof ACTION_KINDS)[number];
export const FIELD_TYPES = ["string", "choice", "bool", "secret"] as const;
export type FieldType = (typeof FIELD_TYPES)[number];

export interface FormField {
  id: string;
  title: string;
  hint: string | null;
  type: FieldType | "unknown";
  required: boolean;
  default: string | boolean | null;
  choices: { value: string; title: string }[];
  /** For a `secret` field: the name of the key that will come through the secret store. Never a value. */
  secret: string | null;
  /** The entry's parameter for this field, when the installer names it (install-state.md, section 1). */
  flag: string | null;
}

export interface HumanAction {
  kind: ActionKind;
  title: string;
  params: Record<string, string | boolean>;
}

export interface InstallStep {
  id: string;
  title: string;
  state: StepState | "unknown";
  /** The raw state when it is not one of the known ones (shown as is). */
  rawState: string;
  detail: string | null;
  error: { text: string; retry: boolean; log: string[] } | null;
  human: { what: string; how: string | null; copy: string | null; show: string | null; auto: boolean; actions: HumanAction[] } | null;
}

export interface InstallResult {
  address: { machine: string | null; port: number | null; project: string | null; workspace: string | null };
  role: { name: string; kind: string; about: string };
  links: { kind: string; url: string | null; bot: string | null }[];
  passport: string | null;
}

export interface InstallState {
  format: number;
  for: string | null;
  installer: string | null;
  state: StepState | "unknown";
  run: { id: string | null; startedAt: number | null; heartbeatAt: number | null; interval: number };
  steps: InstallStep[];
  result: InstallResult | null;
}

/** Why the screen cannot work with what it got: no installer, not the format, a newer format. */
export type InstallProblem = { problem: "missing" | "invalid" | "newer"; format?: number; message: string };

const s = (v: unknown, max = 2000): string | null => (typeof v === "string" ? v.slice(0, max) : null);
const obj = (v: unknown): Record<string, unknown> | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null);
const time = (v: unknown): number | null => {
  if (typeof v !== "string") return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
};

function checkFormat(raw: Record<string, unknown> | null): InstallProblem | null {
  if (!raw || typeof raw.format !== "number") return { problem: "invalid", message: "Ответ установщика не в формате установки (нет поля format)." };
  if (raw.format > INSTALL_FORMAT) return { problem: "newer", format: raw.format, message: `Установщик новее, чем экран: формат ${raw.format}, экран знает ${INSTALL_FORMAT}. Обновите плагин «Агенты».` };
  return null;
}

/** JSON from text; the installer may print other lines around it. */
export function parseJson(text: string): unknown {
  const t = text.trim();
  try { return JSON.parse(t); } catch { /* fall through */ }
  const start = t.indexOf("{");
  const end = t.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try { return JSON.parse(t.slice(start, end + 1)); } catch { /* not JSON */ }
  }
  return null;
}

/** The form from `--describe --json`. */
export function parseDescribe(raw: unknown): { fields: FormField[] } | InstallProblem {
  const o = obj(raw);
  const bad = checkFormat(o);
  if (bad) return bad;
  const list = Array.isArray(o!.fields) ? o!.fields : [];
  const fields: FormField[] = [];
  for (const item of list.slice(0, 60)) {
    const f = obj(item);
    const id = f && s(f.id, 80);
    if (!f || !id) continue;
    const type = (FIELD_TYPES as readonly string[]).includes(f.type as string) ? (f.type as FieldType) : "unknown";
    const choices = Array.isArray(f.choices)
      ? f.choices.flatMap((c) => { const co = obj(c); const value = co && s(co.value, 200); return value ? [{ value, title: s(co!.title, 200) ?? value }] : []; }).slice(0, 200)
      : [];
    const def = typeof f.default === "string" || typeof f.default === "boolean" ? f.default : null;
    fields.push({
      id, title: s(f.title, 200) ?? id, hint: s(f.hint, 500), type: choices.length && type === "unknown" ? "choice" : type,
      required: f.required === true, default: type === "secret" ? null : def, choices, secret: type === "secret" ? s(f.secret, 120) : null,
      flag: typeof f.flag === "string" && /^--[a-z0-9][a-z0-9-]{0,79}$/.test(f.flag) ? f.flag : null,
    });
  }
  return { fields };
}

export function isProblem(v: unknown): v is InstallProblem {
  return !!v && typeof v === "object" && "problem" in v;
}

function parseAction(raw: unknown): HumanAction | null {
  const a = obj(raw);
  if (!a || !(ACTION_KINDS as readonly string[]).includes(a.kind as string)) return null;
  const params: Record<string, string | boolean> = {};
  for (const [k, v] of Object.entries(obj(a.params) ?? {})) if (typeof v === "string" || typeof v === "boolean") params[k.slice(0, 80)] = v;
  return { kind: a.kind as ActionKind, title: s(a.title, 120) ?? String(a.kind), params };
}

function parseStep(raw: unknown): InstallStep | null {
  const st = obj(raw);
  const id = st && s(st.id, 120);
  if (!st || !id) return null;
  const rawState = s(st.state, 40) ?? "";
  const state = (STEP_STATES as readonly string[]).includes(rawState) ? (rawState as StepState) : "unknown";
  const e = obj(st.error);
  const h = obj(st.human);
  return {
    id, title: s(st.title, 300) ?? id, state, rawState, detail: s(st.detail, 500),
    error: e ? { text: s(e.text, 2000) ?? "", retry: e.retry === true, log: Array.isArray(e.log) ? e.log.filter((x): x is string => typeof x === "string").slice(-200).map((x) => x.slice(0, 2000)) : [] } : null,
    human: h ? {
      what: s(h.what, 500) ?? "", how: s(h.how, 2000), copy: s(h.copy, 2000), show: s(h.show, 2000), auto: h.auto === true,
      actions: (Array.isArray(h.actions) ? h.actions : []).map(parseAction).filter((x): x is HumanAction => x !== null).slice(0, 8),
    } : null,
  };
}

function parseResult(raw: unknown): InstallResult | null {
  const r = obj(raw);
  const role = r && obj(r.role);
  const name = role && s(role.name, 80);
  if (!r || !role || !name) return null;
  const a = obj(r.address) ?? {};
  return {
    address: { machine: s(a.machine, 120), port: typeof a.port === "number" ? a.port : null, project: s(a.project, 120), workspace: s(a.workspace, 500) },
    role: { name, kind: s(role.kind, 40) ?? "agent", about: s(role.about, 300) ?? "" },
    links: (Array.isArray(r.links) ? r.links : []).flatMap((l) => { const lo = obj(l); const kind = lo && s(lo.kind, 40); return kind ? [{ kind, url: s(lo!.url, 500), bot: s(lo!.bot, 120) }] : []; }).slice(0, 10),
    passport: s(r.passport, 500),
  };
}

/** The state file. */
export function parseInstallState(raw: unknown): InstallState | InstallProblem {
  const o = obj(raw);
  const bad = checkFormat(o);
  if (bad) return bad;
  const run = obj(o!.run) ?? {};
  const rawState = s(o!.state, 40) ?? "";
  return {
    format: o!.format as number,
    for: s(o!.for, 120),
    installer: s(o!.installer, 40),
    state: (STEP_STATES as readonly string[]).includes(rawState) ? (rawState as StepState) : "unknown",
    run: {
      id: s(run.id, 120), startedAt: time(run.startedAt), heartbeatAt: time(run.heartbeatAt),
      interval: typeof run.interval === "number" && run.interval > 0 ? run.interval : 15,
    },
    steps: (Array.isArray(o!.steps) ? o!.steps : []).map(parseStep).filter((x): x is InstallStep => x !== null).slice(0, 100),
    result: parseResult(o!.result),
  };
}

/** Still going: the screen polls only then. */
export function isGoing(state: InstallState): boolean {
  return state.state === "running" || state.state === "human";
}

/** Hung: going, and the last heartbeat is older than three promised intervals. */
export function isStale(state: InstallState, now: number): boolean {
  if (!isGoing(state)) return false;
  const at = state.run.heartbeatAt ?? state.run.startedAt;
  return at === null || now - at > 3 * state.run.interval * 1000;
}

/** The step to name in the block: the first waiting for a human, else running, else failed. */
export function currentStep(state: InstallState): InstallStep | null {
  return state.steps.find((x) => x.state === "human") ?? state.steps.find((x) => x.state === "running")
    ?? state.steps.find((x) => x.state === "error") ?? null;
}

/** One line for the record in the block. */
export function installLine(state: InstallState | null, now: number): { text: string; waiting: boolean; failed: boolean } {
  if (!state) return { text: "устанавливается", waiting: false, failed: false };
  const step = currentStep(state);
  if (isStale(state, now)) return { text: "установщик не отвечает", waiting: false, failed: true };
  if (state.state === "done") return { text: "установлен", waiting: false, failed: false };
  if (state.state === "cancelled") return { text: "установка отменена", waiting: false, failed: false };
  if (state.state === "error") return { text: `ошибка установки${step ? `: ${step.title}` : ""}`, waiting: false, failed: true };
  return { text: `устанавливается${step ? `: ${step.title}` : ""}`, waiting: step?.state === "human", failed: false };
}

/**
 * Command-line parameters of the entry from form values, by field id (install-state.md, section 1,
 * «Поле формы → параметр входа»): the field's `flag` if given, else kebab-case id → `--<id>`; the value
 * is a separate argument (no shell); bool true → a bare flag; false and empty are not passed; a secret
 * field never.
 */
export function paramArgs(fields: readonly FormField[], values: Readonly<Record<string, string | boolean>>): string[] {
  const out: string[] = [];
  const byId = new Map(fields.map((f) => [f.id, f]));
  // In the form's order (deterministic), then any extra values (an action's params the form does not list).
  const ids = [...fields.map((f) => f.id), ...Object.keys(values).filter((k) => !byId.has(k))];
  for (const id of ids) {
    if (!(id in values)) continue;
    const value = values[id]!;
    const f = byId.get(id);
    if (f?.type === "secret") continue;
    if (!/^[A-Za-z][A-Za-z0-9_-]{0,79}$/.test(id)) continue;
    const flag = f?.flag ?? `--${id.replace(/([a-z0-9])([A-Z])/g, "$1-$2").replace(/_/g, "-").toLowerCase()}`;
    if (value === true) out.push(flag);
    else if (typeof value === "string" && value.trim() !== "") out.push(flag, value.trim());
  }
  return out;
}

/** Form values the user may submit: no secret fields, required ones filled. Returns the missing titles. */
export function missingRequired(fields: readonly FormField[], values: Readonly<Record<string, string | boolean>>): string[] {
  return fields.filter((f) => f.type !== "secret" && f.required && (values[f.id] === undefined || values[f.id] === "" || values[f.id] === null)).map((f) => f.title);
}

/** Initial values from defaults; secret fields never get a value. */
export function initialValues(fields: readonly FormField[]): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (const f of fields) if (f.type !== "secret" && f.default !== null) out[f.id] = f.default;
  return out;
}

/** The first line of the entry's output names the state file: `{"state": "<path>"}`. */
export function statePathFromOutput(text: string): string | null {
  for (const line of text.split(/\r?\n/).slice(0, 20)) {
    const t = line.trim();
    if (!t.startsWith("{")) continue;
    try {
      const o = JSON.parse(t) as Record<string, unknown>;
      if (typeof o.state === "string" && o.state.startsWith("/") && o.state.length < 500) return o.state;
    } catch { /* next line */ }
  }
  return null;
}
