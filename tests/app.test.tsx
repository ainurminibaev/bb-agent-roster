// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { act, fireEvent, waitFor } from "@testing-library/react";
import { rpcContract } from "../server";
import { loadPluginApp, mountPluginContentScripts, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import type { ResolvedRole } from "../model";
import { getState, resetStore, setState } from "../lib/store";
import { HOST_ATTR } from "../lib/anchor";

const app = await loadPluginApp(() => import("../app"));

function resolved(p: Partial<ResolvedRole> & { id: string; name: string }): ResolvedRole {
  return {
    kind: "orchestrator", responsibility: "", icon: "", parentId: null, projectId: null,
    binding: { mode: "pinned", threadId: `thr_${p.id}` }, createdAt: 0, updatedAt: 0,
    active: { kind: "thread", threadId: `thr_${p.id}`, reason: "pinned" }, parentName: null, ...p,
  };
}
const ROLES = [
  resolved({ id: "lead", name: "Lead", kind: "agent" }),
  resolved({ id: "site", name: "Site", parentId: "lead", parentName: "Lead" }),
];
function row(id: string, parentThreadId: string | null, extra: Record<string, unknown> = {}) {
  return { id, parentThreadId, status: "idle", indicator: "none", hasPendingInteraction: false, isArchived: false, isHidden: false, ...extra };
}
const THREADS = [
  row("thr_lead", null, { hasPendingInteraction: true, indicator: "waiting-for-input" }),
  row("thr_site", null, { status: "active", indicator: "runtime" }),
  row("thr_x1", "thr_site"),
  row("thr_x2", "thr_site", { status: "error", indicator: "unread-error" }),
];

function standardSidebar() {
  document.body.innerHTML = `<div data-sidebar="sidebar"><nav>Search threads</nav><div data-sidebar="content"><div id="bb-list">thread rows</div></div></div>`;
}
function machineTabsSidebar() {
  document.body.innerHTML = `<div data-sidebar="sidebar"><div data-sidebar="content"><div id="mt-root"><div class="machine-tabs-search">search</div><div data-machine-tabs-list data-machine-tabs-recent id="recent">Last 5</div><div data-machine-tabs-list id="list">rows</div></div></div></div>`;
}
const frame = () => new Promise((r) => setTimeout(r, 120));

afterEach(() => {
  resetStore();
  document.body.innerHTML = "";
});

describe("registrations", () => {
  it("registers the block, page, menu actions, row mark and dialog owner", () => {
    expect(app.contentScripts.map((c) => c.id)).toEqual(["sidebar-block"]);
    expect(app.navPanels.map((p) => p.path)).toEqual(["agents"]);
    expect(app.appOverlays.map((o) => o.id)).toEqual(["roster"]);
    expect(app.threadActions.map((a) => a.id)).toEqual(["role", "remove-role"]);
    // A thread row gets one role mark: the row status. No second row-metadata mark.
    expect(app.threadRowMetadata ?? []).toHaveLength(0);
  });
});

describe("sidebar placement", () => {
  it("bb's own list: the block goes first in the list area, under the navigation search", async () => {
    standardSidebar();
    const scripts = await mountPluginContentScripts(app, { pluginId: "agent-roster" });
    await frame();
    const content = document.querySelector('[data-sidebar="content"]')!;
    expect(content.firstElementChild?.hasAttribute(HOST_ATTR)).toBe(true);
    expect(getState().host).not.toBeNull();
    expect(document.body.innerHTML).toMatchSnapshot();
    await scripts.lifecycle.dispose();
    expect(document.querySelector(`[${HOST_ATTR}]`)).toBeNull();
  });

  it("Machine Tabs list: after its search, above Last 5", async () => {
    machineTabsSidebar();
    const scripts = await mountPluginContentScripts(app, { pluginId: "agent-roster" });
    await frame();
    const host = document.querySelector(`[${HOST_ATTR}]`)!;
    expect(host.previousElementSibling?.className).toBe("machine-tabs-search");
    expect(host.nextElementSibling?.id).toBe("recent");
    expect((host as HTMLElement).dataset.layout).toBe("machine-tabs");
    expect(document.body.innerHTML).toMatchSnapshot();
    await scripts.lifecycle.dispose();
  });

  it("Machine Tabs still loading its list: right after its search", async () => {
    document.body.innerHTML = `<div data-sidebar="sidebar"><div data-sidebar="content"><div id="mt"><div id="tabs">tabs</div><div class="machine-tabs-search">search</div><style></style><div id="wait">Waiting…</div></div></div></div>`;
    const scripts = await mountPluginContentScripts(app, { pluginId: "agent-roster" });
    await frame();
    const host = document.querySelector(`[${HOST_ATTR}]`)!;
    expect(host.previousElementSibling?.className).toBe("machine-tabs-search");
    await scripts.lifecycle.dispose();
  });

  it("the real app body wins over a section sidebar (Settings, Plugins)", async () => {
    document.body.innerHTML = `<div data-sidebar="sidebar"><div data-testid="nav-rail-sidebar-body"><div data-testid="app-sidebar-body" hidden><div data-sidebar="content" id="main"></div></div><div data-testid="settings-sidebar-body"><div data-sidebar="content" id="settings"></div></div></div></div>`;
    const scripts = await mountPluginContentScripts(app, { pluginId: "agent-roster" });
    await frame();
    expect(document.querySelector(`[${HOST_ATTR}]`)!.parentElement!.id).toBe("main");
    document.querySelector('[data-testid="app-sidebar-body"]')!.remove();
    await frame();
    expect(document.querySelector(`[${HOST_ATTR}]`)).toBeNull();
    await scripts.lifecycle.dispose();
  });

  it("no anchor: nothing drawn, nothing thrown; anchor removed later: block goes away", async () => {
    document.body.innerHTML = `<main>other layout</main>`;
    const scripts = await mountPluginContentScripts(app, { pluginId: "agent-roster" });
    await frame();
    expect(document.querySelector(`[${HOST_ATTR}]`)).toBeNull();
    expect(getState().host).toBeNull();
    standardSidebar();
    await frame();
    expect(getState().host).not.toBeNull();
    document.querySelector('[data-sidebar="sidebar"]')!.remove();
    await frame();
    expect(getState().host).toBeNull();
    await scripts.lifecycle.dispose();
  });

  it("marks role threads in bb's list and clears the marks on removal and disable", async () => {
    standardSidebar();
    const scripts = await mountPluginContentScripts(app, { pluginId: "agent-roster" });
    act(() => setState({ roles: ROLES }));
    expect(scripts.inspection.getThreadRowStatus("thr_site")).toMatchObject({ icon: "agent-roster/crown", label: "оркестратор: Site" });
    act(() => setState({ roles: [ROLES[0]] }));
    expect(scripts.inspection.getThreadRowStatus("thr_site")).toBeNull();
    await scripts.lifecycle.dispose();
    expect(scripts.inspection.getThreadRowStatus("thr_lead")).toBeNull();
  });
});

describe("block, page, dialog", () => {
  it("empty list: the block offers to add the first agent", async () => {
    standardSidebar();
    const scripts = await mountPluginContentScripts(app, { pluginId: "agent-roster" });
    await frame();
    const slot = renderSlot(app.appOverlays[0]!, {}, { rpc: { roster_list: () => ({ roles: [], launchDocUrl: null }) } as never });
    await waitFor(() => expect(document.querySelector(`[${HOST_ATTR}]`)!.textContent).toContain("Добавить первого агента"));
    slot.lifecycle.unmount();
    await scripts.lifecycle.dispose();
  });

  it("non-empty: a two-level tree with state, executors and errors, and a plus", async () => {
    machineTabsSidebar();
    const scripts = await mountPluginContentScripts(app, { pluginId: "agent-roster" });
    await frame();
    const slot = renderSlot(app.appOverlays[0]!, {}, {
      rpc: { roster_list: () => ({ roles: ROLES, launchDocUrl: null }) } as never,
      sidebarThreads: { threads: THREADS as never },
    });
    const host = document.querySelector(`[${HOST_ATTR}]`)!;
    await waitFor(() => expect(host.querySelectorAll("[data-agent-roster-role]")).toHaveLength(2));
    const site = host.querySelector('[data-agent-roster-role="site"]')!;
    expect(site.getAttribute("data-state")).toBe("running");
    expect(site.textContent).toContain("↳2");
    expect(site.textContent).toContain("⊗1");
    expect(host.querySelector('[data-agent-roster-role="lead"]')!.getAttribute("data-state")).toBe("waiting");
    expect(host.querySelector('[aria-label="Добавить агента"]')).not.toBeNull();
    // One role icon per record row, state drawn as a dot or spinner, never a second picture.
    for (const li of host.querySelectorAll("[data-agent-roster-role]")) {
      expect(li.querySelectorAll("[data-role-icon]")).toHaveLength(1);
      expect(li.querySelectorAll("[data-state-mark]")).toHaveLength(1);
      expect(li.querySelectorAll("[data-state-mark] svg, [data-state-mark] img")).toHaveLength(0);
    }
    (site.querySelector("button") as HTMLButtonElement).click();
    expect(JSON.stringify(slot.inspection.navigateCalls)).toContain("thr_site");
    expect(host.innerHTML).toMatchSnapshot();
    slot.lifecycle.unmount();
    await scripts.lifecycle.dispose();
  });

  it("page: tree, add button and a settings button per record; badge counts waiting roles", async () => {
    const page = renderSlot(app.navPanels[0]!, { subPath: "" }, {
      rpc: { roster_list: () => ({ roles: ROLES, launchDocUrl: "https://example.org/launch" }) } as never,
      sidebarThreads: { threads: THREADS as never },
    });
    await page.findByText("Site");
    expect(page.getAllByLabelText(/Настроить/)).toHaveLength(2);
    page.lifecycle.unmount();
  });

  it("thread menu: offers to make an orchestrator, or to change and remove a role", () => {
    const [assign, remove] = app.threadActions;
    const thread = { id: "thr_new", projectId: "p1" } as never;
    const data = { roles: ROLES, rpc: { call: async () => ({ removed: true }) } };
    const ctx = { data, sdk: {} as never, navigate: {} as never, experimental_panel: {} as never };
    expect(assign!.item({ thread, ...ctx } as never)?.label).toBe("Сделать оркестратором…");
    expect(remove!.item({ thread, ...ctx } as never)).toBeNull();
    const withRole = { id: "thr_site", projectId: "p1" } as never;
    expect(assign!.item({ thread: withRole, ...ctx } as never)?.label).toBe("Изменить роль…");
    expect(remove!.item({ thread: withRole, ...ctx } as never)?.label).toBe("Снять роль");
  });

  it("the menu action opens the short dialog bound to the thread", async () => {
    const saved: unknown[] = [];
    const slot = renderSlot(app.appOverlays[0]!, {}, {
      experimental_rpcContract: rpcContract,
      rpc: {
        roster_list: () => ({ roles: [], launchDocUrl: null }),
        roster_upsert: (input: unknown) => { saved.push(input); return { ...(input as object), id: "x", createdAt: 0, updatedAt: 0 }; },
      } as never,
    });
    const [assign] = app.threadActions;
    const action = assign!.item({ thread: { id: "thr_new", projectId: "p1" }, data: { roles: [], rpc: {} }, sdk: {}, navigate: {}, experimental_panel: {} } as never)!;
    act(() => void action.run({ requestRename: () => undefined }));
    expect((await slot.findAllByText("Сделать оркестратором")).length).toBeGreaterThan(0);
    const dialog = document.querySelector("[data-agent-roster-dialog]")!;
    expect(dialog.textContent).toContain("Кому подчиняется");
    fireEvent.change(dialog.querySelector("input")!, { target: { value: "Orchestrator" } });
    fireEvent.submit(dialog.querySelector("form")!);
    await waitFor(() => expect(saved).toHaveLength(1));
    expect(saved[0]).toMatchObject({ name: "Orchestrator", kind: "orchestrator", projectId: "p1", binding: { mode: "pinned", threadId: "thr_new" } });
    expect(saved[0]).not.toHaveProperty("id");
    slot.lifecycle.unmount();
  });
});
