// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { act, fireEvent, waitFor } from "@testing-library/react";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { resetStore, setState } from "../lib/store";
import { InstallDialog, InstallRows } from "../install-ui";
import { parseDescribe, parseInstallState, parseJson, type InstallState } from "../lib/install";

const FAKE = join(process.cwd(), "tests", "fake-vallis-install.mjs");
const describeJson = (scenario = "normal") => parseDescribe(parseJson(spawnSync("node", [FAKE, "employee", "--describe", "--json"], { env: { ...process.env, FAKE_VALLIS_SCENARIO: scenario } }).stdout.toString()));
/** The fake entry's state file after it ran with a scenario (stops a waiting run after a moment). */
function stateOf(scenario: string): unknown {
  const dir = mkdtempSync(join(tmpdir(), "fvu-"));
  spawnSync("node", [FAKE, "employee"], { env: { ...process.env, FAKE_VALLIS_SCENARIO: scenario, FAKE_VALLIS_DIR: dir, FAKE_VALLIS_STEP_MS: "5" }, timeout: scenario === "human" ? 600 : 10_000, killSignal: "SIGKILL" });
  return JSON.parse(readFileSync(join(dir, "state.json"), "utf8"));
}
const rec = (last: unknown, extra: Record<string, unknown> = {}) => ({
  id: "i-1", hostId: "host_test", values: {}, fields: [], terminalId: "t1", pid: 1, statePath: "/tmp/x/state.json", startedAt: 0,
  last: last === null ? null : parseInstallState(last), problem: null, lastReadAt: 0, roleId: null, ...extra,
});

afterEach(() => { resetStore(); document.body.innerHTML = ""; });

