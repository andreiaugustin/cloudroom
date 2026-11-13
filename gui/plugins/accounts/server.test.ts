import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
  createFakePluginHost,
  makeMessageDispatchHookContext,
  makeThreadResponse,
  makeTurnFailedEvent,
} from "@get-bb/plugin-sdk/testing";
import plugin from "./server.js";

const dirs: string[] = [];
afterEach(() =>
  Promise.all(
    dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })),
  ),
);

const account = (id: string) => ({
  id,
  provider: "claude-code" as const,
  email: `${id}@example.com`,
  plan: null,
  accountKey: null,
  createdAt: 0,
});

// A turn starts on account A, the user picks B, then the turn's rate limit lands (#1151). Host "h" is this computer.
it.each([
  {
    name: "Local turn that ran on A",
    target: "local",
    ranOnA: true,
    limited: ["claude-code:a"],
  },
  {
    name: "Local turn on A that a message joined after the switch (#1300)",
    target: "joined",
    ranOnA: true,
    limited: ["claude-code:a"],
  },
  {
    name: "Local turn this plugin never saw start",
    target: "local",
    ranOnA: false,
    limited: [],
  },
  {
    name: "Cloud turn, whose login Core picks and this plugin cannot see",
    target: "cloud",
    ranOnA: false,
    limited: [],
  },
  {
    name: "turn on another machine, which runs on its own login (#531)",
    target: "machine",
    ranOnA: true,
    limited: [],
  },
  {
    name: "turn on another machine that got A's one-year token",
    target: "machine-token",
    ranOnA: true,
    limited: ["claude-code:a"],
  },
  {
    name: "Local thread moved to Cloud, whose handoff names the last Local request",
    target: "local-cloud",
    ranOnA: true,
    limited: [],
  },
  {
    name: "machine thread moved to Cloud",
    target: "machine-cloud",
    ranOnA: true,
    limited: [],
  },
] as const)("a rate limit on a $name", async ({ target, ranOnA, limited }) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "accounts-test-"));
  dirs.push(dataDir);
  let status: "idle" | "active" = "idle";
  const { bb, harness } = createFakePluginHost({
    pluginId: "accounts",
    dataDir,
    sdk: {
      system: { config: async () => ({ primaryHostId: "h" }) as never },
      threads: {
        get: async ({ threadId }: { threadId: string }) =>
          makeThreadResponse({
            id: threadId,
            providerId: "claude-code",
            executionTarget: target.endsWith("cloud") ? "cloud" : "local",
            status,
          }),
      },
    },
  });
  // A has a one-year token; on another machine it also has a folder, except in the token row.
  const secrets = path.join(dataDir, "plugins", "accounts", "secrets");
  await fs.mkdir(secrets, { recursive: true });
  await fs.writeFile(
    path.join(secrets, "a.json"),
    JSON.stringify({ accessToken: "t", refreshToken: "", expiresAt: null }),
  );
  const profile = ["machine", "machine-cloud"].includes(target) ? "pa" : null;
  await bb.storage.kv.set("accounts:v1", [
    { ...account("a"), profile },
    account("b"),
  ]);
  await bb.storage.kv.set("order:v1", { "claude-code": ["a", "b"] });
  await plugin(bb);
  if (ranOnA)
    await harness.resolveProviderEnv("claude-code", {
      threadId: "t",
      projectId: "p",
      hostId: target.startsWith("machine") ? "m" : "h",
      requestId: "r1",
    });
  status = "active";
  await harness.callRpc("accounts.use", { provider: "claude-code", id: "b" });
  // A message joining the running turn asks for the env again; the turn stays on A.
  if (target === "joined")
    await harness.resolveProviderEnv("claude-code", {
      threadId: "t",
      projectId: "p",
      hostId: "h",
      requestId: "r2",
      runningTurnRequestId: "r1",
    });
  await harness.emitThreadEvent(
    "turn.failed",
    makeTurnFailedEvent({
      threadId: "t",
      // A Cloud turn after Teleport names the last Local request (the handoff appends none); Core says it ran in Cloud.
      requestId: target === "joined" ? "r2" : "r1",
      experimental_executionTarget: target.endsWith("cloud") ? "cloud" : "local",
      errorInfo: {
        category: "rate-limit",
        providerCode: null,
        httpStatusCode: 429,
      },
    }),
  );
  expect(Object.keys((await bb.storage.kv.get("limits:v1")) ?? {})).toEqual(
    limited,
  );
});

// Each Keychain call takes 2 s: the MCP sign-in copy makes up to 4, past the env's 5 s deadline.
it(
  "a slow Keychain never holds up the account's CLAUDE_CONFIG_DIR",
  { timeout: 15_000 },
  async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "accounts-test-"));
    dirs.push(dataDir);
    const bin = path.join(dataDir, "bin");
    const keychain = path.join(dataDir, "keychain");
    await fs.mkdir(bin);
    await fs.mkdir(keychain);
    await fs.writeFile(
      path.join(bin, "security"),
      `#!/bin/sh
sleep 2
[ "$1" = find-generic-password ] || { cat >/dev/null; exit 0; }
while [ $# -gt 0 ]; do [ "$1" = -s ] && s="$2"; shift; done
[ -f "${keychain}/$s" ] && cat "${keychain}/$s" || exit 44
`,
      { mode: 0o755 },
    );
    const fakeToken = {
      accessToken: "fake",
      expiresAt: Date.now() + 3_600_000,
    };
    await fs.writeFile(
      path.join(keychain, "Claude Code-credentials"),
      Buffer.from(JSON.stringify({ mcpOAuth: { linear: fakeToken } })).toString(
        "hex",
      ),
    );
    vi.stubEnv("PATH", `${bin}:${process.env.PATH}`);
    vi.stubEnv("CLAUDE_CONFIG_DIR", "");
    vi.stubEnv("HOME", dataDir);
    const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
    Object.defineProperty(process, "platform", {
      configurable: true,
      value: "darwin",
    });
    try {
      const { bb, harness } = createFakePluginHost({
        pluginId: "accounts",
        dataDir,
        sdk: {
          system: { config: async () => ({ primaryHostId: "h" }) as never },
        },
      });
      await bb.storage.kv.set("accounts:v1", [
        { ...account("a"), profile: "pa" },
      ]);
      await bb.storage.kv.set("order:v1", { "claude-code": ["a"] });
      await plugin(bb);
      const started = Date.now();
      const env = await harness.resolveProviderEnv("claude-code", {
        threadId: "t",
        projectId: "p",
        hostId: "h",
      });
      expect(Date.now() - started).toBeLessThan(2_000);
      expect(
        env.find((entry) => entry.name === "CLAUDE_CONFIG_DIR")?.value,
      ).toBe(path.join(dataDir, "plugins", "accounts", "profiles", "pa"));
    } finally {
      Object.defineProperty(process, "platform", platform);
      vi.unstubAllEnvs();
    }
  },
);

