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
    binding: { mode: "pinned", threadId: `thr_${p.id}` }, primary: false, rulesEnabled: false, createdAt: 0, updatedAt: 0,
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
    // A thread row gets one role mark, on the metadata line after the title.
    expect(app.threadRowMetadata.map((m) => m.id)).toEqual(["role-mark"]);
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

  it("a thread row gets one monochrome role mark and nothing else; no mark for a thread without a role", () => {
    const mark = app.threadRowMetadata[0]!;
    const C = mark.component as (p: unknown) => JSX.Element | null;
    const on = renderSlot({ component: C }, { thread: { id: "thr_site" }, data: ROLES } as never);
    expect(on.container.querySelectorAll("[data-agent-roster-mark]")).toHaveLength(1);
    expect(on.container.querySelector("[data-agent-roster-mark]")!.getAttribute("title")).toBe("Site — оркестратор");
    on.lifecycle.unmount();
    const off = renderSlot({ component: C }, { thread: { id: "thr_other" }, data: ROLES } as never);
    expect(off.container.querySelectorAll("[data-agent-roster-mark]")).toHaveLength(0);
    off.lifecycle.unmount();
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
    fireEvent.click(site.querySelector("[data-agent-roster-link]")!);
    expect(JSON.stringify(slot.inspection.navigateCalls)).toContain("thr_site");
    slot.lifecycle.unmount();
    await scripts.lifecycle.dispose();
  });

  it("page: tree, add button and a settings button per record; badge counts waiting roles", async () => {
    const page = renderSlot(app.navPanels[0]!, { subPath: "" }, {
      rpc: { roster_list: () => ({ roles: ROLES, launchDocUrl: "https://example.org/launch" }) } as never,
      sidebarThreads: { threads: THREADS as never },
    });
    await page.findByText("Site");
    expect(page.getAllByLabelText(/Действия:/)).toHaveLength(2);
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
        roster_upsert: (input: unknown) => { saved.push(input); return { icon: "", responsibility: "", parentId: null, projectId: null, primary: false, rulesEnabled: true, ...(input as object), id: "x", createdAt: 0, updatedAt: 0 }; },
        roster_agents_md: () => ({ status: "missing", path: "/repo/AGENTS.md", section: "## Роль: Orchestrator\n" }),
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
    await new Promise((r) => setTimeout(r, 300));
    await waitFor(() => expect(saved).toHaveLength(1));
    expect(saved[0]).toMatchObject({ name: "Orchestrator", kind: "orchestrator", projectId: "p1", binding: { mode: "pinned", threadId: "thr_new" } });
    expect(saved[0]).not.toHaveProperty("id");
    expect(saved[0]).toMatchObject({ rulesEnabled: true });
    // After promotion the dialog proposes the AGENTS.md section; nothing is written without the button.
    await waitFor(() => expect(document.querySelector('[data-agent-roster-agents-md="missing"]')).not.toBeNull());
    expect(document.body.textContent).toContain("Дописать раздел в AGENTS.md");
    slot.lifecycle.unmount();
  });
});

