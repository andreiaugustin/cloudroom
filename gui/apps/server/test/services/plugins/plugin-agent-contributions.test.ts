import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createConnection,
  getAppSettings,
  threads,
  migrate,
  setAppSettings,
  type DbConnection,
} from "@cloudroom/db";
import { encodeClientTurnRequestIdNumber } from "@cloudroom/domain";
import type { Logger } from "@cloudroom/logger";
import { createAiServiceRegistry } from "../../../src/services/ai/ai-service-registry.js";
import { CodexAccounts } from "../../../src/services/cloudroom/codex-accounts.js";
import {
  createPluginService,
  type PluginService,
} from "../../../src/services/plugins/plugin-service.js";
import {
  SkillTreeRegistry,
  resolveProjectSkillSourceFromContent,
  resolveSkillCatalogEntries,
} from "../../../src/services/skills/injected-skills.js";
import {
  buildExecutionOptions,
  buildThreadStartCommand,
  prepareTurnSubmitCommandPayload,
} from "../../../src/services/threads/thread-commands.js";
import { textInput } from "../../helpers/prompt-input.js";
import {
  reportNextEnvironmentAttachSuccess,
  waitForQueuedCommand,
} from "../../helpers/commands.js";
import { setPluginHookProvider } from "../../../src/services/plugins/plugin-hook-registry.js";
import { createThreadFromRequest } from "../../../src/services/threads/thread-create.js";
import { applyLoggedThreadLifecycleEvent } from "../../../src/services/threads/lifecycle-outcome.js";
import {
  seedEvent,
  seedEnvironment,
  seedHostSession,
  seedProjectWithSource,
  seedThread,
  seedThreadRuntimeState,
} from "../../helpers/seed.js";
import {
  createTestAppHarness,
  testLogger,
  type TestAppHarness,
} from "../../helpers/test-app.js";
import { createNoopTelemetryService } from "../../../src/services/system/telemetry.js";

const logger = testLogger as unknown as Logger;

async function writeSkill(rootPath: string, name: string): Promise<string> {
  const dir = join(rootPath, name);
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, "SKILL.md"),
    [
      "---",
      `name: ${name}`,
      `description: Use ${name} in plugin skill tests.`,
      "---",
      "",
      `# ${name}`,
      "",
    ].join("\n"),
    "utf8",
  );
  return dir;
}

async function writePlugin(
  dir: string,
  options: {
    name: string;
    serverSource?: string;
    bbSkills?: string[];
    skillNames?: string[];
    skillsDirName?: string;
  },
): Promise<string> {
  const rootDir = join(dir, options.name);
  await mkdir(rootDir, { recursive: true });
  await writeFile(
    join(rootDir, "package.json"),
    JSON.stringify({
      name: options.name,
      version: "0.1.0",
      bb: {
        name: "Agent contributions fixture",
        description: "Agent contributions plugin fixture.",
        branding: { icon: "Zap" },
        server: "./server.ts",
        ...(options.bbSkills ? { skills: options.bbSkills } : {}),
      },
    }),
  );
  await writeFile(
    join(rootDir, "server.ts"),
    options.serverSource ?? "export default function plugin() {}",
  );
  for (const skillName of options.skillNames ?? []) {
    await writeSkill(
      join(rootDir, options.skillsDirName ?? "skills"),
      skillName,
    );
  }
  return rootDir;
}