// Usage lived only in memory, so a restart emptied every account that isn't in use: those are not checked again.
it("accounts not in use keep their usage bars and reset times across a restart", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "accounts-test-"));
  dirs.push(dataDir);
  const { bb, harness } = createFakePluginHost({
    pluginId: "accounts",
    dataDir,
    sdk: { system: { config: async () => ({ primaryHostId: "h" }) as never } },
  });
  const home = path.join(dataDir, "plugins", "accounts");
  await fs.mkdir(path.join(home, "secrets"), { recursive: true });
  for (const id of ["a", "b", "c", "d"])
    await fs.writeFile(
      path.join(home, "secrets", `${id}.json`),
      JSON.stringify({ accessToken: id, refreshToken: "", expiresAt: null }),
    );
  // D has a full login, so its usage is read without a reply.
  await fs.mkdir(path.join(home, "profiles", "pd"), { recursive: true });
  await fs.writeFile(
    path.join(home, "profiles", "pd", ".credentials.json"),
    JSON.stringify({ claudeAiOauth: { accessToken: "d-full" } }),
  );
  await bb.storage.kv.set("accounts:v1", [
    account("a"),
    account("b"),
    account("c"),
    { ...account("d"), profile: "pd" },
  ]);
  await bb.storage.kv.set("order:v1", {
    "claude-code": ["a", "b", "c", "d"],
  });
  // C was last read before its weekly limit reset.
  await bb.storage.kv.set("usage:v1", {
    c: [{ label: "Weekly limit", usedPercent: 90, resetsAt: Date.now() - 1 }],
  });
  const reset = Math.floor(Date.now() / 1_000) + 2 * 86_400;
  const weekly = (
    usedPercent: number,
    resetsAt: number | null = reset * 1_000,
  ) => [{ label: "Weekly limit", usedPercent, resetsAt }];
  const asked: string[] = [];
  let online = true;
  let full = 40;
  // While set, D's read waits for it.
  let hold: Promise<void> | null = null;
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    const token = new Headers(init.headers).get("authorization")!.slice(7);
    asked.push(token);
    if (token === "d-full") await hold;
    if (!online) throw new Error("offline");
    if (url.endsWith("/api/oauth/usage"))
      return Response.json({
        seven_day: {
          utilization: full,
          resets_at: new Date(reset * 1_000).toISOString(),
        },
      });
    return new Response("{}", {
      headers: {
        "anthropic-ratelimit-unified-7d-utilization":
          token === "a" ? "0.2" : "0.75",
        "anthropic-ratelimit-unified-7d-reset": String(reset),
      },
    });
  });
  const rows = async (host: typeof harness) =>
    Object.fromEntries(
      (
        (await host.callRpc("accounts.list", { provider: "claude-code" })) as {
          id: string;
          windows: unknown;
          error: string | null;
        }[]
      ).map((row) => [row.id, row.error ?? row.windows]),
    );
  try {
    await plugin(bb);
    // B had nothing saved, so one reply fills its row. C's saved bar and D's full login need none.
    await vi.waitFor(async () =>
      expect(await rows(harness)).toMatchObject({
        a: weekly(20),
        b: weekly(75),
        c: weekly(0, null),
        d: weekly(40),
      }),
    );
    expect(asked.sort()).toEqual(["a", "b", "d-full"]);

    // A restart while D's read is still waiting: the old run's read ends quietly, the new run's lands.
    asked.length = 0;
    let release = () => {};
    hold = new Promise((resolve) => (release = resolve));
    let next = await harness.lifecycle.reload(plugin);
    await vi.waitFor(() => expect(asked).toContain("d-full"));
    next = await next.harness.lifecycle.reload(plugin);
    full = 55;
    release();
    await vi.waitFor(async () =>
      expect(await rows(next.harness)).toMatchObject({ d: weekly(55) }),
    );

    // Offline after a restart: every saved bar stays, and D shows no error.
    asked.length = 0;
    hold = null;
    online = false;
    next = await next.harness.lifecycle.reload(plugin);
    await vi.waitFor(() => expect(asked.sort()).toEqual(["a", "d-full"]));
    expect(await rows(next.harness)).toMatchObject({
      b: weekly(75),
      c: weekly(0, null),
      d: weekly(55),
    });
    // Removing an account drops its saved bars.
    await next.harness.callRpc("accounts.remove", {
      provider: "claude-code",
      id: "b",
    });
    expect(
      Object.keys((await next.bb.storage.kv.get("usage:v1")) ?? {}).sort(),
    ).toEqual(["a", "c", "d"]);
  } finally {
    vi.unstubAllGlobals();
  }
});