describe("0.2: working with an agent from the block", () => {
  it("expands executors two levels, marks «ждёт тебя», sends a quick message, offers the record menu", async () => {
    machineTabsSidebar();
    const scripts = await mountPluginContentScripts(app, { pluginId: "agent-roster" });
    await frame();
    const sent: unknown[] = [];
    const threads = [
      { ...row("thr_lead", null), title: "lead" },
      { ...row("thr_site", null), title: "site" },
      { ...row("thr_x1", "thr_site", { status: "active", indicator: "runtime" }), title: "worker one" },
      { ...row("thr_x11", "thr_x1", { hasPendingInteraction: true, indicator: "waiting-for-input" }), title: "asks a question" },
    ];
    const slot = renderSlot(app.appOverlays[0]!, {}, {
      experimental_rpcContract: rpcContract,
      rpc: {
        roster_list: () => ({ roles: ROLES, launchDocUrl: null }),
        roster_activity: () => ({ thr_site: "Закончил: отчёт", thr_lead: null }),
        roster_send: (input: unknown) => { sent.push(input); return { threadId: "thr_site" }; },
        roster_executors: () => ({ threads: [] }),
      } as never,
      sidebarThreads: { threads: threads as never },
    });
    const host = document.querySelector(`[${HOST_ATTR}]`)!;
    await waitFor(() => expect(host.querySelector('[data-agent-roster-role="site"]')).not.toBeNull());
    const site = host.querySelector('[data-agent-roster-role="site"]')!;
    // roles stand side by side: no indent for the subordinate role
    expect(site.querySelector("[data-agent-roster-toggle]")!.getAttribute("style")).toBe(host.querySelector('[data-agent-roster-role="lead"] [data-agent-roster-toggle]')!.getAttribute("style"));
    // Collapsed: the name line and one status line under it; the arrow is on the right, never on the left.
    expect(site.querySelectorAll(":scope > *")).toHaveLength(1);
    const nameLine = site.querySelector("[data-agent-roster-name-line]")!;
    const kids = Array.from(nameLine.children);
    // The sign stands left of both lines (name and status), centred on the record.
    const line = site.querySelector("[data-agent-roster-line]")!;
    const lineKids = Array.from(line.children).filter((c) => !c.hasAttribute("data-agent-roster-link"));
    expect(lineKids[0]!.hasAttribute("data-role-icon")).toBe(true);
    expect(lineKids[1]!.hasAttribute("data-agent-roster-text")).toBe(true);
    const toggleAt = kids.findIndex((c) => c.hasAttribute("data-agent-roster-toggle"));
    expect(toggleAt).toBeGreaterThan(kids.findIndex((c) => c.textContent === "Site"));
    await waitFor(() => expect(site.querySelector("[data-agent-roster-status]")?.textContent).toBe("Закончил: отчёт"));
    // waiting executor → pill → opens that very thread
    const pill = site.querySelector("[data-agent-roster-waiting]") as HTMLButtonElement;
    expect(pill.getAttribute("title")).toContain("Ждёт тебя");
    pill.click();
    expect(JSON.stringify(slot.inspection.navigateCalls)).toContain("thr_x11");
    // expand: two levels
    act(() => (site.querySelector("[data-agent-roster-toggle]") as HTMLButtonElement).click());
    const ex = Array.from(site.querySelectorAll("[data-executor]")).map((e) => [e.getAttribute("data-executor"), e.getAttribute("data-depth"), e.getAttribute("data-state")]);
    expect(ex).toEqual([["thr_x1", "1", "running"], ["thr_x11", "2", "waiting"]]);
    // record menu
    const trigger = site.querySelector("[data-agent-roster-menu-button]") as HTMLButtonElement;
    fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false, pointerType: "mouse" });
    fireEvent.click(trigger);
    await waitFor(() => expect(document.querySelectorAll("[role=menuitem]").length).toBeGreaterThan(0));
    const items = Array.from(document.querySelectorAll("[role=menuitem]")).map((e) => e.textContent);
    expect(items).toEqual(["Открыть", "Написать…", "Сведения", "Изменить роль…", "Перевести на другой тред…", "Снять роль"]);
    act(() => { fireEvent.click(document.querySelectorAll("[role=menuitem]")[1]!); });
    await waitFor(() => expect(site.querySelector("[data-agent-roster-compose] textarea")).not.toBeNull());
    const box = site.querySelector("[data-agent-roster-compose] textarea") as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: "статус?" } });
    fireEvent.keyDown(box, { key: "Enter" });
    await waitFor(() => expect(sent).toEqual([{ roleId: "site", text: "статус?" }]));
    slot.lifecycle.unmount();
    await scripts.lifecycle.dispose();
    window.localStorage.clear();
  });
});