describe("plugin skills tier", () => {
  let db: DbConnection;
  let workDir: string;
  let service: PluginService;

  beforeEach(async () => {
    db = createConnection(":memory:");
    migrate(db);
    workDir = await mkdtemp(join(tmpdir(), "bb-plugin-skills-test-"));
    service = createPluginService({
      aiServices: createAiServiceRegistry(),
      telemetry: createNoopTelemetryService(),
      db,
      hub: {
        getDaemonSessionIdForHost: () => null,
        notifyPluginSignal: () => 0,
        notifySystem: () => {},
      },
      logger,
      dataDir: join(workDir, "data"),
      appVersion: "0.9.0",
      loadTimeoutMs: 2000,
    });
  });

  afterEach(async () => {
    await service.stop();
    await rm(workDir, { recursive: true, force: true });
  });

  it("layers plugin skills below data-dir and project skills", async () => {
    const rootDir = await writePlugin(workDir, {
      name: "bb-plugin-skiller",
      skillNames: ["alpha", "beta", "gamma"],
    });
    await service.installPath(rootDir);

    const dataDir = join(workDir, "data");
    await writeSkill(join(dataDir, "skills"), "beta");
    const projectGamma = await writeSkill(
      join(workDir, "project-skills"),
      "gamma",
    );
    const projectGammaSource = resolveProjectSkillSourceFromContent(
      testLogger,
      {
        candidatePath: projectGamma,
        content: await readFile(join(projectGamma, "SKILL.md"), "utf8"),
        directoryName: "gamma",
      },
    );
    if (projectGammaSource === null) {
      throw new Error("Expected a project skill source");
    }

    const skillTreeRegistry = new SkillTreeRegistry();
    const entries = resolveSkillCatalogEntries(testLogger, {
      userSkillsRootPath: join(dataDir, "skills"),
      pluginSkillRoots: service.listSkillRootContributions(),
      projectSkillSources: [projectGammaSource],
      skillTreeRegistry,
    });
    const sources = entries.map((entry) => entry.runtimeSource);
    const byName = new Map(sources.map((source) => [source.name, source]));

    const alpha = byName.get("alpha");
    const beta = byName.get("beta");
    expect(alpha?.kind).toBe("tree");
    expect(beta?.kind).toBe("tree");
    if (alpha?.kind !== "tree" || beta?.kind !== "tree") {
      throw new Error("Expected server-owned tree sources");
    }
    expect(alpha.sourceType).toBe("data-dir");
    expect(
      entries.find((entry) => entry.runtimeSource.name === "alpha")?.provenance,
    ).toEqual({ kind: "plugin", pluginId: "skiller" });
    expect(beta.sourceType).toBe("data-dir");
    expect(byName.get("gamma")).toMatchObject({
      kind: "workspace-path",
      sourceRootPath: projectGamma,
    });
    expect(byName.get("gamma")?.sourceType).toBe("project");
    expect(sources).toHaveLength(byName.size);
  });

  it("manifest bb.skills relocates the convention root and the experiment gates the tier", async () => {
    const rootDir = await writePlugin(workDir, {
      name: "bb-plugin-relocated",
      bbSkills: ["./custom/*"],
      skillNames: ["relocated-skill"],
      skillsDirName: "custom",
    });
    await service.installPath(rootDir);

    expect(service.listSkillRootContributions()).toEqual([
      { pluginId: "relocated", rootPath: join(rootDir, "custom") },
    ]);
    const sources = resolveSkillCatalogEntries(testLogger, {
      userSkillsRootPath: join(join(workDir, "data"), "skills"),
      pluginSkillRoots: service.listSkillRootContributions(),
      skillTreeRegistry: new SkillTreeRegistry(),
    }).map((entry) => entry.runtimeSource);
    expect(sources.map((source) => source.name)).toEqual(["relocated-skill"]);
  });

  it("a skill added after install is discovered on the next resolve after reload", async () => {
    const rootDir = await writePlugin(workDir, {
      name: "bb-plugin-growing",
      skillNames: ["first-skill"],
    });
    await service.installPath(rootDir);

    const resolve = () =>
      resolveSkillCatalogEntries(testLogger, {
        userSkillsRootPath: join(join(workDir, "data"), "skills"),
        pluginSkillRoots: service.listSkillRootContributions(),
        skillTreeRegistry: new SkillTreeRegistry(),
      }).map((entry) => entry.runtimeSource.name);

    expect(resolve()).toEqual(["first-skill"]);
    await writeSkill(join(rootDir, "skills"), "second-skill");
    await service.reload("growing");
    expect(resolve()).toEqual(["first-skill", "second-skill"]);
  });
});