// Threads pinned to an account, alone or through their project, keep it whatever the default becomes.
it("a pinned thread or project runs on its own account", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "accounts-test-"));
  dirs.push(dataDir);
  const projects: Record<string, string> = { t: "p", t2: "p", u: "q" };
  const { bb, harness } = createFakePluginHost({
    pluginId: "accounts",
    dataDir,
    sdk: {
      system: { config: async () => ({ primaryHostId: "h" }) as never },
      threads: {
        get: async ({ threadId }: { threadId: string }) =>
          makeThreadResponse({
            id: threadId,
            projectId: projects[threadId] ?? "p",
            providerId: "claude-code",
            executionTarget: "local",
            status: "idle",
          }),
      },
    },
  });
  const secrets = path.join(dataDir, "plugins", "accounts", "secrets");
  await fs.mkdir(secrets, { recursive: true });
  for (const id of ["a", "b", "c"])
    await fs.writeFile(
      path.join(secrets, `${id}.json`),
      JSON.stringify({ accessToken: `tok-${id}`, refreshToken: "", expiresAt: null }),
    );
  await bb.storage.kv.set("accounts:v1", [account("a"), account("b"), account("c")]);
  await bb.storage.kv.set("order:v1", { "claude-code": ["a", "b", "c"] });
  await plugin(bb);
  const token = async (threadId: string) =>
    (
      await harness.resolveProviderEnv("claude-code", {
        threadId,
        projectId: projects[threadId]!,
        hostId: "h",
      })
    ).find((entry) => entry.name === "CLAUDE_CODE_OAUTH_TOKEN")?.value;

  await harness.callRpc("accounts.pin", { threadId: "t", scope: "project", id: "b" });
  await harness.callRpc("accounts.pin", { threadId: "t2", scope: "thread", id: "c" });
  expect([await token("t"), await token("t2"), await token("u")]).toEqual(["tok-b", "tok-c", "tok-a"]);
  expect(await harness.callRpc("accounts.thread", { threadId: "t" })).toMatchObject({
    default: "a",
    thread: null,
    project: "b",
    cloud: false,
  });

  // A new default moves only unpinned threads.
  await harness.callRpc("accounts.use", { provider: "claude-code", id: "c" });
  expect([await token("t"), await token("u")]).toEqual(["tok-b", "tok-c"]);

  // Picking an account from a pinned thread (its plan limit) pins that thread, not the default.
  await harness.callRpc("accounts.use", { provider: "claude-code", id: "a", threadId: "t" });
  expect([await token("t"), await token("t2"), await token("u")]).toEqual(["tok-a", "tok-c", "tok-c"]);

  // A removed account's pins go: the thread follows its project, then the default.
  await harness.callRpc("accounts.remove", { provider: "claude-code", id: "a" });
  await harness.callRpc("accounts.pin", { threadId: "t", scope: "project", id: null });
  expect(await token("t")).toBe("tok-c");
});

// A new thread's composer: "This thread" rides the first message and is pinned before its first turn; "All Local
// threads in this project" pins the project straight away.
it("pins a new thread's pick from its first message, and its project from the composer", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "accounts-test-"));
  dirs.push(dataDir);
  const { bb, harness } = createFakePluginHost({
    pluginId: "accounts",
    dataDir,
    sdk: {
      system: { config: async () => ({ primaryHostId: "h" }) as never },
      threads: {
        get: async ({ threadId }: { threadId: string }) =>
          makeThreadResponse({ id: threadId, projectId: "p", providerId: "claude-code", executionTarget: "local" }),
      },
    },
  });
  const secrets = path.join(dataDir, "plugins", "accounts", "secrets");
  await fs.mkdir(secrets, { recursive: true });
  for (const id of ["a", "b", "c"])
    await fs.writeFile(
      path.join(secrets, `${id}.json`),
      JSON.stringify({ accessToken: `tok-${id}`, refreshToken: "", expiresAt: null }),
    );
  await bb.storage.kv.set("accounts:v1", [account("a"), account("b"), account("c")]);
  await bb.storage.kv.set("order:v1", { "claude-code": ["a", "b", "c"] });
  await plugin(bb);
  const hook = harness.registrations.hooks["message.dispatch"]!;
  const token = async (threadId: string, projectId = "p") =>
    (
      await harness.resolveProviderEnv("claude-code", { threadId, projectId, hostId: "h" })
    ).find((entry) => entry.name === "CLAUDE_CODE_OAUTH_TOKEN")?.value;
  const first = (
    id: string,
    thread: { providerId?: string; executionTarget?: "local" | "cloud" } = {},
    pluginId = "accounts",
  ) =>
    hook(
      makeMessageDispatchHookContext({
        thread: makeThreadResponse({
          id,
          projectId: "p",
          providerId: "claude-code",
          executionTarget: "local",
          status: "pending",
          ...thread,
        }),
        experimental_submission: { pluginId, data: { provider: "claude-code", id: "b" } },
      }),
    );

  expect(await first("n")).toEqual({ action: "proceed" });
  expect(await token("n")).toBe("tok-b");
  // Another plugin's data, a Cloud thread, and a thread on another agent keep the default.
  await first("other", {}, "drafts");
  await first("cloud", { executionTarget: "cloud" });
  await first("codex", { providerId: "codex" });
  expect([await token("other"), await token("cloud"), await token("codex")]).toEqual(["tok-a", "tok-a", "tok-a"]);
  expect(await harness.callRpc("accounts.thread", { threadId: "n" })).toMatchObject({ thread: "b" });

  // No thread yet: the composer reads by project and agent, and pins the project.
  expect(await harness.callRpc("accounts.thread", { projectId: "q", provider: "claude-code" })).toMatchObject({
    provider: "claude-code",
    accounts: expect.arrayContaining(["a", "b", "c"].map((id) => expect.objectContaining({ id }))),
    default: "a",
    thread: null,
    project: null,
    cloud: false,
  });
  await harness.callRpc("accounts.pin", { projectId: "q", provider: "claude-code", scope: "project", id: "c" });
  expect(await token("u", "q")).toBe("tok-c");
  expect(await harness.callRpc("accounts.thread", { projectId: "q", provider: "claude-code" })).toMatchObject({
    project: "c",
  });
  await expect(
    harness.callRpc("accounts.pin", { projectId: "q", provider: "claude-code", scope: "project", id: "gone" }),
  ).rejects.toThrow("That account is gone");
});

