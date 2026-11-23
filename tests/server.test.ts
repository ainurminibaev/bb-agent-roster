import { describe, expect, it } from "vitest";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import plugin, { readPairActive, STORAGE_KEY } from "../server";

type ThreadState = { archivedAt?: number | null; deletedAt?: number | null; updatedAt?: number };

async function setup(threads: Record<string, ThreadState>, pair: unknown = null, seed?: unknown) {
  const host = createFakePluginHost({
    pluginId: "agent-roster",
    sdk: {
      threads: {
        get: async ({ threadId }: { threadId: string }) => {
          const t = threads[threadId];
          if (!t) throw new Error("not found");
          return makeThreadResponse({ id: threadId, archivedAt: t.archivedAt ?? null, updatedAt: t.updatedAt ?? 1 });
        },
      },
      plugins: {
        callRpc: async ({ method }: { method: string }) => {
          if (method !== "chatPairStatus" || pair === null) throw new Error("no such method");
          return pair;
        },
      },
    } as never,
  });
  if (seed !== undefined) await host.bb.storage.kv.set(STORAGE_KEY, seed);
  await plugin(host.bb);
  return host;
}

const cli = (h: Awaited<ReturnType<typeof setup>>, argv: string[], threadId?: string) =>
  h.harness.behavior.runCli(argv, threadId ? { threadId } : undefined as never);

describe("server", () => {
  it("adds, lists, moves and removes roles through the CLI", async () => {
    const h = await setup({ thr_a: {}, thr_b: {}, thr_c: {} });
    let r = await cli(h, ["add", "--name", "Помощник", "--kind", "agent", "--thread", "thr_a"]);
    expect(r.exitCode).toBe(0);
    r = await cli(h, ["add", "--name", "Site", "--kind", "orchestrator", "--about", "сайт", "--parent", "Помощник", "--thread", "thr_b"]);
    expect(r.exitCode).toBe(0);
    r = await cli(h, ["list"]);
    expect(r.stdout).toContain('"Site" (orchestrator, id site)');
    expect(r.stdout).toContain("active thread: thr_b");
    expect(r.stdout).toContain('reports to "Помощник"');

    r = await cli(h, ["set-thread", "site", "thr_c"]);
    expect(r.exitCode).toBe(0);
    const json = JSON.parse((await cli(h, ["list", "--json"])).stdout);
    expect(json.roles.find((x: { id: string }) => x.id === "site").activeThreadId).toBe("thr_c");

    r = await cli(h, ["remove", "site"]);
    expect(r.stdout).toContain("untouched");
    expect(JSON.parse((await cli(h, ["list", "--json"])).stdout).roles).toHaveLength(1);
    expect(h.harness.inspection.sdk.callsTo("threads.archive")).toHaveLength(0);
    expect(h.harness.inspection.sdk.callsTo("threads.delete")).toHaveLength(0);
  });

  it("`current` binds the calling thread; bad input fails with a readable error", async () => {
    const h = await setup({ thr_self: {} });
    const ok = await cli(h, ["add", "--name", "Me", "--kind", "orchestrator", "--thread", "current"], "thr_self");
    expect(ok.exitCode).toBe(0);
    const bad = await cli(h, ["add", "--name", "X", "--kind", "external"]);
    expect(bad.exitCode).not.toBe(0);
    const cycle = await cli(h, ["add", "--name", "Child", "--parent", "me", "--thread", "thr_self"]);
    expect(cycle.exitCode).toBe(0);
    const loop = await cli(h, ["update", "me", "--parent", "child"]);
    expect(loop.exitCode).not.toBe(0);
  });

  it("an archived pinned thread shows no active thread; the record stays", async () => {
    const h = await setup({ thr_a: { archivedAt: 5 } });
    await cli(h, ["add", "--name", "O", "--kind", "orchestrator", "--thread", "thr_a"]);
    const out = await h.harness.behavior.callRpc("roster_list", null) as { roles: { active: unknown }[] };
    expect(out.roles).toHaveLength(1);
    expect(out.roles[0].active).toEqual({ kind: "none" });
  });

  it("a pair reads the active thread from the bridge, falling back to the last active", async () => {
    const withBridge = await setup({ thr_1: { updatedAt: 100 }, thr_2: { updatedAt: 50 } }, { primary: "thr_1", fallback: "thr_2", active: "thr_2" });
    await cli(withBridge, ["add", "--name", "P", "--kind", "agent", "--threads", "thr_1,thr_2", "--bridge-topic", "7"]);
    let out = await withBridge.harness.behavior.callRpc("roster_list", null) as { roles: { active: unknown }[] };
    expect(out.roles[0].active).toEqual({ kind: "thread", threadId: "thr_2", reason: "bridge" });

    const noBridge = await setup({ thr_1: { updatedAt: 100 }, thr_2: { updatedAt: 50 } });
    await cli(noBridge, ["add", "--name", "P", "--kind", "agent", "--threads", "thr_1,thr_2", "--bridge-topic", "7"]);
    out = await noBridge.harness.behavior.callRpc("roster_list", null) as { roles: { active: unknown }[] };
    expect(out.roles[0].active).toEqual({ kind: "thread", threadId: "thr_1", reason: "last-active" });
  });

  it("reads a pair status of any shape tolerantly", () => {
    expect(readPairActive({ active: "thr_x", extra: 1 })).toBe("thr_x");
    expect(readPairActive({ active: 5 })).toBeNull();
    expect(readPairActive(null)).toBeNull();
    expect(readPairActive("thr_x")).toBeNull();
  });

  it("loads damaged stored data without failing", async () => {
    const h = await setup({}, null, { roles: [{ id: "ok", name: "Ok" }, "junk", { name: "no id" }] });
    const out = await h.harness.behavior.callRpc("roster_list", null) as { roles: { id: string }[] };
    expect(out.roles.map((r) => r.id)).toEqual(["ok"]);
  });

  it("gives agents a tool and a short hint with this thread's role", async () => {
    const h = await setup({ thr_a: {} });
    await cli(h, ["add", "--name", "Site", "--kind", "orchestrator", "--thread", "thr_a"]);
    const tool = await h.harness.behavior.callAgentTool("agent_roster_list", {});
    expect(JSON.stringify(tool)).toContain("Site");
    const provider = h.harness.registrations.instructionProvider;
    expect(provider).toBeTypeOf("function");
    expect(provider!({ threadId: "thr_a", projectId: "p" })).toContain('name "Site"');
    expect(provider!({ threadId: "thr_z", projectId: "p" })).not.toContain("This thread holds a role");
  });

  it("keeps the list across a reload (disable → enable)", async () => {
    const h = await setup({ thr_a: {} });
    await cli(h, ["add", "--name", "Keep", "--thread", "thr_a"]);
    await h.harness.lifecycle.reload(plugin);
    const out = await h.harness.behavior.callRpc("roster_list", null) as { roles: { name: string }[] };
    expect(out.roles.map((r) => r.name)).toEqual(["Keep"]);
  });
});