describe("0.2: channels and project work in the row", () => {
  it("shows a Telegram mark only when the bridge reports a channel, and «own · others» of the project", async () => {
    machineTabsSidebar();
    const scripts = await mountPluginContentScripts(app, { pluginId: "agent-roster" });
    await frame();
    const roles = [
      { ...ROLES[0], channels: [{ kind: "telegram", label: "Telegram: личный чат с ботом" }] },
      { ...ROLES[1], projectId: "p" },
    ];
    const threads = [
      { ...row("thr_lead", null), title: "lead", projectId: "p" },
      { ...row("thr_site", null), title: "site", projectId: "p" },
      { ...row("thr_c", "thr_site", { status: "active", indicator: "runtime" }), title: "child", projectId: "p" },
      { ...row("thr_free", null, { status: "active", indicator: "runtime" }), title: "free", projectId: "p" },
    ];
    const slot = renderSlot(app.appOverlays[0]!, {}, {
      rpc: { roster_list: () => ({ roles, launchDocUrl: null }), roster_activity: () => ({}) } as never,
      sidebarThreads: { threads: threads as never },
    });
    const host = document.querySelector(`[${HOST_ATTR}]`)!;
    await waitFor(() => expect(host.querySelectorAll("[data-agent-roster-role]")).toHaveLength(2));
    const lead = host.querySelector('[data-agent-roster-role="lead"]')!;
    const site = host.querySelector('[data-agent-roster-role="site"]')!;
    // Telegram is a small plane on the record's icon, not a mark on the right of the row.
    expect(lead.querySelector("[data-role-icon] [data-telegram-corner]")!.getAttribute("title")).toContain("Telegram");
    expect(site.querySelector("[data-telegram-corner]")).toBeNull();
    expect(lead.querySelector("[data-agent-roster-line] > span [data-agent-roster-channel]")).toBeNull();
    expect(lead.querySelectorAll("[data-role-icon]")).toHaveLength(1);
    expect(site.querySelector("[data-agent-roster-work]")!.textContent!.replace(/\s/g, "")).toBe("↳1·1");
    const toggle = site.querySelector("[data-agent-roster-toggle]") as HTMLButtonElement;
    if (toggle.getAttribute("aria-expanded") !== "true") act(() => toggle.click());
    expect(site.querySelector("[data-agent-roster-work]")!.textContent).toBe("↳1 · 1");
    expect(site.textContent).toContain("под управлением");
    expect(site.textContent).toContain("не под управлением");
    expect(site.querySelector('[data-unmanaged="thr_free"]')).not.toBeNull();
    expect(site.querySelector('[data-executor="thr_c"]')).not.toBeNull();
    slot.lifecycle.unmount();
    await scripts.lifecycle.dispose();
    window.localStorage.clear();
  });
});

describe("0.2.1: details card", () => {
  it("«Сведения» shows name, kind, duty, project, thread, activity, executors, channels, model and last activity", async () => {
    const roles = [{ ...ROLES[1], responsibility: "сайт", projectId: "p", channels: [{ kind: "telegram", label: "Telegram: тема 5" }] }];
    const slot = renderSlot(app.appOverlays[0]!, {}, {
      rpc: {
        roster_list: () => ({ roles, launchDocUrl: null }),
        roster_activity: () => ({}),
        roster_details: () => ({ activity: "Занят: вёрстка", model: "gpt-x", providerId: "codex", lastActiveAt: 1_700_000_000_000 }),
      } as never,
      sidebarThreads: {
        threads: [{ ...row("thr_site", null), title: "Site thread", projectId: "p" }, { ...row("thr_c", "thr_site", { status: "active", indicator: "runtime" }), title: "c", projectId: "p" }] as never,
        projects: [{ id: "p", name: "Shop", isPersonal: false, href: "", settingsHref: "" }] as never,
      },
    });
    await waitFor(() => expect(getState().roles).not.toBeNull());
    act(() => setState({ dialog: { mode: "details", roleId: "site" } }));
    await waitFor(() => expect(document.querySelector("[data-agent-roster-details] [data-agent-roster-card]")).not.toBeNull());
    const card = document.querySelector("[data-agent-roster-details] [data-agent-roster-card]")!;
    await waitFor(() => expect(card.textContent).toContain("Занят: вёрстка"));
    for (const text of ["Site", "оркестратор", "сайт", "Shop", "Site thread", "свои работают 1", "Telegram: тема 5", "codex · gpt-x"]) expect(card.textContent).toContain(text);
    slot.lifecycle.unmount();
  });
});

describe("0.2.1: a record opens like bb's thread row", () => {
  it("plain click opens the active thread in place, closes the phone drawer, and the open record is highlighted", async () => {
    document.body.innerHTML = `<div role="dialog" data-state="open" id="drawer"><div data-sidebar="sidebar"><div data-testid="app-sidebar-body"><div data-sidebar="content"><div id="list"></div></div></div></div></div>`;
    let escapes = 0;
    document.getElementById("drawer")!.addEventListener("keydown", (e) => { if ((e as KeyboardEvent).key === "Escape") escapes += 1; });
    const scripts = await mountPluginContentScripts(app, { pluginId: "agent-roster" });
    await frame();
    const slot = renderSlot(app.appOverlays[0]!, {}, {
      rpc: { roster_list: () => ({ roles: ROLES, launchDocUrl: null }), roster_activity: () => ({}) } as never,
      sidebarThreads: { threads: [{ ...row("thr_lead", null), title: "lead", href: "/t/lead" }, { ...row("thr_site", null), title: "site", href: "/t/site" }] as never },
      context: { projectId: null, threadId: "thr_site" },
    });
    const host = document.querySelector(`[${HOST_ATTR}]`)!;
    await waitFor(() => expect(host.querySelectorAll("[data-agent-roster-role]")).toHaveLength(2));
    const site = host.querySelector('[data-agent-roster-role="site"]')!;
    expect(site.hasAttribute("data-active")).toBe(true);
    expect(host.querySelector('[data-agent-roster-role="lead"]')!.hasAttribute("data-active")).toBe(false);
    const link = host.querySelector('[data-agent-roster-role="lead"] [data-agent-roster-link]') as HTMLAnchorElement;
    expect(link.getAttribute("href")).toBe("/t/lead");
    fireEvent.click(link);
    expect(JSON.stringify(slot.inspection.navigateCalls)).toContain("thr_lead");
    expect(JSON.stringify(slot.inspection.navigateCalls)).not.toContain("split");
    expect(escapes).toBe(1);
    slot.lifecycle.unmount();
    await scripts.lifecycle.dispose();
  });
});