// Threads a plan limit stopped: a new pin continues them on its account, a new default never moves a pinned one.
const recovery = async (
  threads: Record<
    string,
    { projectId: string; providerId?: string; executionTarget?: "local" | "cloud"; status?: "idle" | "active" }
  >,
  stored?: Record<string, unknown>,
  // `projects`: the projects that still exist, when a test pins some; `projectPins`: pins stored before start.
  options?: {
    inCloud?: string;
    projects?: string[];
    projectPins?: Record<string, Record<string, string>>;
    threadPins?: Record<string, Record<string, string>>;
    // Extra fields on the stored account records, by id.
    records?: Record<string, Record<string, unknown>>;
  },
) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "accounts-test-"));
  dirs.push(dataDir);
  const retries: { threadId: string; turnRequestId?: string; accountSwitch?: unknown }[] = [];
  const { bb, harness } = createFakePluginHost({
    pluginId: "accounts",
    dataDir,
    sdk: {
      system: { config: async () => ({ primaryHostId: "h" }) as never },
      projects: {
        get: async ({ projectId }: { projectId: string }) => {
          if (options?.projects && !options.projects.includes(projectId))
            throw Object.assign(new Error("HTTP 404: not found"), { status: 404 });
          return { id: projectId } as never;
        },
      },
      threads: {
        get: async ({ threadId }: { threadId: string }) => {
          const thread = threads[threadId];
          if (!thread) throw new Error("not found");
          return makeThreadResponse({
            id: threadId,
            projectId: thread.projectId,
            providerId: thread.providerId ?? "claude-code",
            executionTarget: thread.executionTarget ?? "local",
            status: thread.status ?? "idle",
          });
        },
        retry: async (input: (typeof retries)[number]) => {
          retries.push(input);
          return {} as never;
        },
      },
    },
  });
  const secrets = path.join(dataDir, "plugins", "accounts", "secrets");
  await fs.mkdir(secrets, { recursive: true });
  for (const id of ["a", "b", "c"])
    await fs.writeFile(
      path.join(secrets, `${id}.json`),
      JSON.stringify({ accessToken: `tok-${id}`, refreshToken: "", expiresAt: null }),
    );
  await bb.storage.kv.set(
    "accounts:v1",
    ["a", "b", "c"].map((id) => ({ ...account(id), ...options?.records?.[id] })),
  );
  await bb.storage.kv.set("order:v1", { "claude-code": ["a", "b", "c"] });
  // Each test starts with no pins, limits, or stopped threads.
  await bb.storage.kv.set("limited-threads:v1", stored ?? {});
  await bb.storage.kv.set("pins:v1", { thread: options?.threadPins ?? {}, project: options?.projectPins ?? {} });
  await bb.storage.kv.set("limits:v1", {});
  if (options?.inCloud) await bb.storage.kv.set("cloud:v1", options.inCloud);
  await plugin(bb);
  // A turn's launch: the env for its request, which a later failure or idle names.
  const token = async (threadId: string, requestId = `req-${threadId}`) =>
    (
      await harness.resolveProviderEnv("claude-code", {
        threadId,
        projectId: threads[threadId]!.projectId,
        hostId: "h",
        requestId,
      })
    ).find((entry) => entry.name === "CLAUDE_CODE_OAUTH_TOKEN")?.value;
  const limit = (
    threadId: string,
    requestId = `req-${threadId}`,
    ranIn: "local" | "cloud" | null = "local",
  ) =>
    harness.emitThreadEvent(
      "turn.failed",
      makeTurnFailedEvent({
        threadId,
        requestId,
        ...(ranIn ? { experimental_executionTarget: ranIn } : {}),
        errorInfo: { category: "rate-limit", providerCode: null, httpStatusCode: 429 },
      }),
    );
  // A turn that ended fine, on the request it ended on, as Cloud store and Local lifecycle both announce it.
  const idle = (threadId: string, requestId = `req-${threadId}`) =>
    harness.emitThreadEvent("thread.idle", {
      thread: makeThreadResponse({
        id: threadId,
        projectId: threads[threadId]!.projectId,
        providerId: "claude-code",
        executionTarget: threads[threadId]!.executionTarget ?? "local",
        status: "idle",
      }),
      lastAssistantText: null,
      experimental_requestId: requestId,
    });
  const limited = async () =>
    Object.keys((await bb.storage.kv.get("limits:v1")) ?? {}).sort();
  const waiting = async () =>
    Object.keys((await bb.storage.kv.get("limited-threads:v1")) ?? {}).sort();
  const pin = (threadId: string, scope: "thread" | "project", id: string | null) =>
    harness.callRpc("accounts.pin", { threadId, scope, id });
  const use = (id: string) => harness.callRpc("accounts.use", { provider: "claude-code", id });
  const continued = () =>
    retries.map(({ threadId, turnRequestId, accountSwitch }) => ({ threadId, turnRequestId, accountSwitch }));
  return { token, limit, idle, limited, waiting, pin, use, continued, harness, bb };
};
const moved = (threadId: string, from: string, to: string) => ({
  threadId,
  turnRequestId: `req-${threadId}`,
  accountSwitch: { provider: "claude-code", from: `${from}@example.com`, to: `${to}@example.com` },
});

it("a thread its project pinned continues its failed turn when pinned to another account", async () => {
  const { token, limit, pin, continued } = await recovery({ t: { projectId: "p" } });
  await pin("t", "project", "b");
  expect(await token("t")).toBe("tok-b");
  await limit("t");
  expect(continued()).toEqual([]);
  await pin("t", "thread", "c");
  expect(continued()).toEqual([moved("t", "b", "c")]);
  expect(await token("t")).toBe("tok-c");
});