describe("server 0.2", () => {
  it("sends a quick message to the role's active thread with the standard send", async () => {
    const sends: unknown[] = [];
    const h = await setup({ thr_a: {} });
    h.harness.sdk.stub("threads.send", async (args: unknown) => { sends.push(args); return {} as never; });
    await cli(h, ["add", "--name", "Site", "--kind", "orchestrator", "--thread", "thr_a"]);
    const out = await h.harness.behavior.callRpc("roster_send", { roleId: "site", text: "hi" });
    expect(out).toEqual({ threadId: "thr_a" });
    expect(sends).toEqual([{ threadId: "thr_a", mode: "auto", input: [{ type: "text", text: "hi" }] }]);
    await expect(h.harness.behavior.callRpc("roster_send", { roleId: "nope", text: "hi" })).rejects.toThrow();
  });
  it("activity reads the last task while running and the last answer when idle", async () => {
    const h = await setup({ thr_a: {} });
    h.harness.sdk.stub("threads.conversationOutline", async () => ({ items: [{ role: "user", preview: "build it" }, { role: "assistant", preview: "built" }, { role: "user", preview: "[bb system] note" }] }) as never);
    const out = await h.harness.behavior.callRpc("roster_activity", { threadIds: ["thr_a", "thr_missing"] });
    expect(out).toEqual({ thr_a: "Закончил: built", thr_missing: null });
  });
});