import { revealProject, revealSupported } from "../lib/reveal";
import { RoleIcon } from "../app";
describe("0.2.1: go to project and the role icon", () => {
  it("no data-sidebar-project-id anywhere → not supported; section missing → false (caller uses toProject); present → scrolls", () => {
    document.body.innerHTML = `<div data-testid="app-sidebar-body"><div id="other"></div></div>`;
    expect(revealSupported()).toBe(false);
    document.body.innerHTML = `<div data-testid="app-sidebar-body"><div data-sidebar-project-id="p1"><div data-sidebar="group-label">P1</div></div></div>`;
    expect(revealSupported()).toBe(true);
    expect(revealProject("p2")).toBe(false);
    let scrolled = 0;
    (document.querySelector('[data-sidebar-project-id="p1"]') as HTMLElement).scrollIntoView = () => { scrolled += 1; };
    expect(revealProject("p1")).toBe(true);
    expect(scrolled).toBe(1);
  });
  it("composite icon: the logo wears a 10px crown on its axis; no logo — one crown; the main record's crown is gold and larger; one drawing", () => {
    const visible = (el: Element) => (Number(el.getAttribute("width")) * 12) / 14;
    const withLogo = renderSlot({ component: RoleIcon as never }, { role: { icon: "", kind: "orchestrator" }, logo: "data:image/svg+xml;base64,AA" } as never);
    expect(withLogo.container.querySelectorAll("[data-role-icon]")).toHaveLength(1);
    expect(withLogo.container.querySelector("img")!.getAttribute("style")).toContain("grayscale(1)");
    expect(visible(withLogo.container.querySelector('[data-crown="top"] svg')!)).toBeCloseTo(10);
    withLogo.lifecycle.unmount();
    const plain = renderSlot({ component: RoleIcon as never }, { role: { icon: "", kind: "agent" }, logo: null } as never);
    expect(visible(plain.container.querySelector('[data-crown="alone"] svg')!)).toBeCloseTo(18);
    plain.lifecycle.unmount();
    const main = renderSlot({ component: RoleIcon as never }, { role: { icon: "", kind: "agent", primary: true }, logo: "data:image/svg+xml;base64,AA", telegram: "Telegram: чат" } as never);
    expect(main.container.querySelector("img")).toBeNull();
    const svg = main.container.querySelector('[data-crown="alone"] svg')!;
    expect(visible(svg)).toBeCloseTo(21);
    expect(svg.innerHTML).toContain("#e8c24a");
    expect(main.container.querySelector("[data-telegram-corner]")!.getAttribute("title")).toBe("Telegram: чат");
    main.lifecycle.unmount();
  });
});

describe("part B: one mark per row", () => {
  it("when Machine Tabs draws role marks on icons, the row metadata mark is not drawn", () => {
    const C = app.threadRowMetadata[0]!.component as (p: unknown) => JSX.Element | null;
    act(() => setState({ iconMarks: true }));
    const r = renderSlot({ component: C }, { thread: { id: "thr_site" }, data: ROLES } as never);
    expect(r.container.querySelectorAll("[data-agent-roster-mark]")).toHaveLength(0);
    r.lifecycle.unmount();
    act(() => setState({ iconMarks: false }));
    const r2 = renderSlot({ component: C }, { thread: { id: "thr_site" }, data: ROLES } as never);
    expect(r2.container.querySelectorAll("[data-agent-roster-mark]")).toHaveLength(1);
    r2.lifecycle.unmount();
  });
});