it("a thread pinned after its limit stays put when the default changes", async () => {
  const { token, limit, pin, use, continued } = await recovery({ t: { projectId: "p" } });
  expect(await token("t")).toBe("tok-a");
  await limit("t");
  await pin("t", "thread", "a");
  await use("c");
  expect(continued()).toEqual([]);
  expect(await token("t")).toBe("tok-a");
  // A later pin elsewhere still continues the turn that failed.
  await pin("t", "thread", "b");
  expect(continued()).toEqual([moved("t", "a", "b")]);
});

it("a pin made while the turn runs continues it on the pinned account when its limit lands", async () => {
  const { token, limit, pin, continued } = await recovery({ t: { projectId: "p" } });
  expect(await token("t")).toBe("tok-a");
  await pin("t", "thread", "b");
  expect(continued()).toEqual([]);
  await limit("t");
  expect(continued()).toEqual([moved("t", "a", "b")]);
});

it("a project pin continues every Local thread of that agent it moves, and a new default only unpinned ones", async () => {
  const threads: Record<string, { projectId: string; providerId?: string }> = {
    t: { projectId: "p" },
    sibling: { projectId: "p" },
    own: { projectId: "p" },
    switched: { projectId: "p" },
    other: { projectId: "q" },
  };
  const { token, limit, pin, use, continued } = await recovery(threads);
  for (const id of Object.keys(threads)) {
    expect(await token(id)).toBe("tok-a");
    await limit(id);
  }
  await pin("own", "thread", "a");
  // A harness switch leaves Claude: its stale record is not this agent's to continue.
  threads.switched!.providerId = "codex";
  await pin("t", "project", "b");
  // One pin or default continues its threads concurrently: the order of their retries is not a guarantee.
  const byThread = () => continued().sort((x, y) => x.threadId.localeCompare(y.threadId));
  expect(byThread()).toEqual([moved("sibling", "a", "b"), moved("t", "a", "b")]);
  await use("c");
  expect(byThread()).toEqual([moved("other", "a", "c"), moved("sibling", "a", "b"), moved("t", "a", "b")]);
});

it("a new default leaves Cloud threads to Core and skips threads that are gone", async () => {
  const { use, continued } = await recovery(
    { cloud: { projectId: "p", executionTarget: "cloud" } },
    {
      cloud: { provider: "claude-code", account: "a", requestId: "req-cloud" },
      gone: { provider: "claude-code", account: "a", requestId: "req-gone" },
    },
  );
  await use("c");
  expect(continued()).toEqual([]);
});

it("picking an account from a limited thread keeps the failed turn's request", async () => {
  const { token, limit, continued, harness } = await recovery({ t: { projectId: "p" } });
  expect(await token("t")).toBe("tok-a");
  await limit("t");
  // Picking from the thread notes it again, without a turn: the retry still names the turn that failed.
  await harness.callRpc("accounts.use", { provider: "claude-code", id: "c", threadId: "t" });
  expect(continued()).toEqual([moved("t", "a", "c")]);
});

// A Codex account removed on the website or another computer: its pin stays until a list proves it gone, then the
// thread follows its project's pin rather than the app's selected account.
it("a Codex pin to an account gone from the website falls back to the project's pin", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "accounts-test-"));
  dirs.push(dataDir);
  vi.stubEnv("HOME", dataDir);
  vi.stubEnv("CODEX_HOME", path.join(dataDir, ".codex"));
  try {
    const codexAccount = (id: string, inUse: boolean) => ({
      id,
      name: null,
      email: `${id}@example.com`,
      plan: null,
      inUse,
      error: null,
      windows: [],
    });
    let signedIn = false;
    const { bb, harness } = createFakePluginHost({
      pluginId: "accounts",
      dataDir,
      sdk: {
        system: { config: async () => ({ primaryHostId: "h" }) as never },
        cloudroom: {
          codexAccounts: async () =>
            (signedIn
              ? { signedIn, accounts: [codexAccount("b", false), codexAccount("c", true)] }
              : { signedIn, accounts: [] }) as never,
        },
        threads: {
          get: async ({ threadId }: { threadId: string }) =>
            makeThreadResponse({
              id: threadId,
              projectId: "p",
              providerId: "codex",
              executionTarget: "local",
              status: "idle",
            }),
        },
      },
    });
    await bb.storage.kv.set("limited-threads:v1", {});
    await bb.storage.kv.set("limits:v1", {});
    await bb.storage.kv.set("pins:v1", { thread: { t: { codex: "gone" } }, project: { p: { codex: "b" } } });
    await plugin(bb);
    const pinnedEnv = async () =>
      (await harness.resolveProviderEnv("codex", { threadId: "t", projectId: "p", hostId: "h" })).find(
        (entry) => entry.name === "CLOUDROOM_CODEX_ACCOUNT",
      )?.value;
    // No list yet, or signed out of Cloudroom: the pin may still be good.
    expect(await pinnedEnv()).toBe("gone");
    await harness.callRpc("accounts.list", { provider: "codex" });
    expect(await pinnedEnv()).toBe("gone");
    // Signed out, the app runs it on the Mac's own login, not the pin: that is the account its limit names.
    await harness.resolveProviderEnv("codex", { threadId: "t", projectId: "p", hostId: "h", requestId: "r-out" });
    await harness.emitThreadEvent(
      "turn.failed",
      makeTurnFailedEvent({
        threadId: "t",
        requestId: "r-out",
        experimental_executionTarget: "local",
        errorInfo: { category: "rate-limit", providerCode: null, httpStatusCode: 429 },
      }),
    );
    expect(await bb.storage.kv.get("limited-threads:v1")).toMatchObject({ t: { account: "local" } });
    signedIn = true;
    await harness.callRpc("accounts.list", { provider: "codex" });
    expect(await pinnedEnv()).toBe("b");
    expect(await bb.storage.kv.get("pins:v1")).toEqual({ thread: {}, project: { p: { codex: "b" } } });
    // A Local Codex limit marks the account the thread was handed.
    await harness.emitThreadEvent(
      "turn.failed",
      makeTurnFailedEvent({
        threadId: "t",
        requestId: "req-t",
        experimental_executionTarget: "local",
        errorInfo: { category: "rate-limit", providerCode: null, httpStatusCode: 429 },
      }),
    );
    expect(Object.keys((await bb.storage.kv.get("limits:v1")) ?? {})).toEqual(["codex:b"]);
  } finally {
    vi.unstubAllEnvs();
  }
});

