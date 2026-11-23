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
    binding: { mode: "pinned", threadId: `thr_${p.id}` }, primary: false, rulesEnabled: false, manageTitle: false, createdAt: 0, updatedAt: 0,
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
        roster_upsert: (input: unknown) => { saved.push(input); return { icon: "", responsibility: "", parentId: null, projectId: null, primary: false, rulesEnabled: true, manageTitle: true, ...(input as object), id: "x", createdAt: 0, updatedAt: 0 }; },
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
    expect(site.querySelector("[data-agent-roster-total]")!.textContent!.replace(/\s/g, "")).toBe("↳1·1");
    const toggle = site.querySelector("[data-agent-roster-toggle]") as HTMLButtonElement;
    if (toggle.getAttribute("aria-expanded") !== "true") act(() => toggle.click());
    expect(site.querySelector("[data-agent-roster-total]")!.textContent).toBe("↳1 · 1");
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
    // An SVG logo is a mask in the text colour (its own fills are not trusted), a PNG is grayscale like Machine Tabs.
    expect(withLogo.container.querySelector('[data-project-logo="mask"]')!.getAttribute("style")).toContain("data:image/svg+xml;base64,AA");
    expect(withLogo.container.querySelector("img")).toBeNull();
    expect(visible(withLogo.container.querySelector('[data-crown="top"] svg')!)).toBeCloseTo(10);
    withLogo.lifecycle.unmount();
    const plain = renderSlot({ component: RoleIcon as never }, { role: { icon: "", kind: "agent" }, logo: null } as never);
    expect(visible(plain.container.querySelector('[data-crown="alone"] svg')!)).toBeCloseTo(18);
    plain.lifecycle.unmount();
    const main = renderSlot({ component: RoleIcon as never }, { role: { icon: "", kind: "agent", primary: true }, logo: "data:image/svg+xml;base64,AA", telegram: "Telegram: чат" } as never);
    expect(main.container.querySelector("[data-project-logo]")).toBeNull();
    const png = renderSlot({ component: RoleIcon as never }, { role: { icon: "", kind: "agent" }, logo: "data:image/png;base64,AA" } as never);
    expect(png.container.querySelector('img[data-project-logo="image"]')!.getAttribute("style")).toContain("grayscale(1)");
    png.lifecycle.unmount();
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
  it("shows live executors, idle ones included (≤7, then «ещё N»); archived behind «архивные (N)», folded on every opening", async () => {
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
    await waitFor(() => expect(site.querySelector("[data-agent-roster-show-finished]")?.textContent).toBe("архивные (1)"));
    expect(site.querySelectorAll("[data-executor]")).toHaveLength(7);
    expect(site.querySelector("[data-executor][data-archived]")).toBeNull();
    // The counter equals the live rows: 10 (9 working + 1 idle) = 7 shown + «ещё 3».
    expect(site.querySelector("[data-agent-roster-total]")!.getAttribute("data-count")).toBe("10");
    expect(site.querySelector("[data-agent-roster-more-live]")!.textContent).toBe("ещё 3");
    act(() => (site.querySelector("[data-agent-roster-more-live]") as HTMLButtonElement).click());
    expect(site.querySelectorAll("[data-executor]")).toHaveLength(10);
    expect(site.querySelector('[data-executor="thr_done"]')).not.toBeNull();
    // One group only: no group labels.
    expect(site.querySelector("[data-agent-roster-group]")).toBeNull();
    act(() => (site.querySelector("[data-agent-roster-show-finished]") as HTMLButtonElement).click());
    const group = site.querySelector("[data-agent-roster-archived]")!;
    expect(Array.from(group.querySelectorAll("[data-executor]")).map((e) => e.getAttribute("data-executor")).sort()).toEqual(["thr_arch"]);
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

/**
 * Which element takes a press at a point of `el`: the element itself, unless it or an ancestor
 * below `row` lets presses through (pointer-events-none, until a pointer-events-auto). A
 * press that passes through everything lands on the row's link — the absolute layer under them.
 */
function setExpanded(rec: Element, want: boolean) {
  const t = rec.querySelector("[data-agent-roster-toggle]") as HTMLButtonElement;
  if ((t.getAttribute("aria-expanded") === "true") !== want) act(() => t.click());
}

function catchesPress(el: Element, row: Element): Element | null {
  let cur: Element | null = el;
  while (cur && cur !== row) {
    const cls = (cur.getAttribute("class") ?? "").split(/\s+/);
    if (cls.includes("pointer-events-auto") || cur.tagName === "BUTTON" || cur.tagName === "A") return cur;
    if (cls.includes("pointer-events-none")) return null;
    cur = cur.parentElement;
  }
  // No pointer-events-none on the way: a positioned or later child sits over the link and keeps the press.
  return el === row ? null : el;
}

describe("0.4.3: a press anywhere on a record opens its thread", () => {
  it("icon, name, status line and the gap before the counter open the thread, collapsed and expanded; only the chevron expands; executor rows open their own thread", async () => {
    machineTabsSidebar();
    const scripts = await mountPluginContentScripts(app, { pluginId: "agent-roster" });
    await frame();
    const slot = renderSlot(app.appOverlays[0]!, {}, {
      rpc: { roster_list: () => ({ roles: ROLES, launchDocUrl: null }), roster_activity: () => ({ thr_site: "Занят: вёрстка" }), roster_executors: () => ({ threads: [] }) } as never,
      sidebarThreads: { threads: [
        { ...row("thr_lead", null), title: "lead", href: "/t/lead" },
        { ...row("thr_site", null), title: "site", href: "/t/site" },
        { ...row("thr_c", "thr_site", { status: "active", indicator: "runtime" }), title: "child", href: "/t/c" },
      ] as never },
    });
    const host = document.querySelector(`[${HOST_ATTR}]`)!;
    await waitFor(() => expect(host.querySelector('[data-agent-roster-role="site"] [data-agent-roster-total]')).not.toBeNull());
    const rec = host.querySelector('[data-agent-roster-role="site"]')!;
    const toggle = rec.querySelector("[data-agent-roster-toggle]") as HTMLButtonElement;
    setExpanded(rec, false);
    for (const state of ["collapsed", "expanded"]) {
      const line = rec.querySelector("[data-agent-roster-line]")!;
      const link = line.querySelector(":scope > [data-agent-roster-link]") as HTMLAnchorElement;
      expect(link.getAttribute("href"), state).toBe("/t/site");
      // the pointer shows a link over the whole record
      expect((line.getAttribute("class") ?? "").split(/\s+/), state).toContain("cursor-pointer");
      expect((link.getAttribute("class") ?? "").split(/\s+/), state).toContain("cursor-pointer");
      const points = {
        icon: line.querySelector("[data-role-icon]")!,
        name: line.querySelector("[data-agent-roster-title] > span")!,
        status: line.querySelector("[data-agent-roster-status]")!,
        gap: line.querySelector("[data-agent-roster-name-line]")!,
        counter: line.querySelector("[data-agent-roster-total]")!,
      };
      for (const [where, el] of Object.entries(points)) expect(catchesPress(el, line), `${state}: ${where}`).toBeNull();
      expect(points.status.tagName, state).not.toBe("BUTTON");
      // a press on the status line does not fold or unfold the record
      const before = toggle.getAttribute("aria-expanded");
      fireEvent.click(points.status);
      expect(toggle.getAttribute("aria-expanded"), state).toBe(before);
      const calls = slot.inspection.navigateCalls.length;
      fireEvent.click(link);
      expect(slot.inspection.navigateCalls.length, state).toBe(calls + 1);
      expect(JSON.stringify(slot.inspection.navigateCalls.at(-1)), state).toContain("thr_site");
      // the chevron is the only control that expands, with its own pointer and hint
      expect(catchesPress(toggle, line)).toBe(toggle);
      expect((toggle.getAttribute("class") ?? "").split(/\s+/)).toContain("cursor-pointer");
      expect(toggle.getAttribute("title")).toBeTruthy();
      if (state === "collapsed") {
        expect(toggle.getAttribute("aria-expanded")).toBe("false");
        act(() => toggle.click());
        await waitFor(() => expect(rec.querySelector('[data-executor="thr_c"]')).not.toBeNull());
      }
    }
    // an executor row is a link to its own thread over the whole row
    const exec = rec.querySelector('[data-executor="thr_c"]')!;
    const execLink = exec.querySelector("[data-agent-roster-link]") as HTMLAnchorElement;
    for (const el of exec.querySelectorAll("span")) expect(catchesPress(el, exec)).toBeNull();
    fireEvent.click(execLink);
    expect(JSON.stringify(slot.inspection.navigateCalls.at(-1))).toContain("thr_c");
    act(() => toggle.click());
    slot.lifecycle.unmount();
    await scripts.lifecycle.dispose();
    window.localStorage.clear();
  });
});

describe("0.4.3: block order, «Показать ещё», empty expanded record, logo kinds", () => {
  it("main record first, then by activity; first N then «↓ Показать ещё» with «N / total»; a waiting record beyond N is shown", async () => {
    machineTabsSidebar();
    const scripts = await mountPluginContentScripts(app, { pluginId: "agent-roster" });
    await frame();
    const mk = (i: number, extra: Partial<ResolvedRole> = {}) => ({ ...ROLES[1], id: `r${i}`, name: `R${i}`, active: { kind: "thread", threadId: `thr_${i}`, reason: "pinned" }, ...extra }) as ResolvedRole;
    const roles = [mk(0), mk(1), mk(2), mk(3, { primary: true }), mk(4), mk(5), mk(6), mk(7)];
    const threads = roles.map((r, i) => ({ ...row(`thr_${i}`, null, i === 0 ? { hasPendingInteraction: true, indicator: "waiting-for-input" } : {}), title: r.name, updatedAt: 1000 + i, latestAttentionAt: 0 }));
    const slot = renderSlot(app.appOverlays[0]!, {}, {
      rpc: { roster_list: () => ({ roles, launchDocUrl: null, blockLimit: 5 }), roster_activity: () => ({}) } as never,
      sidebarThreads: { threads: threads as never },
    });
    const host = document.querySelector(`[${HOST_ATTR}]`)!;
    await waitFor(() => expect(host.querySelector("[data-agent-roster-pager]")).not.toBeNull());
    const ids = () => Array.from(host.querySelectorAll("[data-agent-roster-role]")).map((e) => e.getAttribute("data-agent-roster-role"));
    // main r3 first, then newest activity first (r7, r6, r5, r4); r0 waits for the owner, so it is shown too
    expect(ids()).toEqual(["r3", "r7", "r6", "r5", "r4", "r0"]);
    const more = host.querySelector("[data-agent-roster-show-more]") as HTMLButtonElement;
    expect(more.textContent).toBe("↓ Показать ещё");
    expect(host.querySelector("[data-agent-roster-page-count]")!.textContent).toBe("6 / 8");
    act(() => more.click());
    expect(ids()).toEqual(["r3", "r7", "r6", "r5", "r4", "r2", "r1", "r0"]);
    expect(more.textContent).toBe("↑ Свернуть");
    slot.lifecycle.unmount();
    await scripts.lifecycle.dispose();
  });

  it("an expanded record without executors: one muted line «исполнителей нет» and a clickable «архивные (N)» with a chevron", async () => {
    machineTabsSidebar();
    const scripts = await mountPluginContentScripts(app, { pluginId: "agent-roster" });
    await frame();
    const slot = renderSlot(app.appOverlays[0]!, {}, {
      rpc: {
        roster_list: () => ({ roles: ROLES, launchDocUrl: null }), roster_activity: () => ({}),
        roster_executors: () => ({ threads: [{ id: "thr_a1", parentThreadId: "thr_site", title: "old", status: "idle", isArchived: true }] }),
      } as never,
      sidebarThreads: { threads: [{ ...row("thr_lead", null), title: "lead" }, { ...row("thr_site", null), title: "site" }] as never },
    });
    const host = document.querySelector(`[${HOST_ATTR}]`)!;
    await waitFor(() => expect(host.querySelector('[data-agent-roster-role="site"]')).not.toBeNull());
    const rec = host.querySelector('[data-agent-roster-role="site"]')!;
    setExpanded(rec, true);
    await waitFor(() => expect(rec.querySelector("[data-agent-roster-show-finished]")).not.toBeNull());
    const list = rec.querySelector("[data-agent-roster-executors]")!;
    // the whole expanded part is one indented list with a guide
    expect((list.getAttribute("class") ?? "").split(/\s+/)).toEqual(expect.arrayContaining(["border-l", "ml-4"]));
    expect(list.children).toHaveLength(1);
    const empty = list.querySelector("[data-agent-roster-empty]")!;
    expect(empty.textContent).toBe("исполнителей нет" + "архивные (1)");
    expect(list.querySelector("[data-agent-roster-group]")).toBeNull();
    const archived = empty.querySelector("[data-agent-roster-show-finished]") as HTMLButtonElement;
    const cls = (archived.getAttribute("class") ?? "").split(/\s+/);
    expect(cls).toEqual(expect.arrayContaining(["cursor-pointer", "hover:bg-sidebar-accent"]));
    expect(archived.querySelector("svg")).not.toBeNull();
    expect(archived.getAttribute("aria-expanded")).toBe("false");
    // one font for every service line
    expect((empty.getAttribute("class") ?? "")).toContain("text-[9.5px]");
    expect(cls).toContain("text-[9.5px]");
    act(() => archived.click());
    expect(archived.getAttribute("aria-expanded")).toBe("true");
    expect(rec.querySelector('[data-executor="thr_a1"]')).not.toBeNull();
    setExpanded(rec, false);
    slot.lifecycle.unmount();
    await scripts.lifecycle.dispose();
    window.localStorage.clear();
  });

  it("an SVG with evenodd and fill=\"none\" on the root is drawn as a mask of the untouched file; PNG as an image", () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none"><path fill-rule="evenodd" clip-rule="evenodd" d="M2 2h20v20H2zM12 7a5 5 0 1 0 0 10 5 5 0 0 0 0-10z" fill="currentColor"/></svg>';
    const url = `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
    const r = renderSlot({ component: RoleIcon as never }, { role: { icon: "", kind: "agent" }, logo: url } as never);
    const el = r.container.querySelector('[data-project-logo="mask"]') as HTMLElement;
    expect(el).not.toBeNull();
    // the file goes in as is: same data URL, coloured from outside (bg-current)
    expect(el.getAttribute("style")).toContain(url);
    expect((el.getAttribute("class") ?? "").split(/\s+/)).toContain("bg-current");
    expect(r.container.querySelector("img")).toBeNull();
    r.lifecycle.unmount();
  });
});