describe("list format contract (formatVersion 1)", () => {
  it("CLI --json and the agent tool return the same stable fields; add, never rename or remove", async () => {
    const h = await setup({ thr_a: {}, thr_b: { archivedAt: 1 } });
    await cli(h, ["add", "--name", "Lead", "--kind", "agent", "--about", "lead work", "--thread", "thr_a", "--project", "proj_1"]);
    await cli(h, ["add", "--name", "Gone", "--kind", "orchestrator", "--parent", "Lead", "--thread", "thr_b"]);
    await cli(h, ["add", "--name", "Ext", "--kind", "external", "--url", "https://example.org/ext"]);
    const fromCli = JSON.parse((await cli(h, ["list", "--json"])).stdout);
    const tool = await h.harness.behavior.callAgentTool("agent_roster_list", {});
    const toolText = typeof tool === "string" ? tool : (tool as { content: { text: string }[] }).content[0]!.text;
    const fromTool = JSON.parse(toolText);
    expect(fromTool).toEqual(fromCli);
    expect(fromCli.formatVersion).toBe(1);
    const REQUIRED = ["id", "name", "kind", "responsibility", "reportsTo", "reportsToName", "projectId", "activeThreadId", "url"];
    for (const role of fromCli.roles) for (const key of REQUIRED) expect(role).toHaveProperty(key);
    const byName = Object.fromEntries(fromCli.roles.map((r: { name: string }) => [r.name, r]));
    expect(byName.Lead).toMatchObject({ id: "lead", kind: "agent", responsibility: "lead work", reportsTo: null, projectId: "proj_1", activeThreadId: "thr_a", url: null });
    expect(byName.Gone).toMatchObject({ reportsTo: "lead", reportsToName: "Lead", activeThreadId: null });
    expect(byName.Ext).toMatchObject({ kind: "external", activeThreadId: null, url: "https://example.org/ext" });
  });
});

describe("0.2.1: project logos", () => {
  it("reads .bb/icon.svg through bb's files; falls back to Machine Tabs; nothing → null without errors", async () => {
    const h = await setup({});
    h.harness.sdk.stub("projects.get", async ({ projectId }: { projectId: string }) => ({ sources: [{ hostId: "h1", path: `/p/${projectId}`, isDefault: true }] }) as never);
    h.harness.sdk.stub("files.read", async ({ rootPath, path }: { rootPath: string; path: string }) => {
      if (!path.startsWith("/")) throw new Error("Path must be absolute");
      if (rootPath === "/p/a" && path === "/p/a/.bb/icon.svg") return { content: "<svg/>", contentEncoding: "utf8", sizeBytes: 6 } as never;
      throw new Error("ENOENT");
    });
    let calls = 0;
    h.harness.sdk.stub("plugins.callRpc", async ({ pluginId, method }: { pluginId: string; method: string }) => {
      calls += 1;
      if (pluginId === "machine-tabs" && method === "project_icons") return { icons: { b: "data:image/png;base64,AAAA", c: "javascript:alert(1)" } };
      throw new Error("no");
    });
    const out = await h.harness.behavior.callRpc("roster_project_icons", { projectIds: ["a", "b", "c", "d"] }) as Record<string, string | null>;
    expect(out.a).toBe(`data:image/svg+xml;base64,${Buffer.from("<svg/>").toString("base64")}`);
    expect(out.b).toBe("data:image/png;base64,AAAA");
    expect(out.c).toBeNull();
    expect(out.d).toBeNull();
    expect(calls).toBeGreaterThan(0);
  });
  it("no source at all (no files, no Machine Tabs) → null", async () => {
    const h = await setup({});
    h.harness.sdk.stub("projects.get", async () => { throw new Error("gone"); });
    const out = await h.harness.behavior.callRpc("roster_project_icons", { projectIds: ["x"] });
    expect(out).toEqual({ x: null });
  });
});

describe("0.2.1: main record via CLI", () => {
  it("marking another record main clears the previous one; the list JSON carries `primary`", async () => {
    const h = await setup({ thr_a: {}, thr_b: {} });
    await cli(h, ["add", "--name", "A", "--kind", "agent", "--thread", "thr_a", "--primary", "on"]);
    await cli(h, ["add", "--name", "B", "--kind", "orchestrator", "--thread", "thr_b"]);
    let list = JSON.parse((await cli(h, ["list", "--json"])).stdout);
    expect(list.roles.filter((r: { primary: boolean }) => r.primary).map((r: { id: string }) => r.id)).toEqual(["a"]);
    await cli(h, ["update", "b", "--primary", "on"]);
    list = JSON.parse((await cli(h, ["list", "--json"])).stdout);
    expect(list.roles.filter((r: { primary: boolean }) => r.primary).map((r: { id: string }) => r.id)).toEqual(["b"]);
    expect(list.formatVersion).toBe(1);
  });
});