import { readFileSync } from "node:fs";
import { CROWN_PATH } from "../app";
describe("0.3.2: one crown drawing", () => {
  it("the declared crown icon and the sign's crown are the same shape", () => {
    expect(readFileSync(`${process.cwd()}/icons/crown.svg`, "utf8")).toContain(`d="${CROWN_PATH}"`);
  });
});

describe("0.3.3: expanded record — live executors first, archived folded", () => {
  it("shows only live executors (≤7, then «ещё N»); finished and archived behind «архивные (N)», folded on every opening", async () => {
    machineTabsSidebar();
    const scripts = await mountPluginContentScripts(app, { pluginId: "agent-roster" });
    await frame();
    const live = Array.from({ length: 9 }, (_, i) => ({ ...row(`thr_l${i}`, "thr_site", { status: "active", indicator: "runtime" }), title: `live ${i}` }));
    const threads = [{ ...row("thr_lead", null), title: "lead" }, { ...row("thr_site", null), title: "site" }, ...live, { ...row("thr_done", "thr_site"), title: "done" }];
    const slot = renderSlot(app.appOverlays[0]!, {}, {
      rpc: {
        roster_list: () => ({ roles: ROLES, launchDocUrl: null }),
        roster_activity: () => ({}),
        roster_executors: () => ({ threads: [{ id: "thr_arch", parentThreadId: "thr_site", title: "archived one", status: "idle", isArchived: true }] }),
      } as never,
      sidebarThreads: { threads: threads as never },
    });
    const host = document.querySelector(`[${HOST_ATTR}]`)!;
    await waitFor(() => expect(host.querySelector('[data-agent-roster-role="site"]')).not.toBeNull());
    const site = host.querySelector('[data-agent-roster-role="site"]')!;
    const toggle = site.querySelector("[data-agent-roster-toggle]") as HTMLButtonElement;
    if (toggle.getAttribute("aria-expanded") !== "true") act(() => toggle.click());
    await waitFor(() => expect(site.querySelector("[data-agent-roster-show-finished]")?.textContent).toBe("архивные (2)"));
    expect(site.querySelectorAll("[data-executor]")).toHaveLength(7);
    expect(site.querySelector("[data-executor][data-archived]")).toBeNull();
    expect(site.querySelector('[data-executor="thr_done"]')).toBeNull();
    expect(site.querySelector("[data-agent-roster-more-live]")!.textContent).toBe("ещё 2");
    act(() => (site.querySelector("[data-agent-roster-show-finished]") as HTMLButtonElement).click());
    const group = site.querySelector("[data-agent-roster-archived]")!;
    expect(Array.from(group.querySelectorAll("[data-executor]")).map((e) => e.getAttribute("data-executor")).sort()).toEqual(["thr_arch", "thr_done"]);
    // Collapse and open again: the archived group is folded again.
    act(() => (site.querySelector("[data-agent-roster-toggle]") as HTMLButtonElement).click());
    act(() => (site.querySelector("[data-agent-roster-toggle]") as HTMLButtonElement).click());
    await waitFor(() => expect(site.querySelector("[data-agent-roster-show-finished]")).not.toBeNull());
    expect(site.querySelector("[data-agent-roster-archived]")).toBeNull();
    slot.lifecycle.unmount();
    await scripts.lifecycle.dispose();
    window.localStorage.clear();
  });
});

describe("0.4.3: no element takes place only for the hover", () => {
  it("no title on the record, no «go to project» icon in the row, nothing appears in the row's flow on hover", async () => {
    machineTabsSidebar();
    const scripts = await mountPluginContentScripts(app, { pluginId: "agent-roster" });
    await frame();
    const slot = renderSlot(app.appOverlays[0]!, {}, {
      rpc: { roster_list: () => ({ roles: ROLES, launchDocUrl: null }), roster_activity: () => ({}) } as never,
      sidebarThreads: { threads: [{ ...row("thr_lead", null), title: "lead", projectId: "p" }, { ...row("thr_site", null), title: "site", projectId: "p" }] as never },
    });
    const host = document.querySelector(`[${HOST_ATTR}]`)!;
    await waitFor(() => expect(host.querySelectorAll("[data-agent-roster-role]")).toHaveLength(2));
    for (const line of host.querySelectorAll("[data-agent-roster-line]")) {
      expect(line.hasAttribute("title")).toBe(false);
      expect(line.querySelector("[data-agent-roster-reveal]")).toBeNull();
      // Every element of the row is in the flow from the start: no `hidden` that turns into `flex` on hover.
      for (const el of line.querySelectorAll("*")) expect((el.getAttribute("class") ?? "").split(/\s+/)).not.toContain("hidden");
      // «⋯» takes no place only for the hover: it sits in an absolute layer over the state cell (mouse),
      // invisible until hover; the state cell is the row's last element in the flow.
      const slot = line.querySelector("[data-agent-roster-menu-slot]")!;
      const cls = (slot.getAttribute("class") ?? "").split(/\s+/);
      expect(cls).toEqual(expect.arrayContaining(["absolute", "invisible", "group-hover/role:visible"]));
      const nameLine = line.querySelector("[data-agent-roster-name-line]")!;
      const flow = Array.from(nameLine.children).filter((c) => !(c.getAttribute("class") ?? "").split(/\s+/).includes("absolute"));
      expect(flow.at(-1)!.hasAttribute("data-agent-roster-trailing")).toBe(true);
      expect(flow.at(-2)!.hasAttribute("data-agent-roster-toggle")).toBe(true);
    }
    slot.lifecycle.unmount();
    await scripts.lifecycle.dispose();
  });
});