// Which account a limit or a success belongs to: the one the failed or finished request launched on, never the
// thread's account now. Cloud turns, and turns this plugin never launched, mark and clear no account.
it("a Cloud limit after Teleport marks neither the thread's Local pin nor the default", async () => {
  const threads = { t: { projectId: "p", executionTarget: "local" as "local" | "cloud" } };
  const { token, limit, pin, limited, waiting, continued } = await recovery(threads);
  await pin("t", "thread", "b");
  expect(await token("t")).toBe("tok-b");
  threads.t.executionTarget = "cloud";
  // The Cloud turn's failure names the last Local request, since the handoff appends none.
  await limit("t", "req-t", "cloud");
  // A failure core cannot place is not this computer's either.
  await limit("t", "req-t", null);
  await limit("t", "req-cloud", "cloud");
  expect(await limited()).toEqual([]);
  expect(await waiting()).toEqual([]);
  expect(continued()).toEqual([]);
});

it("a Local turn's limit that lands after Teleport still marks the account it ran on, and leaves the thread to Core", async () => {
  const threads = { t: { projectId: "p", executionTarget: "local" as "local" | "cloud" } };
  const { token, limit, pin, limited, waiting, continued } = await recovery(threads);
  await pin("t", "thread", "b");
  expect(await token("t")).toBe("tok-b");
  threads.t.executionTarget = "cloud";
  await limit("t");
  expect(await limited()).toEqual(["claude-code:b"]);
  expect(await waiting()).toEqual([]);
  expect(continued()).toEqual([]);
});

it("a Cloud thread brought back runs its Local turns on its pin", async () => {
  const threads = { t: { projectId: "p", executionTarget: "cloud" as "local" | "cloud" } };
  const { token, limit, pin, limited, waiting, continued } = await recovery(threads);
  await pin("t", "thread", "b");
  // Back on this computer before the Cloud failure lands: Core still owns that failed turn.
  threads.t.executionTarget = "local";
  await limit("t", "req-cloud", "cloud");
  expect(await limited()).toEqual([]);
  expect(await waiting()).toEqual([]);
  expect(await token("t", "req-local")).toBe("tok-b");
  await limit("t", "req-local");
  expect(await limited()).toEqual(["claude-code:b"]);
  // Pinned: it waits for its own account or a new pin, not the default.
  expect(continued()).toEqual([]);
});

it("a new default while a turn runs leaves its limit on the account it began on", async () => {
  const { token, limit, use, limited, continued } = await recovery({ t: { projectId: "p" } });
  expect(await token("t")).toBe("tok-a");
  await use("b");
  await limit("t");
  expect(await limited()).toEqual(["claude-code:a"]);
  // It ran on an account the user already left: it continues on the new default at once.
  expect(continued()).toEqual([moved("t", "a", "b")]);
});

it("a turn that ends fine clears only the limit of the account it ran on, after that limit", async () => {
  const threads: Record<string, { projectId: string; executionTarget?: "local" | "cloud" }> = {
    t: { projectId: "p" },
    u: { projectId: "p" },
  };
  const { token, limit, idle, use, limited } = await recovery(threads);
  expect(await token("t")).toBe("tok-a");
  await limit("t");
  expect(await limited()).toEqual(["claude-code:a"]);
  // U began on A after A's limit; the default moves to B, which then hits its own limit.
  await new Promise((done) => setTimeout(done, 5));
  expect(await token("u", "u1")).toBe("tok-a");
  await use("b");
  expect(await token("t", "t2")).toBe("tok-b");
  await limit("t", "t2");
  expect(await limited()).toEqual(["claude-code:a", "claude-code:b"]);
  // U ends fine: A works again, and B, which U never ran on, stays limited.
  await idle("u", "u1");
  expect(await limited()).toEqual(["claude-code:b"]);
  // An idle with no launch here (after a restart, or a request this plugin never saw) clears nothing.
  await idle("u", "unknown");
  // Moved to Cloud: its idle names the last Local request, which ran on B before B's limit; it clears nothing either.
  threads.t!.executionTarget = "cloud";
  await idle("t", "t2");
  expect(await limited()).toEqual(["claude-code:b"]);
});

it("a turn that began before its account's limit clears nothing when it ends", async () => {
  const { token, limit, idle, limited } = await recovery({ t: { projectId: "p" }, u: { projectId: "p" } });
  expect(await token("u", "u1")).toBe("tok-a");
  expect(await token("t")).toBe("tok-a");
  await limit("t");
  await idle("u", "u1");
  expect(await limited()).toEqual(["claude-code:a"]);
});

it("after a restart a limit marks no account, yet a new pick still continues the thread", async () => {
  const { token, harness, continued } = await recovery({ t: { projectId: "p" } });
  expect(await token("t")).toBe("tok-a");
  const next = await harness.lifecycle.reload(plugin);
  await next.harness.emitThreadEvent(
    "turn.failed",
    makeTurnFailedEvent({
      threadId: "t",
      requestId: "req-t",
      experimental_executionTarget: "local",
      errorInfo: { category: "rate-limit", providerCode: null, httpStatusCode: 429 },
    }),
  );
  expect(Object.keys((await next.bb.storage.kv.get("limits:v1")) ?? {})).toEqual([]);
  expect(Object.keys((await next.bb.storage.kv.get("limited-threads:v1")) ?? {})).toEqual(["t"]);
  await next.harness.callRpc("accounts.use", { provider: "claude-code", id: "b" });
  expect(continued()).toEqual([moved("t", "a", "b")]);
});

