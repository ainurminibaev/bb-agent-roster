// Server side of the employee install screen: BB machines, the installer's form, a background run of
// the entry with bb's terminal on that machine, one read of the state file per poll (not more often
// than every 10 s, only while the screen is open and the install is going), the human's actions.
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import {
  isGoing,
  isProblem,
  type FormField,
  type InstallProblem,
  type InstallState,
  paramArgs,
  parseDescribe,
  parseInstallState,
  parseJson,
  statePathFromOutput,
} from "./install";

export const INSTALLS_KEY = "installs";
export const READ_EVERY_MS = 10_000;

export interface InstallRecord {
  id: string;
  hostId: string;
  /** Form values by field id (never secrets: the form has no secret values). */
  values: Record<string, string | boolean>;
  fields: FormField[];
  terminalId: string | null;
  pid: number | null;
  statePath: string | null;
  startedAt: number;
  last: InstallState | null;
  problem: InstallProblem | null;
  lastReadAt: number;
  /** The role created from `result`. */
  roleId: string | null;
}

export interface MachineInfo { id: string; name: string; connected: boolean }

type Bb = BbPluginApi;

function decode(chunks: { dataBase64: string }[]): string {
  // Strip terminal colour codes; the installer's first line is plain JSON.
  return chunks.map((c) => Buffer.from(c.dataBase64, "base64").toString("utf8")).join("").replace(/\u001b\[[0-9;?]*[A-Za-z]/g, "");
}

export function createInstaller(bb: Bb, opts: { command: () => string; now?: () => number; sleep?: (ms: number) => Promise<void> }) {
  const now = opts.now ?? (() => Date.now());
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const terminals = bb.sdk.terminals;

  async function load(): Promise<InstallRecord[]> {
    const raw = await bb.storage.kv.get<unknown>(INSTALLS_KEY);
    return Array.isArray(raw) ? (raw as InstallRecord[]).slice(0, 20) : [];
  }
  async function save(list: InstallRecord[]): Promise<void> {
    await bb.storage.kv.set(INSTALLS_KEY, list.slice(-20));
  }
  async function update(id: string, patch: (r: InstallRecord) => InstallRecord): Promise<InstallRecord> {
    const list = await load();
    const i = list.findIndex((r) => r.id === id);
    if (i < 0) throw new Error(`No install ${id}.`);
    list[i] = patch(list[i]!);
    await save(list);
    return list[i]!;
  }

  async function open(hostId: string, argv: string[]) {
    return terminals.create({ scope: { kind: "host_path", hostId, cwd: null }, start: { mode: "argv", argv }, cols: 200, rows: 50, title: "Агенты: установка сотрудника" } as never);
  }
  async function outputOf(terminalId: string): Promise<{ text: string; exitCode: number | null; done: boolean }> {
    const out = (await terminals.output({ terminalId, tailBytes: 256 * 1024 } as never)) as unknown as { chunks: { dataBase64: string }[]; exitCode: number | null; closeReason: string | null };
    return { text: decode(out.chunks ?? []), exitCode: out.exitCode ?? null, done: out.closeReason !== null && out.closeReason !== undefined };
  }
  /** Run a short command on a machine and wait for it (bb's terminal; one command). */
  async function run(hostId: string, argv: string[], timeoutMs = 20_000): Promise<{ text: string; exitCode: number | null }> {
    const t = (await open(hostId, argv)) as unknown as { id: string };
    try {
      const until = now() + timeoutMs;
      for (;;) {
        const o = await outputOf(t.id);
        if (o.done || o.exitCode !== null) return { text: o.text, exitCode: o.exitCode };
        if (now() > until) return { text: o.text, exitCode: null };
        await sleep(250);
      }
    } finally {
      try { await terminals.close({ terminalId: t.id } as never); } catch { /* already gone */ }
    }
  }

  const missing = (detail: string): InstallProblem => ({ problem: "missing", message: `Установщик платформы на этой машине не найден или не ответил (${detail}).` });

  async function machines(): Promise<MachineInfo[]> {
    const list = (await bb.sdk.hosts.list()) as unknown as { id: string; name: string; status: string }[];
    return list.map((h) => ({ id: h.id, name: h.name, connected: h.status === "connected" }));
  }

  async function describe(hostId: string): Promise<{ fields: FormField[] } | InstallProblem> {
    let out: { text: string; exitCode: number | null };
    try { out = await run(hostId, [opts.command(), "employee", "--describe", "--json"]); } catch (e) { return missing(e instanceof Error ? e.message : "нет связи с машиной"); }
    if (out.exitCode !== 0) return missing(out.exitCode === null ? "нет ответа" : `код ${out.exitCode}`);
    return parseDescribe(parseJson(out.text));
  }

  /** Start (or run again) the entry in the background; the state file path comes from its first line. */
  async function launch(rec: InstallRecord): Promise<InstallRecord> {
    const args = paramArgs(rec.fields, rec.values);
    // A tiny wrapper prints the entry's pid (for TERM on «отменить»); exec keeps the pid; values stay separate arguments.
    const argv = ["sh", "-c", 'printf \'{"pid": %s}\\n\' "$$"; exec "$0" "$@"', opts.command(), "employee", ...args];
    const t = (await open(rec.hostId, argv)) as unknown as { id: string };
    let statePath: string | null = null;
    let pid: number | null = null;
    let text = "";
    const until = now() + 30_000;
    for (;;) {
      const o = await outputOf(t.id);
      text = o.text;
      const m = /\{"pid": (\d+)\}/.exec(text);
      if (m) pid = Number(m[1]);
      statePath = statePathFromOutput(text);
      if (statePath || o.done || o.exitCode !== null || now() > until) break;
      await sleep(300);
    }
    const problem = statePath ? null : missing("нет первой строки с файлом состояния");
    return { ...rec, terminalId: t.id, pid, statePath: statePath ?? rec.statePath, problem, lastReadAt: 0 };
  }

  async function start(hostId: string, fields: FormField[], values: Record<string, string | boolean>): Promise<InstallRecord> {
    const clean: Record<string, string | boolean> = {};
    const known = new Map(fields.map((f) => [f.id, f]));
    for (const [k, v] of Object.entries(values)) if (known.has(k) && known.get(k)!.type !== "secret") clean[k] = v;
    const rec: InstallRecord = { id: `i-${now().toString(36)}`, hostId, values: clean, fields, terminalId: null, pid: null, statePath: null, startedAt: now(), last: null, problem: null, lastReadAt: 0, roleId: null };
    const launched = await launch(rec);
    const list = await load();
    await save([...list, launched]);
    return read(launched.id, true);
  }

  /** One read of the state file; at most every READ_EVERY_MS and only while going (or the first time). */
  async function read(id: string, force = false): Promise<InstallRecord> {
    const rec = (await load()).find((r) => r.id === id);
    if (!rec) throw new Error(`No install ${id}.`);
    if (!rec.statePath) return rec;
    const going = rec.last === null || isGoing(rec.last);
    if (!force && (!going || now() - rec.lastReadAt < READ_EVERY_MS)) return rec;
    let next: Pick<InstallRecord, "last" | "problem">;
    try {
      const out = await run(rec.hostId, ["cat", rec.statePath], 15_000);
      const parsed = out.exitCode === 0 ? parseInstallState(parseJson(out.text)) : missing("нет файла состояния");
      next = isProblem(parsed) ? { last: rec.last, problem: parsed } : { last: parsed, problem: null };
    } catch (e) {
      next = { last: rec.last, problem: missing(e instanceof Error ? e.message : "нет связи с машиной") };
    }
    return update(id, (r) => ({ ...r, ...next, lastReadAt: now() }));
  }

  /** The human's action: continue (same parameters), retry (with params), cancel (TERM to the entry). */
  async function act(id: string, kind: "continue" | "retry" | "cancel", params: Record<string, string | boolean>): Promise<InstallRecord> {
    const rec = (await load()).find((r) => r.id === id);
    if (!rec) throw new Error(`No install ${id}.`);
    if (kind === "cancel") {
      if (rec.pid) await run(rec.hostId, ["kill", "-TERM", String(rec.pid)], 10_000).catch(() => undefined);
      await sleep(1000);
      return read(id, true);
    }
    // Stop the previous run of this install if it is still there, then start again.
    if (rec.pid) await run(rec.hostId, ["kill", "-TERM", String(rec.pid)], 10_000).catch(() => undefined);
    const values = kind === "retry" ? { ...rec.values, ...params } : rec.values;
    const launched = await launch({ ...rec, values });
    await update(id, () => launched);
    return read(id, true);
  }

  async function remove(id: string): Promise<boolean> {
    const list = await load();
    const rec = list.find((r) => r.id === id);
    if (!rec) return false;
    if (rec.last && isGoing(rec.last) && rec.pid) await run(rec.hostId, ["kill", "-TERM", String(rec.pid)], 10_000).catch(() => undefined);
    await save(list.filter((r) => r.id !== id));
    return true;
  }

  return { load, update, machines, describe, start, read, act, remove };
}