describe("part B: role marks on thread icons through Machine Tabs", () => {
  it("with Machine Tabs: marks are replaced on add, move and remove; gold for main, muted for a reserve thread", async () => {
    const sent: { marks: { threadId: string; glyph: string; tone: string }[] }[] = [];
    const h = await setup({ thr_a: { updatedAt: 9 }, thr_b: { updatedAt: 1 }, thr_c: {}, thr_d: {} });
    h.harness.sdk.stub("plugins.callRpc", async ({ pluginId, method, input }: { pluginId: string; method: string; input: never }) => {
      if (pluginId === "machine-tabs" && method === "thread_marks_replace") { sent.push(input); return { count: 1 }; }
      throw new Error("no");
    });
    await cli(h, ["add", "--name", "Main", "--kind", "agent", "--threads", "thr_a,thr_b", "--primary", "on"]);
    await cli(h, ["add", "--name", "Orch", "--kind", "orchestrator", "--thread", "thr_c"]);
    const list = await h.harness.behavior.callRpc("roster_list", null) as { iconMarks: boolean };
    expect(list.iconMarks).toBe(true);
    const last = () => Object.fromEntries(sent.at(-1)!.marks.map((m) => [m.threadId, `${m.glyph}/${m.tone}`]));
    expect(last()).toEqual({ thr_a: "crown/accent", thr_b: "crown/muted", thr_c: "crown/neutral" });
    const byThread = Object.fromEntries(sent.at(-1)!.marks.map((m) => [m.threadId, m as unknown as { place: string; size: string }]));
    // One crown size on every row, grey or gold; gold is larger only in the block.
    expect(byThread.thr_a).toMatchObject({ place: "top", size: "normal" });
    expect(byThread.thr_c).toMatchObject({ place: "top", size: "normal" });
    await cli(h, ["set-thread", "orch", "thr_d"]);
    await h.harness.behavior.callRpc("roster_list", null);
    expect(last()).toEqual({ thr_a: "crown/accent", thr_b: "crown/muted", thr_d: "crown/neutral" });
    await cli(h, ["remove", "orch"]);
    await h.harness.behavior.callRpc("roster_list", null);
    expect(last()).toEqual({ thr_a: "crown/accent", thr_b: "crown/muted" });
  });
  it("without Machine Tabs (or an older one): no error, iconMarks false, the row keeps the plugin's own mark", async () => {
    const h = await setup({ thr_a: {} });
    await cli(h, ["add", "--name", "Orch", "--kind", "orchestrator", "--thread", "thr_a"]);
    const list = await h.harness.behavior.callRpc("roster_list", null) as { iconMarks: boolean; roles: unknown[] };
    expect(list.iconMarks).toBe(false);
    expect(list.roles).toHaveLength(1);
  });
});