import { experimental_resolveThreadStatus as bbResolve } from "@get-bb/plugin-sdk/app";
describe("0.4.2: the same state signs as bb's thread rows", () => {
  it("a record and its executor rows draw bb's glyph for the same state; a failed queued message is named in words", async () => {
    machineTabsSidebar();
    const scripts = await mountPluginContentScripts(app, { pluginId: "agent-roster" });
    await frame();
    const base = { activity: { workflows: 0, backgroundAgents: 0, backgroundCommands: 0, planMode: 0 }, runtimeStatus: "idle", isUnread: false };
    const site = { ...row("thr_site", null, { status: "idle", indicator: "queued-failed", queuedWork: "failed" }), ...base, title: "site" };
    const child = { ...row("thr_c", "thr_site", { status: "active", indicator: "runtime" }), ...base, runtimeStatus: "active", queuedWork: "none", title: "child" };
    const lead = { ...row("thr_lead", null), ...base, queuedWork: "none", title: "lead" };
    const slot = renderSlot(app.appOverlays[0]!, {}, {
      rpc: { roster_list: () => ({ roles: ROLES, launchDocUrl: null }), roster_activity: () => ({}), roster_executors: () => ({ threads: [] }), roster_details: () => ({ activity: null, model: null, providerId: null, lastActiveAt: null }) } as never,
      sidebarThreads: { threads: [lead, site, child] as never },
    });
    const host = document.querySelector(`[${HOST_ATTR}]`)!;
    await waitFor(() => expect(host.querySelector('[data-agent-roster-role="site"] [data-state-mark]')).not.toBeNull());
    const rec = host.querySelector('[data-agent-roster-role="site"]')!;
    const expected = bbResolve({ thread: site as never, hiddenThreads: [child as never], hasUnsubmittedDraft: false, rowStatus: null }).indicator;
    expect(rec.querySelector("[data-agent-roster-line] [data-state-mark]")!.getAttribute("data-indicator")).toBe(expected);
    // no home-made red dot anywhere
    expect(rec.querySelector(".bg-red-500")).toBeNull();
    const toggle = rec.querySelector("[data-agent-roster-toggle]") as HTMLButtonElement;
    if (toggle.getAttribute("aria-expanded") !== "true") act(() => toggle.click());
    await waitFor(() => expect(rec.querySelector('[data-executor="thr_c"] [data-state-mark]')).not.toBeNull());
    const childExpected = bbResolve({ thread: child as never, hiddenThreads: [], hasUnsubmittedDraft: false, rowStatus: null }).indicator;
    expect(rec.querySelector('[data-executor="thr_c"] [data-state-mark]')!.getAttribute("data-indicator")).toBe(childExpected);
    // the card names the reason in words
    act(() => setState({ dialog: { mode: "details", roleId: "site" } }));
    await waitFor(() => expect(document.querySelector("[data-agent-roster-details] [data-agent-roster-card]")).not.toBeNull());
    if (bbResolve({ thread: site as never, hiddenThreads: [], hasUnsubmittedDraft: false, rowStatus: null }).indicator === "queued-failed") {
      expect(document.querySelector("[data-agent-roster-details] [data-agent-roster-card]")!.textContent).toContain("в очереди сообщение, которое не отправилось");
    }
    slot.lifecycle.unmount();
    await scripts.lifecycle.dispose();
    window.localStorage.clear();
  });
});