describe("plugin agent contributions reach thread runtime config", () => {
  let harness: TestAppHarness;
  let pluginsDir: string;

  beforeEach(async () => {
    harness = await createTestAppHarness();
    pluginsDir = await mkdtemp(join(tmpdir(), "bb-plugin-runtime-test-"));
  });

  it("isolates resolver failures and timeouts", async () => {
    const db = createConnection(":memory:");
    migrate(db);
    const service = createPluginService({
      aiServices: createAiServiceRegistry(),
      telemetry: createNoopTelemetryService(),
      db,
      hub: {
        getDaemonSessionIdForHost: () => null,
        notifyPluginSignal: () => 0,
        notifySystem: () => {},
      },
      logger,
      dataDir: join(pluginsDir, "timeout-data"),
      appVersion: "0.9.0",
      loadTimeoutMs: 2_000,
      providerEnvResolveTimeoutMs: 10,
    });
    try {
      const root = await writePlugin(pluginsDir, {
        name: "bb-plugin-env-failures",
        serverSource: `
          export default function plugin(bb) {
            bb.providers.experimental_contributeEnv("codex", () => {
              throw new Error("resolver exploded");
            });
            bb.providers.experimental_contributeEnv("claude-code", () => new Promise(() => {}));
          }
        `,
      });
      await service.installPath(root);
      const context = {
        threadId: "thread-timeout",
        projectId: "project-timeout",
        hostId: "host-timeout",
      };

      await expect(
        service.resolveProviderEnv({ providerId: "codex", context }),
      ).resolves.toEqual({ entries: [] });
      await expect(
        service.resolveProviderEnv({ providerId: "claude-code", context }),
      ).resolves.toEqual({ entries: [] });
    } finally {
      await service.stop();
    }
  });

  afterEach(async () => {
    await harness.pluginService.stop();
    await harness.cleanup();
    await rm(pluginsDir, { recursive: true, force: true });
  });

  it("plugin skills reach the thread.start command and update after reload", async () => {
    const rootDir = await writePlugin(pluginsDir, {
      name: "bb-plugin-ctxdemo",
      skillNames: ["ctx-skill"],
      serverSource: `
        export default function plugin() {}
      `,
    });
    const entry = await harness.pluginService.installPath(rootDir);
    expect(entry.status).toBe("running");

    const { host } = seedHostSession(harness.deps, {
      id: "host-plugin-agent-contributions",
    });
    const { project } = seedProjectWithSource(harness.deps, {
      hostId: host.id,
    });
    const environment = seedEnvironment(harness.deps, {
      hostId: host.id,
      projectId: project.id,
      path: join(harness.config.dataDir, "plugin-agent-workspace"),
    });
    const thread = seedThread(harness.deps, {
      projectId: project.id,
      environmentId: environment.id,
      providerId: "codex",
    });
    const execution = await buildExecutionOptions(
      harness.deps,
      { model: "gpt-5" },
      { threadId: thread.id },
    );
    const buildCommand = (requestValue: number) =>
      buildThreadStartCommand(harness.deps, {
        environment,
        execution,
        fork: null,
        permissionEscalation: "ask",
        input: textInput("hello"),
        projectId: project.id,
        providerId: "codex",
        requestId: encodeClientTurnRequestIdNumber({ value: requestValue }),
        syncGeneratedTitle: false,
        thread,
      });

    const command = await buildCommand(1);
    expect(command.injectedSkillSources).toContainEqual(
      expect.objectContaining({
        kind: "tree",
        name: "ctx-skill",
        entryPath: "SKILL.md",
      }),
    );
    await writeSkill(join(rootDir, "skills"), "late-skill");
    await harness.pluginService.reload("ctxdemo");
    const reloaded = await buildCommand(2);
    expect(
      reloaded.injectedSkillSources.map((source) => source.name),
    ).toContain("late-skill");
  });

  it("resolves provider environment per command and keeps the first plugin on conflicts", async () => {
    const firstRoot = await writePlugin(pluginsDir, {
      name: "bb-plugin-env-first",
      serverSource: `
        export default function plugin(bb) {
          bb.providers.experimental_contributeEnv("codex", (context) => [
            {
              name: "PLUGIN_CONTEXT",
              value: context.threadId + ":" + context.projectId + ":" + context.hostId,
              reason: "Expose resolution context",
            },
            {
              name: "SHARED_TOKEN",
              value: "first",
              reason: "First registration wins",
            },
          ]);
        }
      `,
    });
    const secondRoot = await writePlugin(pluginsDir, {
      name: "bb-plugin-env-second",
      serverSource: `
        export default function plugin(bb) {
          bb.providers.experimental_contributeEnv("codex", () => [
            {
              name: "SHARED_TOKEN",
              value: "second",
              reason: "Conflicting registration",
            },
            {
              name: "PLUGIN_PROXY_URL",
              value: { serverPath: "/plugins/env-second/proxy" },
              reason: "Use the server auth proxy",
            },
          ]);
        }
      `,
    });
    await harness.pluginService.installPath(firstRoot);
    setAppSettings(harness.db, { ...getAppSettings(harness.db), stripAiCoAuthorsEnabled: false });
    await harness.pluginService.installPath(secondRoot);

    const { host } = seedHostSession(harness.deps, {
      id: "host-provider-env",
    });
    const { project } = seedProjectWithSource(harness.deps, {
      hostId: host.id,
    });
    const environment = seedEnvironment(harness.deps, {
      hostId: host.id,
      projectId: project.id,
      path: join(harness.config.dataDir, "provider-env-workspace"),
    });
    const thread = seedThread(harness.deps, {
      projectId: project.id,
      environmentId: environment.id,
      providerId: "codex",
    });
    const execution = await buildExecutionOptions(
      harness.deps,
      { model: "gpt-5" },
      { threadId: thread.id },
    );
    const command = await buildThreadStartCommand(harness.deps, {
      environment,
      execution,
      fork: null,
      permissionEscalation: "ask",
      input: textInput("hello"),
      projectId: project.id,
      providerId: "codex",
      requestId: encodeClientTurnRequestIdNumber({ value: 3 }),
      syncGeneratedTitle: false,
      thread,
    });

    expect(command.contributedEnv).toEqual([
      {
        name: "PLUGIN_CONTEXT",
        value: `${thread.id}:${project.id}:${host.id}`,
        reason: "Expose resolution context",
        source: { plugin: "env-first" },
      },
      {
        name: "SHARED_TOKEN",
        value: "first",
        reason: "First registration wins",
        source: { plugin: "env-first" },
      },
      {
        name: "PLUGIN_PROXY_URL",
        value: { serverPath: "/plugins/env-second/proxy" },
        reason: "Use the server auth proxy",
        source: { plugin: "env-second" },
      },
    ]);
  });
  // A new thread's composer pick (plugins/accounts) rides its first message: state a dispatch hook writes is what the
  // first turn's environment reads, however slow the hook (the hook pass completes before the turn starts).
  it("applies what a dispatch hook wrote for a new thread to its first turn's environment", async () => {
    const root = await writePlugin(pluginsDir, {
      name: "bb-plugin-first-turn-pin",
      serverSource: `
        export default function plugin(bb) {
          const pins = new Map();
          bb.experimental_hooks.on("message.dispatch", async ({ experimental_submission, thread }) => {
            if (experimental_submission?.pluginId === bb.pluginId) {
              await new Promise((resolve) => setTimeout(resolve, 50));
              pins.set(thread.id, experimental_submission.data.id);
            }
            return { action: "proceed" };
          });
          bb.providers.experimental_contributeEnv("codex", (context) => [
            { name: "PINNED", value: pins.get(context.threadId) ?? "default", reason: "Pin" },
          ]);
        }
      `,
    });
    await harness.pluginService.installPath(root);
    setPluginHookProvider(harness.pluginService.hooks);
    try {
      const { host } = seedHostSession(harness.deps, { id: "host-first-turn-pin" });
      const { project } = seedProjectWithSource(harness.deps, { hostId: host.id });
      const thread = await createThreadFromRequest(harness.deps, {
        environment: {
          type: "host",
          hostId: host.id,
          workspace: { type: "unmanaged", path: join(harness.config.dataDir, "first-turn-pin") },
        },
        input: textInput("hello"),
        origin: "app",
        pluginSubmission: { pluginId: "first-turn-pin", data: { id: "b" } },
        projectId: project.id,
        providerId: "codex",
        startedOnBehalfOf: null,
      });
      await reportNextEnvironmentAttachSuccess(harness, thread.id);
      const start = await waitForQueuedCommand(
        harness,
        ({ command }) => command.type === "thread.start" && command.threadId === thread.id,
        5_000,
      );
      const env = (start.command as { contributedEnv?: { name: string; value: unknown }[] }).contributedEnv;
      expect(env?.find((entry) => entry.name === "PINNED")?.value).toBe("b");
    } finally {
      setPluginHookProvider(undefined);
    }
  });

  // Account plugins tie the login they hand out to the request a later turn.failed names (plugins/accounts).
  it("names the turn request a command carries, and for a steer the running turn's request", async () => {
    const root = await writePlugin(pluginsDir, {
      name: "bb-plugin-env-request",
      serverSource: `
        export default function plugin(bb) {
          bb.providers.experimental_contributeEnv("codex", (context) => [
            {
              name: "PLUGIN_REQUEST",
              value: String(context.requestId) + ":" + String(context.runningTurnRequestId),
              reason: "Expose the request",
            },
          ]);
        }
      `,
    });
    await harness.pluginService.installPath(root);
    const { host } = seedHostSession(harness.deps, { id: "host-provider-request" });
    const { project } = seedProjectWithSource(harness.deps, { hostId: host.id });
    const environment = seedEnvironment(harness.deps, {
      hostId: host.id,
      projectId: project.id,
      path: join(harness.config.dataDir, "provider-request-workspace"),
    });
    const thread = seedThread(harness.deps, {
      projectId: project.id,
      environmentId: environment.id,
      providerId: "codex",
    });
    const execution = await buildExecutionOptions(harness.deps, { model: "gpt-5" }, { threadId: thread.id });
    const named = (env: readonly { name: string; value: unknown }[]) =>
      env.find((entry) => entry.name === "PLUGIN_REQUEST")?.value;
    const started = encodeClientTurnRequestIdNumber({ value: 1 });
    const start = await buildThreadStartCommand(harness.deps, {
      environment,
      execution,
      fork: null,
      permissionEscalation: "ask",
      input: textInput("hello"),
      projectId: project.id,
      providerId: "codex",
      requestId: started,
      syncGeneratedTitle: false,
      thread,
    });
    expect(named(start.contributedEnv)).toBe(`${started}:undefined`);
    // The running turn accepted the first request.
    seedThreadRuntimeState(harness.deps, {
      environmentId: environment.id,
      providerThreadId: "provider-session",
      sequenceStart: 1,
      threadId: thread.id,
    });
    seedEvent(harness.deps, {
      threadId: thread.id,
      environmentId: environment.id,
      providerThreadId: "provider-session",
      sequence: 3,
      type: "turn/input/accepted",
      scope: { kind: "turn", turnId: "turn-1" },
      data: { providerThreadId: "provider-session", clientRequestId: started },
    });
    const submit = async (
      target: Parameters<typeof prepareTurnSubmitCommandPayload>[1]["target"],
      requestId?: number,
    ) =>
      named(
        (
          await prepareTurnSubmitCommandPayload(harness.deps, {
            environment,
            execution,
            input: textInput("more"),
            permissionEscalation: "ask",
            providerThreadId: "provider-session",
            target,
            thread,
            ...(requestId === undefined
              ? {}
              : { requestId: encodeClientTurnRequestIdNumber({ value: requestId }) }),
          })
        ).resumeContext.contributedEnv,
      );
    const next = (value: number) => encodeClientTurnRequestIdNumber({ value });
    expect(await submit({ mode: "start" }, 2)).toBe(`${next(2)}:undefined`);
    expect(await submit({ mode: "steer", expectedTurnId: "turn-1" }, 3)).toBe(`${next(3)}:${started}`);
    // An "auto" send aimed at the running turn (a child's report) joins it like a steer.
    expect(await submit({ mode: "auto", expectedTurnId: "turn-1" }, 5)).toBe(`${next(5)}:${started}`);
    // A turn that accepted nothing known, an "auto" send naming no turn, and a command with no request name none.
    expect(await submit({ mode: "steer", expectedTurnId: "turn-gone" }, 4)).toBe("undefined:undefined");
    expect(await submit({ mode: "auto", expectedTurnId: "turn-gone" }, 6)).toBe("undefined:undefined");
    expect(await submit({ mode: "auto", expectedTurnId: null }, 7)).toBe("undefined:undefined");
    expect(await submit({ mode: "start" })).toBe("undefined:undefined");
  });

  // Only the bundled accounts plugin, which no test can install, may name the Codex account.
  it("ignores a Codex account pin from any other plugin, and never passes the variable on", async () => {
    const root = await writePlugin(pluginsDir, {
      name: "bb-plugin-impostor",
      serverSource: `
        export default function plugin(bb) {
          bb.providers.experimental_contributeEnv("codex", () => [
            { name: "CLOUDROOM_CODEX_ACCOUNT", value: "b", reason: "Pin" },
          ]);
        }
      `,
    });
    await harness.pluginService.installPath(root);
    const pinned = vi.spyOn(CodexAccounts.prototype, "environment").mockResolvedValue([]);
    try {
      const { host } = seedHostSession(harness.deps, { id: "host-codex-pin" });
      const { project } = seedProjectWithSource(harness.deps, { hostId: host.id });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        path: join(harness.config.dataDir, "codex-pin-workspace"),
      });
      const thread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
        providerId: "codex",
      });
      const execution = await buildExecutionOptions(harness.deps, { model: "gpt-5" }, { threadId: thread.id });
      const command = await prepareTurnSubmitCommandPayload(harness.deps, {
        environment,
        execution,
        input: textInput("hello"),
        permissionEscalation: "ask",
        providerThreadId: "provider-session",
        target: { mode: "start" },
        thread,
      });
      expect(pinned).toHaveBeenCalledWith(undefined);
      expect(command.resumeContext.contributedEnv.map((entry) => entry.name)).not.toContain("CLOUDROOM_CODEX_ACCOUNT");
    } finally {
      pinned.mockRestore();
    }
  });
  // The events are built a tick later, when Teleport may have moved the thread and a newer request may have landed:
  // what ran is read when the turn ended.
  it("keeps a turn's request and target as they were when it ended", async () => {
    const root = await writePlugin(pluginsDir, {
      name: "bb-plugin-turn-snapshots",
      serverSource: `
        export default function plugin(bb) {
          globalThis.__turnSnapshots = [];
          for (const name of ["thread.idle", "turn.failed"])
            bb.events.on(name, (payload) => {
              globalThis.__turnSnapshots.push({
                name,
                requestId: payload.requestId ?? payload.experimental_requestId,
                target: payload.experimental_executionTarget,
              });
            });
        }
      `,
    });
    await harness.pluginService.installPath(root);
    const { host } = seedHostSession(harness.deps, { id: "host-turn-snapshots" });
    const { project } = seedProjectWithSource(harness.deps, { hostId: host.id });
    const environment = seedEnvironment(harness.deps, { hostId: host.id, projectId: project.id });
    const snapshots = () =>
      (globalThis as { __turnSnapshots?: unknown[] }).__turnSnapshots ?? [];
    const settled = () => new Promise((done) => setTimeout(done, 20));
    let next = 1;
    const turn = () => {
      const thread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
        status: "active",
      });
      const requestId = encodeClientTurnRequestIdNumber({ value: next });
      seedThreadRuntimeState(harness.deps, {
        environmentId: environment.id,
        providerThreadId: "provider-session",
        sequenceStart: next,
        threadId: thread.id,
      });
      next += 2;
      // A newer request, as a later send or retry appends one, before the event is built.
      const advance = () => {
        seedThreadRuntimeState(harness.deps, {
          environmentId: environment.id,
          providerThreadId: "provider-session",
          sequenceStart: next,
          threadId: thread.id,
        });
        next += 2;
      };
      const teleport = () =>
        harness.db.update(threads).set({ executionTarget: "cloud" }).where(eq(threads.id, thread.id)).run();
      const end = (type: "run.succeeded" | "run.failed") =>
        applyLoggedThreadLifecycleEvent(harness.deps, { event: { type }, threadId: thread.id });
      return { requestId, advance, teleport, end };
    };

    const idle = turn();
    idle.end("run.succeeded");
    idle.advance();
    await settled();
    expect(snapshots()).toEqual([{ name: "thread.idle", requestId: idle.requestId }]);

    // Moved to Cloud right after its Local failure: it still ran Local.
    const moved = turn();
    moved.end("run.failed");
    moved.teleport();
    await settled();
    expect(snapshots().at(-1)).toEqual({ name: "turn.failed", requestId: moved.requestId, target: "local" });

    // A newer request landed first: that work overtook the failure, which is not announced at all.
    const before = snapshots().length;
    const overtaken = turn();
    overtaken.end("run.failed");
    overtaken.advance();
    await settled();
    expect(snapshots()).toHaveLength(before);

    // A failure applied while the thread is in Cloud ran there.
    const cloud = turn();
    cloud.teleport();
    cloud.end("run.failed");
    await settled();
    expect(snapshots().at(-1)).toEqual({ name: "turn.failed", requestId: cloud.requestId, target: "cloud" });
  });
});