import { ORCHESTRATOR_RULES, appendSection, hasSection } from "../orchestrator-rules";
describe("0.3: orchestrator rules and the AGENTS.md section", () => {
  const hint = (h: Awaited<ReturnType<typeof setup>>, threadId: string) => h.harness.registrations.instructionProvider!({ threadId, projectId: "p" }) as string;

  it("a new orchestrator gets layer 1 and the pointer; an agent never does; the switch turns it off", async () => {
    const h = await setup({ thr_o: {}, thr_a: {} });
    await cli(h, ["add", "--name", "Site", "--kind", "orchestrator", "--thread", "thr_o"]);
    await cli(h, ["add", "--name", "Helper", "--kind", "agent", "--thread", "thr_a"]);
    expect(hint(h, "thr_o")).toContain(ORCHESTRATOR_RULES.split("\n")[1]);
    expect(hint(h, "thr_o")).toContain("AGENTS.md проекта, раздел «Роль: Site»");
    expect(hint(h, "thr_a")).not.toContain("постановщик и приёмщик");
    await cli(h, ["update", "site", "--rules", "off"]);
    expect(hint(h, "thr_o")).not.toContain("постановщик и приёмщик");
    const list = JSON.parse((await cli(h, ["list", "--json"])).stdout);
    expect(list.roles.find((r: { id: string }) => r.id === "site").orchestratorRules).toBe(false);
  });

  it("an orchestrator saved before 0.3 keeps the rules off after the update", async () => {
    const h = await setup({ thr_o: {} }, null, { version: 1, roles: [{ id: "old", name: "Old", kind: "orchestrator", binding: { mode: "pinned", threadId: "thr_o" } }] });
    expect(hint(h, "thr_o")).not.toContain("постановщик и приёмщик");
    await cli(h, ["update", "old", "--about", "x"]);
    expect(hint(h, "thr_o")).not.toContain("постановщик и приёмщик");
  });

  it("proposes the section, appends it only on request and never rewrites an existing one", async () => {
    let file: { content: string; sha256: string } | null = { content: "# Project\n\nrules\n", sha256: "s1" };
    const writes: { content: string; expectedSha256: unknown }[] = [];
    const h = await setup({ thr_o: { } });
    h.harness.sdk.stub("projects.get", async () => ({ sources: [{ hostId: "h1", path: "/repo", isDefault: true }] }) as never);
    h.harness.sdk.stub("threads.get", async ({ threadId }: { threadId: string }) => makeThreadResponse({ id: threadId, archivedAt: null }));
    h.harness.sdk.stub("environments.get", async () => ({ hostId: "h1" }) as never);
    h.harness.sdk.stub("files.read", async ({ path }: { path: string }) => { if (path !== "/repo/AGENTS.md") throw new Error("Path must be absolute"); if (!file) throw new Error("ENOENT"); return { ...file, contentEncoding: "utf8" } as never; });
    h.harness.sdk.stub("files.write", async (args: { path: string; content: string; expectedSha256: unknown }) => { if (args.path !== "/repo/AGENTS.md") throw new Error("Path must be absolute"); writes.push(args); file = { content: args.content, sha256: "s2" }; return {} as never; });
    await cli(h, ["add", "--name", "Site", "--kind", "orchestrator", "--thread", "thr_o", "--project", "p1"]);
    const first = await h.harness.behavior.callRpc("roster_agents_md", { roleId: "site" }) as { status: string };
    expect(first.status).toBe("missing");
    expect(writes).toHaveLength(0);
    const done = await h.harness.behavior.callRpc("roster_agents_md", { roleId: "site", append: true }) as { status: string };
    expect(done.status).toBe("appended");
    expect(writes[0]!.content.startsWith("# Project\n\nrules\n")).toBe(true);
    expect(writes[0]!.expectedSha256).toBe("s1");
    expect(hasSection(writes[0]!.content, "Site")).toBe(true);
    // Promote again (remove + add): the existing section is left as it is.
    await cli(h, ["remove", "site"]);
    await cli(h, ["add", "--name", "Site", "--kind", "orchestrator", "--thread", "thr_o", "--project", "p1"]);
    const again = await h.harness.behavior.callRpc("roster_agents_md", { roleId: "site", append: true }) as { status: string };
    expect(again.status).toBe("present");
    expect(writes).toHaveLength(1);
  });

  it("append keeps the existing text byte for byte", () => {
    expect(appendSection("a", "## Роль: X\n")).toBe("a\n\n## Роль: X\n");
    expect(appendSection("a\n", "S")).toBe("a\n\nS");
    expect(appendSection("", "S")).toBe("S");
    expect(hasSection("### Роль: Site (beta)", "Site (beta)")).toBe(true);
    expect(hasSection("## Роль: Sitex", "Site")).toBe(false);
  });
});

describe("0.3.1: Telegram on the thread icon", () => {
  it("a role with a Telegram channel gets a plane in the corner of its active thread's icon", async () => {
    const sent: { marks: { threadId: string; glyph: string; place: string }[] }[] = [];
    const h = await setup({ thr_a: {} });
    h.harness.sdk.stub("plugins.callRpc", async ({ pluginId, method, input }: { pluginId: string; method: string; input: never }) => {
      if (pluginId === "machine-tabs" && method === "thread_marks_replace") { sent.push(input); return { count: 1 }; }
      if (method === "status") return { bot: "some_bot", chatBindings: [{ topicId: 0, projectId: "p", threadId: "thr_a", ready: true }] };
      throw new Error("no");
    });
    await cli(h, ["add", "--name", "Main", "--kind", "agent", "--thread", "thr_a", "--primary", "on"]);
    await h.harness.behavior.callRpc("roster_list", null);
    const marks = sent.at(-1)!.marks.filter((m) => m.threadId === "thr_a").map((m) => `${m.glyph}@${m.place}`).sort();
    expect(marks).toEqual(["crown@top", "telegram@corner"]);
  });
});