describe("0.5: install screen", () => {
  it("step 0: connected machines to pick, a disconnected one greyed; the enroll instruction and the launch doc", async () => {
    act(() => setState({ install: "new", launchDocUrl: "https://docs.example.org/launch" }));
    const slot = renderSlot({ component: InstallDialog as never }, {}, { rpc: { install_machines: () => ({ machines: [{ id: "host_test", name: "Тестовая", connected: true }, { id: "host_off", name: "Выкл", connected: false }] }) } as never });
    await waitFor(() => expect(document.querySelector('[data-install-machine="host_test"]')).not.toBeNull());
    expect((document.querySelector('[data-install-machine="host_off"]') as HTMLButtonElement).disabled).toBe(true);
    expect(document.querySelector("[data-install-enroll]")!.textContent).toContain("bb machine enroll");
    expect(document.querySelector("[data-install-doc]")).not.toBeNull();
    slot.lifecycle.unmount();
  });

  it("step 1: the form is built from --describe; a secret field has no input; start sends no secret", async () => {
    const started: unknown[] = [];
    act(() => setState({ install: "new" }));
    const slot = renderSlot({ component: InstallDialog as never }, {}, { rpc: {
      install_machines: () => ({ machines: [{ id: "host_test", name: "Тестовая", connected: true }] }),
      install_describe: () => describeJson(),
      install_start: (input: unknown) => { started.push(input); return rec(stateOf("normal")); },
      install_read: () => rec(stateOf("normal")),
      install_finish: () => ({ roleId: "x" }),
    } as never });
    await waitFor(() => expect(document.querySelector('[data-install-machine="host_test"]')).not.toBeNull());
    act(() => (document.querySelector('[data-install-machine="host_test"]') as HTMLButtonElement).click());
    await waitFor(() => expect(document.querySelector("[data-install-form]")).not.toBeNull());
    const form = document.querySelector("[data-install-form]")!;
    expect(form.querySelectorAll("[data-install-field]")).toHaveLength(4);
    const secret = form.querySelector("[data-install-secret]")!;
    expect(secret.querySelector("input")).toBeNull();
    expect(secret.textContent).toContain("TELEGRAM_BOT");
    expect(document.querySelector("[data-install-missing]")!.textContent).toContain("Организация");
    fireEvent.change(form.querySelector('[data-install-field="organization"] input')!, { target: { value: "https://git.example.org/org.git" } });
    fireEvent.change(form.querySelector('[data-install-field="employee"] select')!, { target: { value: "support" } });
    fireEvent.submit(form);
    await waitFor(() => expect(started).toHaveLength(1));
    expect((started[0] as { values: Record<string, unknown> }).values).toEqual({ provider: "codex", allowGuestGuard: false, organization: "https://git.example.org/org.git", employee: "support" });
    await waitFor(() => expect(document.querySelector("[data-install-result]")).not.toBeNull());
    expect(document.querySelector("[data-install-result]")!.textContent).toContain("Тестовый сотрудник");
    slot.lifecycle.unmount();
  });

  it("step 3: a human step shows what, how and the installer's buttons; pressing one sends its kind and params", async () => {
    const acts: unknown[] = [];
    const human = stateOf("human") as { steps: { state: string }[]; state: string; run: { heartbeatAt: string } };
    human.run.heartbeatAt = new Date().toISOString();
    act(() => setState({ install: "i-1" }));
    const slot = renderSlot({ component: InstallDialog as never }, {}, { rpc: {
      install_read: () => rec(human),
      install_action: (input: unknown) => { acts.push(input); return rec(human); },
    } as never });
    await waitFor(() => expect(document.querySelector("[data-install-human]")).not.toBeNull());
    const box = document.querySelector("[data-install-human]")!;
    expect(box.textContent).toContain("Разрешить хук в Codex");
    expect(box.textContent).toContain("карточка «Codex hooks»");
    act(() => (box.querySelector('[data-install-action="retry"]') as HTMLButtonElement).click());
    await waitFor(() => expect(acts).toHaveLength(1));
    expect(acts[0]).toEqual({ id: "i-1", kind: "retry", params: { allowGuestGuard: true } });
    expect(box.querySelector('[data-install-action="cancel"]')!.textContent).toBe("Отменить установку");
    slot.lifecycle.unmount();
  });

  it("an error: text, «подробности» with the log, «повторить»; hung: said in words with «повторить»; an unknown step as is", async () => {
    const err = stateOf("error");
    act(() => setState({ install: "i-1" }));
    let slot = renderSlot({ component: InstallDialog as never }, {}, { rpc: { install_read: () => rec(err) } as never });
    await waitFor(() => expect(document.querySelector("[data-install-error]")).not.toBeNull());
    const box = document.querySelector("[data-install-error]")!;
    expect(box.textContent).toContain("сервер задач не ответил за 30 с");
    expect(box.querySelector('[data-install-action="continue"]')).not.toBeNull();
    act(() => (box.querySelector("[data-install-log-toggle]") as HTMLButtonElement).click());
    expect(document.querySelector("[data-install-log]")!.textContent).toContain("timeout after 30 s");
    slot.lifecycle.unmount();
    document.body.innerHTML = "";

    act(() => setState({ install: "i-1" }));
    slot = renderSlot({ component: InstallDialog as never }, {}, { rpc: { install_read: () => rec(stateOf("stuck")) } as never });
    await waitFor(() => expect(document.querySelector("[data-install-stale]")).not.toBeNull());
    expect(document.querySelector("[data-install-stale] [data-install-action=continue]")).not.toBeNull();
    slot.lifecycle.unmount();
    document.body.innerHTML = "";

    act(() => setState({ install: "i-1" }));
    slot = renderSlot({ component: InstallDialog as never }, {}, { rpc: { install_read: () => rec(stateOf("unknown-step")), install_finish: () => ({ roleId: "x" }) } as never });
    await waitFor(() => expect(document.querySelector('[data-install-step="x-new-step"]')).not.toBeNull());
    expect(document.querySelector('[data-install-step="x-new-step"]')!.textContent).toContain("Новый шаг установщика");
    slot.lifecycle.unmount();
  });

  it("a newer format or no installer: a message and the launch doc", async () => {
    act(() => setState({ install: "new", launchDocUrl: "https://docs.example.org/launch" }));
    const slot = renderSlot({ component: InstallDialog as never }, {}, { rpc: {
      install_machines: () => ({ machines: [{ id: "host_test", name: "Тестовая", connected: true }] }),
      install_describe: () => describeJson("format2"),
    } as never });
    await waitFor(() => expect(document.querySelector('[data-install-machine="host_test"]')).not.toBeNull());
    act(() => (document.querySelector('[data-install-machine="host_test"]') as HTMLButtonElement).click());
    await waitFor(() => expect(document.querySelector('[data-install-problem="newer"]')).not.toBeNull());
    expect(document.querySelector('[data-install-problem="newer"]')!.textContent).toContain("новее");
    expect(document.querySelector('[data-install-problem] [data-install-doc]')).not.toBeNull();
    slot.lifecycle.unmount();
  });

  it("the block: «устанавливается: <шаг>» and «ждёт» while a step waits for the owner", async () => {
    const human = stateOf("human") as { run: { heartbeatAt: string } };
    human.run.heartbeatAt = new Date().toISOString();
    act(() => setState({ installs: [rec(human) as never] }));
    const slot = renderSlot({ component: InstallRows as never }, {});
    const row = slot.container.querySelector("[data-agent-roster-install]")!;
    expect(row.querySelector("[data-agent-roster-install-line]")!.textContent).toBe("устанавливается: Защита гостевых разговоров");
    expect(row.querySelector("[data-agent-roster-waiting]")).not.toBeNull();
    act(() => (row.querySelector("button") as HTMLButtonElement).click());
    slot.lifecycle.unmount();
    // a finished install with its record is not shown
    act(() => setState({ installs: [rec(stateOf("normal"), { roleId: "x" }) as never] }));
    const again = renderSlot({ component: InstallRows as never }, {});
    expect(again.container.querySelector("[data-agent-roster-install]")).toBeNull();
    again.lifecycle.unmount();
    void (null as unknown as InstallState);
  });
});
