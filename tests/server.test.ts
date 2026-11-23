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
    let r = await cli(h, ["add", "--name", "Помощник", "--kind", "assistant", "--thread", "thr_a"]);
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
    expect(json.roles.find((x: { id: string }) => x.id === "site").active).toMatchObject({ threadId: "thr_c" });

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
    await cli(withBridge, ["add", "--name", "P", "--kind", "assistant", "--threads", "thr_1,thr_2", "--bridge-topic", "7"]);
    let out = await withBridge.harness.behavior.callRpc("roster_list", null) as { roles: { active: unknown }[] };
    expect(out.roles[0].active).toEqual({ kind: "thread", threadId: "thr_2", reason: "bridge" });

    const noBridge = await setup({ thr_1: { updatedAt: 100 }, thr_2: { updatedAt: 50 } });
    await cli(noBridge, ["add", "--name", "P", "--kind", "assistant", "--threads", "thr_1,thr_2", "--bridge-topic", "7"]);
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