it("two threads' requests with the same id keep their own accounts", async () => {
  const { token, limit, use, limited } = await recovery({ t: { projectId: "p" }, u: { projectId: "p" } });
  expect(await token("t", "same")).toBe("tok-a");
  await use("b");
  expect(await token("u", "same")).toBe("tok-b");
  await limit("t", "same");
  expect(await limited()).toEqual(["claude-code:a"]);
});

it("a steer's request is the running turn's; one naming a request never seen keeps the thread's last launch", async () => {
  const { token, limit, use, limited, harness } = await recovery({ t: { projectId: "p" }, u: { projectId: "p" } });
  expect(await token("t", "r1")).toBe("tok-a");
  await use("b");
  const steer = (threadId: string, requestId: string, runningTurnRequestId: string) =>
    harness.resolveProviderEnv("claude-code", { threadId, projectId: "p", hostId: "h", requestId, runningTurnRequestId });
  await steer("t", "r2", "r1");
  // The running request is one this plugin never saw: the turn is still the one the thread last launched, on A.
  await steer("t", "r3", "gone");
  await limit("t", "r3");
  expect(await limited()).toEqual(["claude-code:a"]);
  await limit("t", "r2");
  expect(await limited()).toEqual(["claude-code:a"]);
  // A thread with no launch here (its turn began before a restart): unknown, so no account is marked.
  await steer("u", "s2", "gone");
  await limit("u", "s2");
  expect(await limited()).toEqual(["claude-code:a"]);
});

it("a steer after an \"auto\" request that joined without an id keeps the limit on the account the turn runs on", async () => {
  const threads = { t: { projectId: "p", status: "idle" as "idle" | "active" } };
  const { token, limit, use, limited, harness } = await recovery(threads);
  expect(await token("t", "r1")).toBe("tok-a");
  threads.t.status = "active";
  await use("b");
  // An "auto" send that joined the running turn with no request id, then the user's steer naming it (r2).
  await harness.resolveProviderEnv("claude-code", { threadId: "t", projectId: "p", hostId: "h" });
  await harness.resolveProviderEnv("claude-code", {
    threadId: "t",
    projectId: "p",
    hostId: "h",
    requestId: "r3",
    runningTurnRequestId: "r2",
  });
  await limit("t", "r3");
  expect(await limited()).toEqual(["claude-code:a"]);
});

it("a successful turn that an \"auto\" request joined clears its account's limit", async () => {
  const threads = { o: { projectId: "p" }, t: { projectId: "p", status: "idle" as "idle" | "active" } };
  const { token, limit, idle, limited, harness } = await recovery(threads);
  expect(await token("o", "o1")).toBe("tok-a");
  await limit("o", "o1");
  expect(await limited()).toEqual(["claude-code:a"]);
  await new Promise((done) => setTimeout(done, 5));
  expect(await token("t", "r1")).toBe("tok-a");
  threads.t.status = "active";
  // A child's report joins the running turn: the server names the request that turn accepted.
  await harness.resolveProviderEnv("claude-code", {
    threadId: "t",
    projectId: "p",
    hostId: "h",
    requestId: "r2",
    runningTurnRequestId: "r1",
  });
  threads.t.status = "idle";
  await idle("t", "r2");
  expect(await limited()).toEqual([]);
});

it("a joined request of a turn that began before the limit clears nothing", async () => {
  const threads = { o: { projectId: "p" }, t: { projectId: "p", status: "idle" as "idle" | "active" } };
  const { token, limit, idle, limited, harness } = await recovery(threads);
  expect(await token("t", "r1")).toBe("tok-a");
  expect(await token("o", "o1")).toBe("tok-a");
  await limit("o", "o1");
  threads.t.status = "active";
  await harness.resolveProviderEnv("claude-code", {
    threadId: "t",
    projectId: "p",
    hostId: "h",
    requestId: "r2",
    runningTurnRequestId: "r1",
  });
  threads.t.status = "idle";
  await idle("t", "r2");
  expect(await limited()).toEqual(["claude-code:a"]);
});

// The plan-limit card on a thread pinned to B (default A) that hit B's limit: it shows B as current and offers A.
it("on a pinned thread, picking its own account changes nothing and picking another continues it", async () => {
  const { token, limit, limited, continued, harness } = await recovery(
    { t: { projectId: "p", status: "idle" } },
    undefined,
    { threadPins: { t: { "claude-code": "b" } } },
  );
  expect(await token("t")).toBe("tok-b");
  await limit("t");
  expect(await limited()).toEqual(["claude-code:b"]);
  expect(await harness.callRpc("accounts.thread", { threadId: "t" })).toMatchObject({
    default: "a",
    thread: "b",
    project: null,
  });
  await harness.callRpc("accounts.use", { provider: "claude-code", id: "b", threadId: "t" });
  expect(await limited()).toEqual(["claude-code:b"]);
  expect(continued()).toEqual([]);
  await harness.callRpc("accounts.use", { provider: "claude-code", id: "a", threadId: "t" });
  expect(await limited()).toEqual(["claude-code:b"]);
  expect(continued()).toEqual([moved("t", "b", "a")]);
  expect(await token("t", "next")).toBe("tok-a");
});

it("a pin to this Mac's login once it is added as an account runs on what the picker shows", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "accounts-home-"));
  dirs.push(home);
  await fs.writeFile(
    path.join(home, ".claude.json"),
    JSON.stringify({ oauthAccount: { emailAddress: "b@example.com", organizationUuid: "org-b" } }),
  );
  vi.stubEnv("HOME", home);
  try {
    const { token, harness } = await recovery({ t: { projectId: "p" } }, undefined, {
      threadPins: { t: { "claude-code": "local" } },
      records: { b: { org: "org-b" } },
    });
    // The Mac's login is account B, so its tile is hidden: the pin is not shown, and not used.
    expect(await harness.callRpc("accounts.thread", { threadId: "t" })).toMatchObject({ default: "a", thread: null });
    expect(await token("t")).toBe("tok-a");
  } finally {
    vi.unstubAllEnvs();
  }
});

