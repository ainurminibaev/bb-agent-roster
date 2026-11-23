import { describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import plugin from "../server";
import {
  currentStep, initialValues, installLine, isStale, missingRequired, paramArgs, parseDescribe, parseInstallState, parseJson, statePathFromOutput,
  type FormField, type InstallState,
} from "../lib/install";

const FAKE = join(process.cwd(), "tests", "fake-vallis-install.mjs");

/** Run the fake entry once to the end and return what it printed and the state file. */
function runFake(scenario: string, args: string[] = []): Promise<{ out: string; state: unknown }> {
  const dir = mkdtempSync(join(tmpdir(), "fv-"));
  return new Promise((resolve) => {
    const p = spawn("node", [FAKE, "employee", ...args], { env: { ...process.env, FAKE_VALLIS_SCENARIO: scenario, FAKE_VALLIS_DIR: dir, FAKE_VALLIS_STEP_MS: "5" } });
    let out = "";
    p.stdout.on("data", (d) => { out += d; });
    const done = () => resolve({ out, state: JSON.parse(readFileSync(join(dir, "state.json"), "utf8")) });
    p.on("exit", done);
    if (scenario === "human" || scenario === "cancel") setTimeout(() => p.kill("SIGTERM"), 400);
  });
}
function describeFake(scenario = "normal"): unknown {
  return new Promise((resolve) => {
    const p = spawn("node", [FAKE, "employee", "--describe", "--json"], { env: { ...process.env, FAKE_VALLIS_SCENARIO: scenario } });
    let out = "";
    p.stdout.on("data", (d) => { out += d; });
    p.on("exit", () => resolve(parseJson(out)));
  });
}

describe("0.5: the installer's form and state (format 1)", () => {
  it("the form comes from --describe as data; a secret field takes no value and is never passed", async () => {
    const form = parseDescribe(await describeFake());
    if ("problem" in form) throw new Error(form.message);
    expect(form.fields.map((f) => [f.id, f.type])).toEqual([["organization", "string"], ["employee", "choice"], ["provider", "choice"], ["allowGuestGuard", "bool"], ["telegramBot", "secret"]]);
    const secret = form.fields.find((f) => f.type === "secret")!;
    expect(secret.default).toBeNull();
    expect(secret.secret).toBe("TELEGRAM_BOT");
    const values = { ...initialValues(form.fields), organization: "https://git.example.org/org.git", employee: "support", allowGuestGuard: true, telegramBot: "123:SECRET" };
    expect(missingRequired(form.fields, {})).toEqual(["Организация", "Сотрудник"]);
    expect(missingRequired(form.fields, values)).toEqual([]);
    const args = paramArgs(form.fields, values);
    expect(args).toEqual(["--organization", "https://git.example.org/org.git", "--employee", "support", "--provider", "codex", "--allow-guest-guard"]);
    expect(args.join(" ")).not.toContain("SECRET");
    expect(paramArgs(form.fields, { allowGuestGuard: false, organization: "" })).toEqual([]);
    // a field's own flag wins
    expect(paramArgs([{ ...form.fields[0]!, flag: "--org-source" } as FormField], { organization: "x" })).toEqual(["--org-source", "x"]);
  });
  it("format newer than known, or no format: a message, not a crash", async () => {
    const newer = parseDescribe(await describeFake("format2"));
    expect(newer).toMatchObject({ problem: "newer", format: 2 });
    expect((newer as { message: string }).message).toContain("новее");
    expect(parseInstallState({ steps: [] })).toMatchObject({ problem: "invalid" });
    const s2 = await runFake("format2");
    expect(parseInstallState(s2.state)).toMatchObject({ problem: "newer" });
  });
  it("the entry names its state file on the first line; a normal run ends done with a result", async () => {
    const { out, state } = await runFake("normal");
    expect(statePathFromOutput(out)).toMatch(/state\.json$/);
    const st = parseInstallState(state) as InstallState;
    expect(st.state).toBe("done");
    expect(st.steps.find((x) => x.state === "skipped")!.detail).toBe("на этом сервере не нужна");
    expect(st.result).toMatchObject({ role: { name: "Тестовый сотрудник", kind: "agent" }, links: [{ kind: "bb", url: "https://bb.example.org" }, { kind: "telegram", bot: "@example_test_bot" }] });
    expect(installLine(st, Date.now()).text).toBe("установлен");
  });
  it("waits for a human: what, how and the actions from the step; the block line says so and marks «ждёт»", async () => {
    const { state } = await runFake("human");
    // TERM arrived while waiting: cancelled — the waiting state is checked on a copy before that
    const st = parseInstallState(state) as InstallState;
    expect(st.state).toBe("cancelled");
    const waiting = parseInstallState({ ...(state as object), state: "human", steps: (state as { steps: unknown[] }).steps.map((x) => (x as { state: string }).state === "cancelled" ? { ...(x as object), state: "human", human: { what: "Разрешить хук в Codex", how: "карточка «Codex hooks» в BB сотрудника или кнопка ниже", actions: [{ kind: "retry", title: "Разрешить и продолжить", params: { allowGuestGuard: true } }, { kind: "cancel", title: "Отменить установку" }] } } : x), run: { ...(state as { run: object }).run, heartbeatAt: new Date().toISOString() } }) as InstallState;
    const step = currentStep(waiting)!;
    expect(step.human!.actions.map((a) => a.kind)).toEqual(["retry", "cancel"]);
    expect(step.human!.actions[0]!.params).toEqual({ allowGuestGuard: true });
    expect(installLine(waiting, Date.now())).toMatchObject({ text: "устанавливается: Защита гостевых разговоров", waiting: true });
  });
  it("an error: text, retry and the last log lines", async () => {
    const st = parseInstallState((await runFake("error")).state) as InstallState;
    expect(st.state).toBe("error");
    const step = currentStep(st)!;
    expect(step.error).toEqual({ text: "сервер задач не ответил за 30 с", retry: true, log: ["connect tasks.example.com:443 …", "timeout after 30 s"] });
    expect(installLine(st, Date.now()).failed).toBe(true);
  });
  it("hung: going and the heartbeat older than three intervals", async () => {
    const st = parseInstallState((await runFake("stuck")).state) as InstallState;
    expect(st.state).toBe("running");
    expect(isStale(st, Date.now())).toBe(true);
    expect(installLine(st, Date.now()).text).toBe("установщик не отвечает");
    expect(isStale({ ...st, run: { ...st.run, heartbeatAt: Date.now() } }, Date.now())).toBe(false);
  });
  it("an unknown step is shown by its title and state; an unknown state is kept as is", async () => {
    const st = parseInstallState((await runFake("unknown-step")).state) as InstallState;
    expect(st.steps.find((x) => x.id === "x-new-step")).toMatchObject({ title: "Новый шаг установщика", state: "done" });
    const odd = parseInstallState({ format: 1, state: "running", run: {}, steps: [{ id: "z", title: "Z", state: "paused" }] }) as InstallState;
    expect(odd.steps[0]).toMatchObject({ state: "unknown", rawState: "paused" });
  });
  it("the plugin's code names no step ids and no parameter names (only the format's fields)", () => {
    const code = ["lib/install.ts", "lib/install-server.ts", "install-ui.tsx", "app.tsx"].map((f) => readFileSync(join(process.cwd(), f), "utf8")).join("\n");
    for (const name of ["environment", "account", "guest-guard", "keys", "mcp", "organization", "allowGuestGuard", "telegramBot", "--employee", "--organization", "provider\""]) {
      expect(code.includes(`"${name}"`) || code.includes(`'${name}'`), name).toBe(false);
    }
  });
});

// ---------- the server with bb's terminal replaced by real local processes running the fake entry ----------

function hostWithTerminals(scenario: string, dir: string, bin: string) {
  const procs = new Map<string, { p: ChildProcess; out: string; exit: number | null; closed: boolean }>();
  let n = 0;
  return createFakePluginHost({
    pluginId: "agent-roster",
    settings: { installCommand: bin },
    sdk: {
      threads: { get: async ({ threadId }: { threadId: string }) => makeThreadResponse({ id: threadId, archivedAt: null, updatedAt: 1 }) },
      hosts: { list: async () => [{ id: "host_test", name: "Тестовая машина", status: "connected" }, { id: "host_off", name: "Выключенная", status: "disconnected" }] },
      terminals: {
        create: async ({ start }: { start: { argv: string[] } }) => {
          const id = `t${++n}`;
          const [cmd, ...rest] = start.argv;
          const p = spawn(cmd!, rest, { env: { ...process.env, FAKE_VALLIS_SCENARIO: scenario, FAKE_VALLIS_DIR: dir, FAKE_VALLIS_STEP_MS: "200" } });
          const rec = { p, out: "", exit: null as number | null, closed: false };
          p.stdout!.on("data", (d) => { rec.out += d; });
          p.on("exit", (code) => { rec.exit = code ?? 1; rec.closed = true; });
          p.on("error", () => { rec.exit = 127; rec.closed = true; });
          procs.set(id, rec);
          return { id };
        },
        output: async ({ terminalId }: { terminalId: string }) => {
          const r = procs.get(terminalId)!;
          return { chunks: [{ dataBase64: Buffer.from(r.out).toString("base64"), seq: 1 }], exitCode: r.exit, closeReason: r.closed ? "process-exit" : null };
        },
        close: async ({ terminalId }: { terminalId: string }) => { const r = procs.get(terminalId); if (r && !r.closed) r.p.kill("SIGHUP"); return {}; },
      },
    } as never,
  });
}

async function serverFor(scenario: string) {
  const dir = mkdtempSync(join(tmpdir(), "fvs-"));
  const bin = join(dir, "vallis-install"); // the setting points at a wrapper that runs the fake entry
  writeFileSync(bin, `#!/bin/sh\nexec node ${FAKE} "$@"\n`);
  chmodSync(bin, 0o755);
  const host = hostWithTerminals(scenario, join(dir, "state"), bin);
  await plugin(host.bb);
  return host;
}
type Host = Awaited<ReturnType<typeof serverFor>>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const call = (h: Host, method: string, input: unknown) => h.harness.behavior.callRpc(method, input as never) as Promise<any>;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const VALUES = { organization: "https://git.example.org/org.git", employee: "support" };

describe("0.5: install screen server on the fake entry", () => {
  it("machines from bb; describe; start; reads at most every 10 s; the result becomes an agent record with links", async () => {
    const host = await serverFor("normal");
    expect((await call(host, "install_machines", null)).machines).toEqual([{ id: "host_test", name: "Тестовая машина", connected: true }, { id: "host_off", name: "Выключенная", connected: false }]);
    const form = await call(host, "install_describe", { hostId: "host_test" });
    expect(form.fields).toHaveLength(5);
    const rec = await call(host, "install_start", { hostId: "host_test", fields: form.fields, values: { ...VALUES, telegramBot: "123:SECRET" } });
    expect(rec.statePath).toMatch(/state\.json$/);
    expect(JSON.stringify(rec.values)).not.toContain("SECRET");
    const reads = () => host.harness.inspection.sdk.callsTo("terminals.create").filter((c: { args: unknown }) => JSON.stringify(c).includes('"cat"')).length;
    const before = reads();
    expect(rec.last.state).toBe("running");
    await wait(300);
    await call(host, "install_read", { id: rec.id });
    expect(reads()).toBe(before); // < 10 s since the last read: no new read
    // pretend 10 s passed: one read; the install is done by now
    await wait(1800);
    await host.bb.storage.kv.set("installs", ((await host.bb.storage.kv.get("installs")) as { lastReadAt: number }[]).map((r) => ({ ...r, lastReadAt: 0 })));
    const done = await call(host, "install_read", { id: rec.id });
    expect(reads()).toBe(before + 1);
    expect(done.last.state).toBe("done");
    const after = await call(host, "install_read", { id: rec.id });
    expect(reads()).toBe(before + 1); // done: no more reads
    void after;
    const { roleId } = await call(host, "install_finish", { id: rec.id });
    const list = await call(host, "roster_list", null);
    const role = list.roles.find((r: { id: string }) => r.id === roleId);
    expect(role).toMatchObject({ name: "Тестовый сотрудник", kind: "agent", responsibility: "отвечает на вопросы клиентов (пример)", links: [{ kind: "bb", url: "https://bb.example.org", bot: null }, { kind: "telegram", url: null, bot: "@example_test_bot" }] });
    expect((await call(host, "install_finish", { id: rec.id })).roleId).toBe(roleId); // once
  }, 20_000);
  it("waits for a human; «retry» with params runs the entry again with the parameter and goes on; «cancel» stops with TERM", async () => {
    const host = await serverFor("human");
    const form = await call(host, "install_describe", { hostId: "host_test" });
    const rec = await call(host, "install_start", { hostId: "host_test", fields: form.fields, values: VALUES });
    await wait(1500);
    await host.bb.storage.kv.set("installs", ((await host.bb.storage.kv.get("installs")) as { lastReadAt: number }[]).map((r) => ({ ...r, lastReadAt: 0 })));
    const waiting = await call(host, "install_read", { id: rec.id });
    expect(waiting.last.state).toBe("human");
    const step = currentStep(waiting.last)!;
    const retry = step.human!.actions.find((a) => a.kind === "retry")!;
    const again = await call(host, "install_action", { id: rec.id, kind: "retry", params: retry.params });
    const argv = JSON.stringify(host.harness.inspection.sdk.callsTo("terminals.create").at(-2));
    expect(argv).toContain("--allow-guest-guard");
    void again;
    await wait(2500);
    await host.bb.storage.kv.set("installs", ((await host.bb.storage.kv.get("installs")) as { lastReadAt: number }[]).map((r) => ({ ...r, lastReadAt: 0 })));
    expect((await call(host, "install_read", { id: rec.id })).last.state).toBe("done");

    const host2 = await serverFor("cancel");
    const rec2 = await call(host2, "install_start", { hostId: "host_test", fields: form.fields, values: VALUES });
    await wait(1500);
    const cancelled = await call(host2, "install_action", { id: rec2.id, kind: "cancel", params: {} });
    expect(cancelled.last.state).toBe("cancelled");
    expect(cancelled.last.steps.find((x: { state: string }) => x.state === "cancelled").title).toBe("Защита гостевых разговоров");
  }, 30_000);
  it("no installer on the machine: a message, not a crash", async () => {
    const host = await serverFor("normal");
    await host.harness.behavior.setSettings({ installCommand: "/nonexistent/vallis-install" });
    const form = await call(host, "install_describe", { hostId: "host_test" });
    expect(form).toMatchObject({ problem: "missing" });
  });
});