it("a Cursor limit marks the account whose key ran it, and never this Mac's login for another machine's", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "accounts-test-"));
  dirs.push(dataDir);
  const { bb, harness } = createFakePluginHost({
    pluginId: "accounts",
    dataDir,
    sdk: {
      system: { config: async () => ({ primaryHostId: "h" }) as never },
      threads: {
        get: async ({ threadId }: { threadId: string }) =>
          makeThreadResponse({ id: threadId, providerId: "acp-cursor", executionTarget: "local", status: "idle" }),
      },
    },
  });
  // No Cursor accounts: every machine runs on its own Cursor login.
  await bb.storage.kv.set("accounts:v1", []);
  await bb.storage.kv.set("limits:v1", {});
  await bb.storage.kv.set("limited-threads:v1", {});
  await plugin(bb);
  const run = async (threadId: string, hostId: string) => {
    await harness.resolveProviderEnv("acp-cursor", { threadId, projectId: "p", hostId, requestId: "r" });
    await harness.emitThreadEvent(
      "turn.failed",
      makeTurnFailedEvent({
        threadId,
        requestId: "r",
        experimental_executionTarget: "local",
        errorInfo: { category: "rate-limit", providerCode: null, httpStatusCode: 429 },
      }),
    );
  };
  const limitedThreads = async () =>
    Object.keys((await bb.storage.kv.get("limited-threads:v1")) ?? {}).sort();
  await run("remote", "m");
  // Another machine's own login: no account here, and no switch here moves it.
  expect(await limitedThreads()).toEqual([]);
  await run("here", "h");
  expect(await limitedThreads()).toEqual(["here"]);
});

it("a Cloud turn's success after Teleport never clears the limit of the Local launch its idle names", async () => {
  const threads = { t: { projectId: "p", executionTarget: "local" as "local" | "cloud" } };
  const { token, limit, idle, pin, limited, harness } = await recovery(threads);
  await pin("t", "thread", "b");
  expect(await token("t", "r1")).toBe("tok-b");
  await limit("t", "r1");
  expect(await limited()).toEqual(["claude-code:b"]);
  // A Local launch on B after B's limit, then Teleport: the Cloud turn's idle names r2, the handoff appending none.
  await new Promise((done) => setTimeout(done, 5));
  expect(await token("t", "r2")).toBe("tok-b");
  threads.t.executionTarget = "cloud";
  await harness.emitThreadEvent("thread.active", {
    thread: makeThreadResponse({ id: "t", projectId: "p", providerId: "claude-code", executionTarget: "cloud", status: "active" }),
  });
  await idle("t", "r2");
  expect(await limited()).toEqual(["claude-code:b"]);
  // The same idle from the Local turn itself does clear it: only the Cloud guard kept it above.
  threads.t.executionTarget = "local";
  await idle("t", "r2");
  expect(await limited()).toEqual([]);
});

it("a Cloud limit marks the account Cloud runs on, never the thread's Local pin or the default", async () => {
  const threads = { t: { projectId: "p", executionTarget: "local" as "local" | "cloud" } };
  const { token, limit, pin, limited, waiting, continued } = await recovery(threads, undefined, { inCloud: "c" });
  await pin("t", "thread", "b");
  expect(await token("t")).toBe("tok-b");
  threads.t.executionTarget = "cloud";
  await limit("t", "req-t", "cloud");
  expect(await limited()).toEqual(["claude-code:c"]);
  // Core continues Cloud threads.
  expect(await waiting()).toEqual([]);
  expect(continued()).toEqual([]);
});

it("a limit on a request this plugin never saw lands on what the thread was last handed", async () => {
  const threads = { t: { projectId: "p", status: "idle" as "idle" | "active" } };
  const { token, limit, use, limited, harness } = await recovery(threads);
  expect(await token("t", "r1")).toBe("tok-a");
  await use("b");
  // A retry made inside a transaction: a new turn, but its command carries no request id.
  await harness.resolveProviderEnv("claude-code", { threadId: "t", projectId: "p", hostId: "h" });
  await limit("t", "r-retry");
  expect(await limited()).toEqual(["claude-code:b"]);
});

it("an \"auto\" send that joins a running turn leaves its limit on the account the turn began on", async () => {
  const threads = { t: { projectId: "p", status: "idle" as "idle" | "active" } };
  const { token, limit, use, limited, harness } = await recovery(threads);
  expect(await token("t", "r1")).toBe("tok-a");
  threads.t.status = "active";
  await use("b");
  await harness.resolveProviderEnv("claude-code", { threadId: "t", projectId: "p", hostId: "h" });
  await limit("t", "r-auto");
  expect(await limited()).toEqual(["claude-code:a"]);
});

it("pins of projects that are gone are dropped at start", async () => {
  const { bb } = await recovery({ t: { projectId: "p" } }, undefined, {
    projects: ["p"],
    projectPins: { p: { "claude-code": "b" }, gone: { "claude-code": "c" } },
  });
  await vi.waitFor(async () =>
    expect(await bb.storage.kv.get("pins:v1")).toEqual({ thread: {}, project: { p: { "claude-code": "b" } } }),
  );
});

it("a limit on another agent's turn never lands on the account an earlier Claude turn ran on", async () => {
  const threads = { t: { projectId: "p", providerId: "claude-code" } };
  const { token, limit, limited, waiting } = await recovery(threads);
  expect(await token("t", "r1")).toBe("tok-a");
  // The thread switched to an agent with no accounts here: its turns resolve no env from this plugin.
  threads.t.providerId = "acp-gemini";
  await limit("t", "r-other");
  expect(await limited()).toEqual([]);
  expect(await waiting()).toEqual([]);
});
