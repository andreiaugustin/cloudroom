import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { BbPluginApi, PluginTurnFailedEvent } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { COMPUTER_TITLE } from "@cloudroom/domain/computer-name";
import {
  ClaudeLogin,
  claudePlanName,
  claudeSecret,
  claudeUsage,
  localClaudeAccount,
  profileAccount,
  profileUsage,
  signOut,
  tokenOrganization,
  type MacClaude,
} from "./src/claude.js";
import {
  codexListSchema,
  codexPollSchema,
  codexStartSchema,
  localCodexEmail,
} from "./src/codex.js";
import {
  cursorAccount,
  cursorEnv,
  cursorSecretSchema,
  cursorUsage,
  isCursorKey,
  localCursorEmail,
} from "./src/cursor.js";
import {
  ACCOUNTS_CHANGED,
  CODEX_ACCOUNT_ENV,
  LOCAL,
  MAX_ACCOUNTS,
  accountsRpcContract,
  pendingPinSchema,
  providerSchema,
  usageWindowSchema,
  type AccountView,
  type Provider,
  type UsageWindow,
} from "./src/contract.js";
import { limitedThreads } from "./src/limited-threads.js";
import { prepareProfile, releaseProfile, startMcpSync } from "./src/profile.js";
import { SignInAgainError, type Secret, type SignedIn } from "./src/tokens.js";

const USAGE_EVERY_MS = 5 * 60_000;
// Accounts not in use are read every 12th check: hourly.
const IDLE_USAGE_TICKS = 12;
const MAC_NEEDS_CLOUD =
  "Approve this Mac's Claude account for Cloud first: click Use on it in Settings → Agents → Accounts.";
const DEFAULT_REST_MS = 60 * 60_000;

const storedSchema = z.object({
  id: z.string(),
  provider: providerSchema,
  name: z.string().nullish(),
  email: z.string().nullable(),
  plan: z.string().nullable(),
  // Claude's plan tier, such as `max_20x`: it names Max and Ultra apart. Missing: saved before tiers were read.
  tier: z.string().nullish(),
  accountKey: z.string().nullable(),
  // The account's own Claude folder with its full login (claude.ai connectors); older accounts have only the one-year token.
  profile: z.string().nullish(),
  org: z.string().nullish(),
  createdAt: z.number(),
});
type Stored = z.infer<typeof storedSchema>;
// Providers whose accounts this Mac stores, in the order the user set. Codex accounts live on the website (ADR 0195).
type Ordered = "claude-code" | "acp-cursor";
const secretSchema = z.object({
  accessToken: z.string(),
  refreshToken: z.string(),
  expiresAt: z.number().nullable(),
  idToken: z.string().optional(),
  issuedAt: z.number().optional(),
});
type Adding = {
  login: string;
  // Missing for the Mac's own login, which only needs Cloud's one-year token.
  profile?: string;
  replace: string | null;
  mac: boolean;
  account?: Awaited<ReturnType<typeof profileAccount>>;
  url?: string;
  busy?: boolean;
};
type Usage = {
  windows: UsageWindow[];
  credits: { detail: string | null } | null;
  error: string | null;
  signInAgain: boolean;
  at: number;
};

function blockedUntil(
  rateLimits: PluginTurnFailedEvent["rateLimits"],
): number | null {
  const windows = rateLimits?.windows ?? [];
  const blocked = windows.filter((window) => window.status === "blocked");
  const resets = (blocked.length > 0 ? blocked : windows).flatMap((window) =>
    window.resetsAtMs === null ? [] : [window.resetsAtMs],
  );
  return resets.length === 0 ? null : Math.max(...resets);
}

// What the usage bars show: each one's name, whole percent, and reset time to the minute.
const bars = (windows: UsageWindow[] = []) =>
  windows
    .map(
      (window) =>
        `${window.label}:${Math.round(window.usedPercent)}:${Math.round((window.resetsAt ?? 0) / 60_000)}`,
    )
    .join();

export default async function plugin(room: BbPluginApi) {
  const kv = room.storage.kv;
  const secretsDir = path.join(
    room.server.experimental_dataDir,
    "plugins",
    room.pluginId,
    "secrets",
  );
  await fs.mkdir(secretsDir, { recursive: true, mode: 0o700 });
  const secretPath = (id: string) => path.join(secretsDir, `${id}.json`);
  const profilesDir = path.join(path.dirname(secretsDir), "profiles");
  const profilePath = (profile: string) => path.join(profilesDir, profile);
  const dropProfile = async (profile: string) => {
    if (stillNamed("profile", profile)) return;
    try {
      await releaseProfile(profilePath(profile));
    } catch (error) {
      room.log.warn(
        `Claude account folder kept: ${error instanceof Error ? error.message : String(error)}`,
      );
      return;
    }
    await signOut(profilePath(profile));
    await fs.rm(profilePath(profile), { recursive: true, force: true });
  };
  // A record this build can't read (a newer build's, or damaged) stays stored, and every login stays, instead of all
  // accounts going at once.
  // A stored value that isn't a list is kept, unread, as one unreadable record.
  const raw: unknown = await kv.get("accounts:v1");
  const records = Array.isArray(raw) ? raw : [];
  let unreadable =
    raw === undefined || Array.isArray(raw)
      ? records.filter((entry) => !storedSchema.safeParse(entry).success)
      : [raw];
  let accounts = records.flatMap((entry) => storedSchema.safeParse(entry).data ?? []);
  // Every secret or profile folder deletion keeps one that a kept record (readable or not, any agent) still names.
  // Callers take the entry out of `accounts` or `unreadable` first.
  const stillNamed = (key: "id" | "profile", value: string) =>
    [...accounts, ...unreadable].some((entry) => Reflect.get(Object(entry), key) === value);
  const dropSecret = async (id: string) => {
    if (!stillNamed("id", id)) await fs.rm(secretPath(id), { force: true });
  };
  // Codex accounts moved to the website, which renews them for Local and Cloud threads (ADR 0195). The ones this Mac
  // kept sign in again (docs/scopes/multiple-subscriptions.md, decision 14). Not while a record is unreadable.
  const moved = accounts.filter((account) => account.provider === "codex");
  if (moved.length > 0 && unreadable.length === 0) {
    accounts = accounts.filter((account) => account.provider !== "codex");
    await Promise.all(moved.map((account) => dropSecret(account.id)));
    await kv.set("accounts:v1", [...accounts, ...unreadable]);
  }
  const order = z
    .object({
      "claude-code": z.array(z.string()),
      "acp-cursor": z.array(z.string()).default([LOCAL]),
    })
    .catch({ "claude-code": [LOCAL], "acp-cursor": [LOCAL] })
    .parse(await kv.get("order:v1"));
  const limits = z
    .record(z.string(), z.number())
    .catch({})
    .parse(await kv.get("limits:v1"));
  // Names given to "This Mac", one per login it has had, keyed "<agent> <login>". A login is its email, plus its
  // organization for Claude: another login never wears the old one's name. Added accounts keep theirs on their record.
  const localNames = z
    .record(z.string(), z.string())
    .catch({})
    .parse(await kv.get("local-names:v1"));
  const localName = (provider: Provider, login: string | null) =>
    login === null ? null : (localNames[`${provider} ${login}`] ?? null);
  const saveLocalNames = () => kv.set("local-names:v1", localNames);
  // Accounts pinned to one thread or a whole project, per agent: `pins.thread[threadId][provider]` is an account id.
  // A thread's pin beats its project's, and either beats the default (the top account). Local threads only.
  const pinsSchema = z.record(z.string(), z.record(z.string(), z.string())).catch({});
  const pins = z
    .object({ thread: pinsSchema, project: pinsSchema })
    .catch({ thread: {}, project: {} })
    .parse(await kv.get("pins:v1"));
  const savePins = () => kv.set("pins:v1", pins);
  // Drops this agent's pins to the accounts `gone` names; true when any went.
  const dropPins = (provider: Provider, gone: (id: string) => boolean) => {
    let dropped = false;
    for (const scope of [pins.thread, pins.project])
      for (const key of Object.keys(scope)) {
        const id = scope[key]?.[provider];
        if (id === undefined || !gone(id)) continue;
        dropped = true;
        delete scope[key]![provider];
        if (Object.keys(scope[key]!).length === 0) delete scope[key];
      }
    return dropped;
  };
  let inCloud = z.string().nullable().catch(null).parse(await kv.get("cloud:v1"));
  // The Mac's own Claude login, and the organization of the one-year token Cloud uses for it.
  let mac: MacClaude | null = (await localClaudeAccount()) ?? null;
  // Signing the Mac in or out can change the account in use; Cloud then follows it.
  const refreshMac = async () => {
    const read = await localClaudeAccount();
    if (read === undefined) return mac;
    const before = current("claude-code");
    mac = read;
    if (current("claude-code") !== before) void changed();
    return mac;
  };
  // The Mac login approved for Cloud: its identity (`~/.claude.json`) and plan. Its one-year token is secrets/local.json.
  const macCloudSchema = z.object({
    email: z.string(),
    org: z.string().nullable(),
    plan: z.string().nullable(),
  });
  let macCloud = macCloudSchema.nullable().catch(null).parse(await kv.get("mac-cloud:v1"));
  // `inCloud` is the account Cloud last confirmed. `cloudStale`: it has a newer token to upload.
  let cloudStale = z.boolean().catch(false).parse(await kv.get("cloud-stale:v1"));
  let cloudPending: string | null = null;
  let cloudQueue: Promise<unknown> = Promise.resolve();
  // Before Cursor accounts, Cloud used a copy of the Mac's own Cursor login.
  let cursorInCloud = z.string().catch(LOCAL).parse(await kv.get("cursor-cloud:v1"));
  // Every account's last bars are kept across restarts: an account not in use is rarely read again, and its reset
  // times stay true until they pass.
  const usage = new Map<string, Usage>(
    Object.entries(
      z
        .record(z.string(), z.array(usageWindowSchema).catch([]))
        .catch({})
        .parse(await kv.get("usage:v1")),
    ).map(([id, windows]) => [
      id,
      { windows, credits: null, error: null, signInAgain: false, at: 0 },
    ]),
  );
  // Background work never throws: outside a request, an unhandled error stops the whole server. Once this run is
  // disposed (a reload) its storage throws, so work still waiting on a read ends there.
  let disposed = false;
  room.onDispose(() => {
    disposed = true;
  });
  const background = (work: Promise<unknown>) =>
    void work.catch((error: unknown) => {
      if (!disposed)
        room.log.warn(
          `Accounts background work failed: ${error instanceof Error ? error.message : String(error)}`,
        );
    });
  const saveUsage = () =>
    kv.set(
      "usage:v1",
      Object.fromEntries(
        [...usage].flatMap(([id, { windows }]) =>
          stillNamed("id", id) ? [[id, windows]] : [],
        ),
      ),
    );
  // What each turn this computer launched ran on, by thread and request id (the ids `turn.failed` and `thread.idle`
  // name). Only a launch whose env this plugin handed out is known: `account` is the account its credentials came from,
  // `own` a machine's own login (another machine with no account here, #531), and neither an unknown login. `at` is
  // when it launched. Cloud turns and turns from before a restart have none. Never holds credentials.
  type Launch = { provider: Provider; account?: string; own: boolean; at: number };
  // Request ids are a thread's own: two threads may share one. The newest few hundred are plenty to outlast a turn.
  const launches = new Map<string, Launch>();
  const LAUNCHES_KEPT = 256;
  const launchKey = (threadId: string, requestId: string) => `${threadId}\n${requestId}`;
  // What each thread's provider runs on now: its latest launch, request id or not. A turn whose command carried none
  // (retries made inside a transaction, "auto" sends that name no running turn) ran on what it was handed, and one an "auto" send joined
  // keeps what it began on, so a limit on a request this plugin never saw is put here. Only a limit: a turn of unknown
  // start never clears one.
  const lastLaunch = new Map<string, Launch>();
  // A provider env resolution: a new turn notes its own launch. A steer (or an "auto" send aimed at the running turn)
  // asks for the env again, but the turn it joins keeps the login it began on, so its request is that turn's (#1300).
  const noteRequest = async (
    context: { threadId?: string; requestId?: string; runningTurnRequestId?: string },
    launch: Omit<Launch, "at">,
  ) => {
    const { threadId, requestId, runningTurnRequestId } = context;
    if (threadId === undefined) return;
    // A command with no request id that finds its thread running joins that turn, which keeps its login (#1300).
    if (requestId === undefined) {
      try {
        if ((await room.sdk.threads.get({ threadId })).status === "active") return;
      } catch {}
    }
    // A steer whose running request this plugin never saw (one an "auto" send joined without an id) still joins the
    // turn the thread last launched on this agent: it keeps that, and so does its own request. Unknown with neither.
    const latest = lastLaunch.get(threadId);
    const noted =
      runningTurnRequestId === undefined
        ? { ...launch, at: Date.now() }
        : (launches.get(launchKey(threadId, runningTurnRequestId)) ??
          (latest?.provider === launch.provider ? latest : undefined));
    if (!noted) return;
    lastLaunch.delete(threadId);
    lastLaunch.set(threadId, noted);
    for (const oldest of lastLaunch.keys()) {
      if (lastLaunch.size <= LAUNCHES_KEPT) break;
      lastLaunch.delete(oldest);
    }
    if (requestId === undefined) return;
    const key = launchKey(threadId, requestId);
    launches.delete(key);
    launches.set(key, noted);
    for (const oldest of launches.keys()) {
      if (launches.size <= LAUNCHES_KEPT) break;
      launches.delete(oldest);
    }
  };
  let thisComputer: Promise<string | null> | undefined;
  const onAnotherMachine = async (hostId: string | undefined) => {
    thisComputer ??= room.sdk.system.config().then(
      (config) => config.primaryHostId ?? null,
      () => null,
    );
    const id = await thisComputer;
    return !!hostId && id !== null && hostId !== id;
  };
  // When each limit was noted, since this start. It tells a limit that has lifted.
  const limitedAt = new Map<string, number>();
  const claudeLogin = new ClaudeLogin(path.dirname(secretsDir), () =>
    room.server.experimental_claudeSetupToken?.(),
  );
  const adding = new Map<string, Adding>();
  // An unreadable record may own any folder, so none is dropped then.
  if (unreadable.length === 0)
    void fs.readdir(profilesDir).then(
      (found) => Promise.all(found.map(dropProfile)),
      () => {},
    );
  let codexInUse = LOCAL;
  let codexAccounts = 0;
  // The account ids on the website's last list (none when signed out). Unset until the first list.
  let codexKnown: Set<string> | undefined;

  // `connect` marks the user adding, picking, or moving an account, which connects Claude again (ADR 0327).
  const changed = async (connect = false) => {
    await Promise.all([
      kv.set("accounts:v1", [...accounts, ...unreadable]),
      kv.set("order:v1", order),
      kv.set("limits:v1", limits),
    ]);
    room.realtime.publish(ACCOUNTS_CHANGED, {});
    return {
      cloud: followInCloud(connect),
      cursor: followCursorInCloud(),
      resumed: Promise.all([
        noteInUse("claude-code", current("claude-code")),
        noteInUse("acp-cursor", current("acp-cursor")),
      ]),
    };
  };
  // The Mac's Claude login shows unless it is signed out or already added as an account.
  const macShown = () => {
    const login = mac;
    return (
      login !== null &&
      !accounts.some(
        (entry) =>
          entry.provider === "claude-code" &&
          login.org !== null &&
          entry.org === login.org &&
          entry.email === login.email,
      )
    );
  };
  const ids = (provider: Ordered = "claude-code"): string[] => {
    const saved = accounts
      .filter((account) => account.provider === provider)
      .map((account) => account.id);
    const kept = order[provider].filter(
      (id) => id === LOCAL || saved.includes(id),
    );
    // A missing Mac login goes last, so its return never switches accounts.
    order[provider] = [
      ...kept,
      ...saved.filter((id) => !kept.includes(id)),
      ...(kept.includes(LOCAL) ? [] : [LOCAL]),
    ];
    // A hidden Mac login leaves the order, so it comes back last.
    if (provider === "claude-code" && saved.length > 0 && !macShown())
      order[provider] = order[provider].filter((id) => id !== LOCAL);
    return order[provider];
  };
  // The account Cloud runs this agent on: the one it last confirmed, and for Codex the website's selected account.
  const inCloudFor = (provider: Provider): string | undefined =>
    (provider === "claude-code"
      ? inCloud
      : provider === "acp-cursor"
        ? cursorInCloud
        : codexInUse) || undefined;
  // The top account is the one every thread uses (ADR 0197).
  const current = (provider: Provider): string =>
    provider === "codex" ? codexInUse : (ids(provider)[0] ?? LOCAL);
  // A pin to a removed account, or to a Mac login that is signed out or hidden (added as an account, so the picker
  // can't show it), falls back to the default. Codex accounts live on the website: each list drops pins to accounts it
  // no longer has (codexView).
  const usable = (provider: Provider, id: string) =>
    provider === "codex" ||
    (id === LOCAL
      ? provider !== "claude-code" || (mac !== null && ids(provider).includes(LOCAL))
      : accounts.some((entry) => entry.provider === provider && entry.id === id));
  const pinned = (provider: Provider, threadId?: string, projectId?: string) =>
    [
      threadId === undefined ? undefined : pins.thread[threadId]?.[provider],
      projectId === undefined ? undefined : pins.project[projectId]?.[provider],
    ].find((id): id is string => id !== undefined && usable(provider, id));
  // The account a Local thread's next turn runs on.
  const accountFor = (provider: Provider, threadId?: string, projectId?: string) =>
    pinned(provider, threadId, projectId) ?? current(provider);
  const limitedUntil = (provider: Provider, id: string): number | null => {
    const until = limits[`${provider}:${id}`];
    return until !== undefined && until > Date.now() ? until : null;
  };
  // Cloud keeps one Claude login (ADR 0197). The Mac's own login has no one-year token, so once Cloud is on
  // another account, picking the Mac's login needs one approval for Cloud first.
  const macCloudReady = () =>
    mac !== null && macCloud?.email === mac.email && macCloud.org === mac.org;
  // Cloud is on, or switching to, a login other than the approved Mac one. Null: Cloud keeps its own login.
  const macNeedsCloud = () => !macCloudReady() && (cloudPending ?? inCloud) !== null;
  // Until now the Mac's Claude login was hidden, never in use, once accounts existed. It now shows last, once.
  if (!(await kv.get("mac-login:v1"))) {
    ids();
    if (accounts.some((account) => account.provider === "claude-code"))
      order["claude-code"] = [
        ...order["claude-code"].filter((id) => id !== LOCAL),
        LOCAL,
      ];
    await kv.set("order:v1", order);
    await kv.set("mac-login:v1", true);
  }
  const views = (provider: Provider) =>
    provider === "codex"
      ? codexView()
      : provider === "acp-cursor"
        ? cursorView()
        : claudeView();
  const accountName = async (provider: Provider, id: string) => {
    const view = (await views(provider).catch(() => [])).find((entry) => entry.id === id);
    return (
      view?.name ??
      view?.email ??
      (id === LOCAL ? `This ${COMPUTER_TITLE}` : "another account")
    );
  };
  const limited = await limitedThreads(room, accountName);
  // Cloud gets the names too: Core's "keep working" after the switch then shows as the same one line.
  const cloudSwitch = async (
    provider: Provider,
    from: string | null,
    to: string,
  ) =>
    from && from !== to
      ? {
          from: await accountName(provider, from),
          to: await accountName(provider, to),
        }
      : null;
  // The account each agent's threads use. A new one, picked from any thread or Settings, continues every thread a plan
  // limit stopped on another account (ADR 20261107-082836). Codex learns its account from the website's list.
  const inUse: Partial<Record<Provider, string>> = {
    "claude-code": current("claude-code"),
    "acp-cursor": current("acp-cursor"),
  };
  // A thread a limit stopped that this plugin may continue: still here, Local (Core continues Cloud threads, ADR 0117),
  // and still on the agent whose limit stopped it.
  const waitingHere = async (
    provider: Provider,
    threadId: string,
    known?: Awaited<ReturnType<typeof room.sdk.threads.get>>,
  ) => {
    const thread =
      known?.id === threadId
        ? known
        : await room.sdk.threads.get({ threadId }).catch(() => null);
    return thread &&
      thread.executionTarget !== "cloud" &&
      thread.providerId === provider
      ? thread
      : null;
  };
  const noteInUse = async (provider: Provider, id: string) => {
    const before = inUse[provider];
    inUse[provider] = id;
    if (before === undefined || before === id) return;
    // A pinned Local thread keeps its account whatever the default becomes: it waits for the reset or a new pin.
    await limited.resumeEach(provider, async (threadId) => {
      const thread = await waitingHere(provider, threadId);
      return thread && pinned(provider, thread.id, thread.projectId) === undefined
        ? id
        : undefined;
    });
  };
  let codexResumed: Promise<void> = Promise.resolve();

  const writeSecret = async (
    id: string,
    secret: Secret | z.infer<typeof cursorSecretSchema>,
  ) => {
    const temp = `${secretPath(id)}.${randomUUID()}.tmp`;
    await fs.writeFile(temp, JSON.stringify(secret), { mode: 0o600 });
    await fs.rename(temp, secretPath(id));
  };
  const readSecret = async (id: string): Promise<Secret> =>
    secretSchema.parse(JSON.parse(await fs.readFile(secretPath(id), "utf8")));
  const readCursorKey = async (account: Stored): Promise<string> =>
    cursorSecretSchema.parse(
      JSON.parse(await fs.readFile(secretPath(account.id), "utf8")),
    ).apiKey;
  // Cloud keeps one Claude login per user, so it follows the account in use (ADR 0197).
  // Resolves to why Cloud is not on the account, or null.
  // Switches run one at a time.
  const followInCloud = (connect: boolean): Promise<string | null> => {
    const run = cloudQueue.then(() => followOnce(connect));
    cloudQueue = run.catch(() => null);
    return run;
  };
  const followOnce = async (connect: boolean): Promise<string | null> => {
    const id = current("claude-code");
    const account = accounts.find((entry) => entry.id === id);
    if (id === inCloud && !cloudStale) return null;
    if (!account && !(id === LOCAL && macCloudReady())) return null;
    const plan = account ? account.plan : macCloud?.plan;
    cloudPending = id;
    try {
      const secret = await readSecret(id);
      const switched = await cloudSwitch("claude-code", inCloud, id);
      const status = await room.sdk.cloudroom.claudeAuth({
        action: "token",
        requestId: randomUUID(),
        token: secret.accessToken,
        ...(plan ? { plan } : {}),
        follow: !connect,
        ...(switched ? { switched } : {}),
      });
      // A disconnected Claude skips background saves, so Cloud is still not on this account.
      if (status.state !== "connected")
        return "Claude isn't connected in Cloud.";
      inCloud = id;
      cloudStale = false;
      await kv.set("cloud:v1", id);
      await kv.set("cloud-stale:v1", false);
      return null;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      room.log.warn(`Cloud could not switch Claude accounts: ${message}`);
      return message;
    } finally {
      cloudPending = null;
    }
  };
  const markStale = async () => {
    cloudStale = true;
    await kv.set("cloud-stale:v1", true);
  };

  // Cloud keeps one Cursor login per user too: the account in use, or a copy of the Mac's own login.
  const followCursorInCloud = async (): Promise<string | null> => {
    const id = current("acp-cursor");
    if (id === cursorInCloud) return null;
    const account = accounts.find((entry) => entry.id === id);
    try {
      const switched = await cloudSwitch("acp-cursor", cursorInCloud, id);
      const status = await room.sdk.cloudroom.cursorAccount({
        requestId: randomUUID(),
        apiKey: account ? await readCursorKey(account) : null,
        ...(switched ? { switched } : {}),
      });
      if (status.state !== "connected") return "Cursor isn't connected in Cloud.";
      cursorInCloud = id;
      await kv.set("cursor-cloud:v1", id);
      return null;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      room.log.warn(`Cloud could not switch Cursor accounts: ${message}`);
      return message;
    }
  };

  // `idle` reads a Claude account that isn't in use: a failed read keeps its saved bars and shows no error. "free"
  // reads only when that uses no reply: with its full login, which lasts 8 hours after the account's last Local turn.
  const refreshUsage = async (
    account: Stored,
    force = false,
    idle?: "free" | "reply",
  ) => {
    const previous = usage.get(account.id);
    if (!force && previous && Date.now() - previous.at < USAGE_EVERY_MS) return;
    const before = previous?.error ?? null;
    // The read can take seconds: by then this run may be disposed, or the account removed.
    const gone = () => disposed || !accounts.includes(account);
    try {
      const read =
        idle === "free"
          ? account.profile
            ? await profileUsage(profilePath(account.profile))
            : null
          : account.provider === "acp-cursor"
            ? { windows: await cursorUsage(await readCursorKey(account)), credits: null }
            : await claudeUsage(
                await readSecret(account.id),
                account.profile ? profilePath(account.profile) : undefined,
                // Only bars read since this start: saved ones may be days old, and would hide a failed read.
                previous?.at && previous.windows.length ? previous : undefined,
              );
      if (!read || gone()) return;
      usage.set(account.id, { ...read, error: null, signInAgain: false, at: Date.now() });
    } catch (error) {
      if (idle || gone()) return;
      usage.set(account.id, {
        windows: previous?.windows ?? [],
        credits: previous?.credits ?? null,
        error: error instanceof Error ? error.message : String(error),
        signInAgain: error instanceof SignInAgainError,
        at: Date.now(),
      });
    }
    const measured = usage.get(account.id);
    if (JSON.stringify(measured?.windows) !== JSON.stringify(previous?.windows))
      await saveUsage();
    if (
      (measured?.error ?? null) !== before ||
      !measured?.credits !== !previous?.credits
    )
      await changed();
    // Open pages read again when a bar moved.
    else if (bars(measured?.windows) !== bars(previous?.windows))
      room.realtime.publish(ACCOUNTS_CHANGED, {});
  };
  // A Claude check is a real 1-token reply that can open a 5-hour window,
  // so only the account in use is checked in the background. Cursor's usage is a plain read.
  const refreshAll = (force = false) =>
    Promise.all(
      accounts
        .filter(
          (account) =>
            account.provider === "acp-cursor" ||
            account.id === current("claude-code"),
        )
        .map((account) => refreshUsage(account, force)),
    );
  // Claude accounts not in use get a free read at start and every hour, one at a time. An account with no bars saved
  // yet (added before they were kept, or its first check failed) gets one reply at start, so its row isn't empty.
  const refreshIdle = async (fill = false) => {
    for (const account of accounts) {
      if (disposed) return;
      if (
        account.provider !== "claude-code" ||
        account.id === current("claude-code") ||
        !accounts.includes(account)
      )
        continue;
      await refreshUsage(
        account,
        true,
        fill && !usage.get(account.id)?.windows.length ? "reply" : "free",
      );
    }
  };
  // A token Cloud hasn't confirmed yet is retried every few minutes, and at start.
  let ticks = 0;
  const timer = setInterval(() => {
    background(refreshAll());
    if (++ticks % IDLE_USAGE_TICKS === 0) background(refreshIdle());
    if (cloudStale) void followInCloud(false);
  }, USAGE_EVERY_MS);
  if (cloudStale) void followInCloud(false);
  timer.unref();
  room.onDispose(() => clearInterval(timer));
  background(refreshAll());
  background(refreshIdle(true));
  // Accounts saved before plan tiers were read learn theirs once, so Ultra shows as Ultra.
  void Promise.all(
    accounts
      .filter((entry) => entry.provider === "claude-code" && entry.profile && entry.tier === undefined)
      .map(async (entry) => {
        const found = await profileAccount(profilePath(entry.profile!)).catch(() => null);
        if (!found) return false;
        entry.tier = found.tier;
        return true;
      }),
  ).then((read) => (read.includes(true) ? changed() : undefined));

  // Adding never switches accounts: the one in use stays in use.
  const add = async (
    signedIn: SignedIn,
    login: Pick<Stored, "profile" | "org" | "tier">,
  ) => {
    if (
      accounts.filter((account) => account.provider === "claude-code").length >=
      MAX_ACCOUNTS
    )
      throw new Error(
        `You can connect up to ${MAX_ACCOUNTS} accounts per provider.`,
      );
    const account: Stored = {
      id: randomUUID(),
      provider: "claude-code",
      email: signedIn.email,
      plan: signedIn.plan,
      accountKey: signedIn.accountKey,
      ...login,
      createdAt: Date.now(),
    };
    await writeSecret(account.id, { ...signedIn.secret, issuedAt: Date.now() });
    const macInUse = current("claude-code") === LOCAL;
    accounts = [...accounts, account];
    // Adding the Mac's own account hides its tile: the copy keeps the selection.
    if (macInUse && !macShown()) move(account.id, 0);
    ids();
    await changed(true);
    background(refreshUsage(account, true));
  };

  // Listed in the order they were added, the machine's own login first, so picking an account never moves a row.
  // The saved order only says which account is in use: its first entry.
  const shown = (provider: Ordered): string[] => {
    const added = (id: string) =>
      accounts.find((entry) => entry.id === id)?.createdAt ?? 0;
    return [...ids(provider)].sort((a, b) => added(a) - added(b));
  };
  const rows = (
    provider: Ordered,
    localEmail: string | null,
    localLogin = localEmail,
  ): AccountView[] => {
    const using = current(provider);
    return shown(provider).map((id) => {
      const account = accounts.find((entry) => entry.id === id);
      const measured = usage.get(id);
      return {
        id,
        name: id === LOCAL ? localName(provider, localLogin) : (account?.name ?? null),
        email: id === LOCAL ? localEmail : (account?.email ?? null),
        plan:
          provider === "claude-code"
            ? (claudePlanName(account?.plan ?? null, account?.tier) ?? null)
            : (account?.plan ?? null),
        inUse: id === using,
        limitedUntil: limitedUntil(provider, id),
        error: measured?.error ?? null,
        credits: id === using ? (measured?.credits ?? null) : null,
        // Accounts not in use aren't checked, so a window past its reset shows empty.
        windows: (measured?.windows ?? []).map((window) =>
          window.resetsAt !== null && window.resetsAt <= Date.now()
            ? { ...window, usedPercent: 0, resetsAt: null }
            : window,
        ),
        needsSignIn: false,
        limitedLogin:
          provider === "claude-code" && account !== undefined && !account.profile,
      };
    });
  };
  const macLogin = () => (mac ? `${mac.email} ${mac.org ?? ""}` : null);
  const claudeView = async (): Promise<AccountView[]> => {
    await refreshMac();
    const needsCloud = macNeedsCloud();
    return rows("claude-code", mac?.email ?? null, macLogin()).map((row) =>
      row.id === LOCAL && needsCloud ? { ...row, needsSignIn: true } : row,
    );
  };
  // "This Mac" is the Mac's own Cursor login and stays selectable: Cloud then uses a copy of it, as before accounts.
  let cursorLocal: { email: string | null; at: number } | null = null;
  const cursorView = async (): Promise<AccountView[]> => {
    if (!cursorLocal || Date.now() - cursorLocal.at > USAGE_EVERY_MS)
      cursorLocal = { email: await localCursorEmail(), at: Date.now() };
    return rows("acp-cursor", cursorLocal.email);
  };
  // This computer's own login, read now, so a rename never names the login before it.
  const thisLogin = async (provider: Provider): Promise<string | null> => {
    if (provider === "codex") return localCodexEmail();
    if (provider === "claude-code") {
      await refreshMac();
      return macLogin();
    }
    cursorLocal = { email: await localCursorEmail(), at: Date.now() };
    return cursorLocal.email;
  };
  // "This Mac" Codex usage comes from the reader the usage card uses, on this Mac only. The list never waits for it:
  // it shows the last bars, and one background read at a time refreshes them at most every 5 minutes.
  let codexLocal: { at: number; windows: UsageWindow[] } = {
    at: 0,
    windows: [],
  };
  let codexLocalReading = false;
  const refreshCodexLocal = async () => {
    if (codexLocalReading || Date.now() - codexLocal.at < USAGE_EVERY_MS)
      return;
    codexLocalReading = true;
    try {
      const usage = (
        await room.sdk.system
          .usageLimits({ providerId: "codex" })
          .catch(() => null)
      )?.codex;
      const windows =
        usage?.status === "ok"
          ? usage.windows.map((window) => ({
              label:
                window.kind === "five-hour" ? "Five-hour limit" : window.label,
              usedPercent: window.usedPercent,
              resetsAt: Date.parse(window.resetsAt ?? "") || null,
            }))
          : // A failed read keeps the last bars; a signed-out Mac has none.
            !usage || usage.status === "error"
            ? codexLocal.windows
            : [];
      const changed =
        JSON.stringify(windows) !== JSON.stringify(codexLocal.windows);
      codexLocal = { at: Date.now(), windows };
      // Open lists read again; the fresh bars then come from the cache.
      if (changed) room.realtime.publish(ACCOUNTS_CHANGED, {});
    } finally {
      codexLocalReading = false;
    }
  };
  // Codex accounts live on the website (ADR 0195). "This Mac" is the Mac's own `~/.codex` login and stays selectable:
  // Cloud then uses the copy of it the app uploads, as before.
  const codexView = async (
    result?: unknown,
  ): Promise<AccountView[]> => {
    const list = codexListSchema.parse(
      result ?? (await room.sdk.cloudroom.codexAccounts({ action: "list" })),
    );
    const selected = list.accounts.find((account) => account.inUse);
    codexInUse = selected?.id ?? LOCAL;
    codexAccounts = list.accounts.length;
    codexKnown = new Set(list.accounts.map((account) => account.id));
    // Accounts removed on the website or another computer lose their pins here, on a signed-in list: a pin until then
    // stays (signed out lists none), and the app falls back to the selected account for an id it no longer has.
    const known = new Set(list.accounts.map((account) => account.id));
    if (list.signedIn && dropPins("codex", (id) => id !== LOCAL && !known.has(id)))
      await savePins();
    codexResumed = noteInUse("codex", codexInUse);
    background(refreshCodexLocal());
    const email = await localCodexEmail();
    return [
      {
        id: LOCAL,
        name: localName("codex", email),
        email,
        plan: null,
        inUse: !selected,
        limitedUntil: limitedUntil("codex", LOCAL),
        error: null,
        credits: null,
        windows: codexLocal.windows,
        needsSignIn: false,
        limitedLogin: false,
      },
      ...list.accounts.map((account) => ({
        ...account,
        limitedUntil: limitedUntil("codex", account.id),
        needsSignIn: false,
        limitedLogin: false,
      })),
    ];
  };
  const codex = async (
    input: Parameters<typeof room.sdk.cloudroom.codexAccounts>[0],
  ) => {
    const views = await codexView(await room.sdk.cloudroom.codexAccounts(input));
    room.realtime.publish(ACCOUNTS_CHANGED, {});
    return views;
  };
  const move = (id: string, to: number, provider: Ordered = "claude-code") => {
    const list = ids(provider).filter((entry) => entry !== id);
    list.splice(Math.max(0, Math.min(list.length, to)), 0, id);
    order[provider] = list;
  };
  const stored = (id: string) => {
    if (id === LOCAL)
      throw new Error("This machine's own login can't be changed here.");
    return id;
  };
  // Both sign-ins must be the same account: the full login runs Local threads, the one-year token runs Cloud.
  const save = async (state: Adding, token: string) => {
    const account = state.account!;
    if (!account.orgId || account.orgId !== (await tokenOrganization(token)))
      throw new Error(
        "Both sign-ins must use the same Claude account. Start again.",
      );
    const secret = { ...claudeSecret(token), issuedAt: Date.now() };
    const existing =
      accounts.find((entry) => entry.id === state.replace) ??
      accounts.find(
        (entry) =>
          entry.provider === "claude-code" &&
          entry.org === account.orgId &&
          entry.email === account.email,
      );
    if (!existing)
      return add(
        { email: account.email, plan: account.plan, accountKey: null, secret },
        { profile: state.profile, org: account.orgId, tier: account.tier },
      );
    // A revoked token can't name its account; anything else unconfirmed keeps the saved login.
    const before =
      existing.org ??
      (await readSecret(existing.id)
        .then((saved) => tokenOrganization(saved.accessToken))
        .catch((error: unknown) =>
          error instanceof SignInAgainError ? account.orgId : null,
        ));
    if (!before)
      throw new Error("Couldn't confirm this account. Try again.");
    if (
      before !== account.orgId ||
      (existing.org && existing.email !== account.email)
    )
      throw new Error(
        "That is a different Claude account. Sign in with this account's email.",
      );
    const old = existing.profile;
    await writeSecret(existing.id, secret);
    existing.email = account.email;
    existing.plan = account.plan ?? existing.plan;
    existing.tier = account.tier ?? existing.tier;
    existing.profile = state.profile;
    existing.org = account.orgId;
    if (old) void dropProfile(old);
    // Cloud gets the new token on its next follow, even after a restart.
    if (existing.id === inCloud) await markStale();
    await changed(true);
    background(refreshUsage(existing, true));
  };

  // One approval gives Cloud a one-year token for the Mac's own login, which then goes in use once Cloud has it.
  const saveMac = async (token: string) => {
    const login = await refreshMac();
    const status = await profileAccount().catch(() => null);
    if (!login || !status?.orgId || status.orgId !== (await tokenOrganization(token)))
      throw new Error(
        `Approve with ${login?.email ?? "the Claude account this Mac uses"}. Start again.`,
      );
    await writeSecret(LOCAL, { ...claudeSecret(token), issuedAt: Date.now() });
    macCloud = { email: login.email, org: login.org, plan: status.plan };
    await kv.set("mac-cloud:v1", macCloud);
    if (inCloud === LOCAL) await markStale();
    const before = [...order["claude-code"]];
    move(LOCAL, 0);
    const failed = await (await changed(true)).cloud;
    if (failed) {
      order["claude-code"] = before;
      await changed();
      throw new Error(`Cloud didn't switch accounts: ${failed}. Click Use to try again.`);
    }
  };

  // An account Cursor already knows (same user) keeps its place and gets the new key.
  const addCursor = async (apiKey: string) => {
    const key = apiKey.trim();
    if (!isCursorKey(key))
      throw new Error("Paste a Cursor API key from cursor.com/dashboard.");
    const found = await cursorAccount(key);
    const existing = accounts.find(
      (entry) =>
        entry.provider === "acp-cursor" &&
        found.accountKey !== null &&
        entry.accountKey === found.accountKey,
    );
    if (!existing && ids("acp-cursor").length > MAX_ACCOUNTS)
      throw new Error(
        `You can connect up to ${MAX_ACCOUNTS} accounts per provider.`,
      );
    const account: Stored = existing ?? {
      id: randomUUID(),
      provider: "acp-cursor",
      email: found.email,
      plan: found.plan,
      accountKey: found.accountKey,
      createdAt: Date.now(),
    };
    await writeSecret(account.id, { apiKey: key });
    account.email = found.email;
    account.plan = found.plan;
    if (!existing) accounts = [...accounts, account];
    // Cloud gets the new key on its next follow.
    if (account.id === cursorInCloud) cursorInCloud = "";
    await changed();
    background(refreshUsage(account, true));
  };

  const remove = async (provider: Provider, id: string) => {
    stored(id);
    delete limits[`${provider}:${id}`];
    if (provider === "codex") {
      await codex({ action: "remove", id });
      await kv.set("limits:v1", limits);
      dropPins(provider, (pin) => pin === id);
      await savePins();
      return;
    }
    const removed = accounts.find((account) => account.id === id);
    accounts = accounts.filter((account) => account.id !== id);
    dropPins(provider, (pin) => pin === id);
    await savePins();
    if (removed?.profile) void dropProfile(removed.profile);
    order[provider] = order[provider].filter((entry) => entry !== id);
    usage.delete(id);
    await dropSecret(id);
    await saveUsage();
    // Cloud can't follow the Mac's login without its approval, so the next added account goes in use.
    if (provider === "claude-code" && current(provider) === LOCAL && macNeedsCloud()) {
      const next = ids(provider).find((entry) => entry !== LOCAL);
      if (next) move(next, 0);
    }
    await changed();
  };

  const label = (view: AccountView) =>
    view.name ?? view.email ?? (view.id === LOCAL ? `This ${COMPUTER_TITLE}` : "Account");
  // Sets or clears (null) a pin. A thread a plan limit stopped continues at once on its new account.
  const pin = async (
    target: { threadId: string; projectId: string },
    provider: Provider,
    scope: "thread" | "project",
    id: string | null,
  ) => {
    const key = scope === "thread" ? target.threadId : target.projectId;
    const set = (pins[scope][key] ??= {});
    if (id === null) delete set[provider];
    else set[provider] = id;
    if (Object.keys(set).length === 0) delete pins[scope][key];
    await savePins();
    room.realtime.publish(ACCOUNTS_CHANGED, {});
    // Every Local thread the pin covers continues on the account it now names: the thread, or each one in the project.
    await limited.resumeEach(provider, async (waitingId) => {
      if (scope === "thread" && waitingId !== target.threadId) return undefined;
      const waiting = await waitingHere(provider, waitingId);
      return waiting && waiting.projectId === target.projectId
        ? accountFor(provider, waiting.id, waiting.projectId)
        : undefined;
    });
  };

  room.rpc.register(
    accountsRpcContract,
    {
      "accounts.list": ({ provider }) => views(provider),
      "accounts.use": async ({ provider, id, cloud, threadId }) => {
        const picked = threadId
          ? await room.sdk.threads.get({ threadId }).catch(() => null)
          : null;
        const local = picked !== null && picked.executionTarget !== "cloud";
        // A Local thread already on this account: nothing switches, and a limit noted on it stays.
        if (local && accountFor(provider, picked.id, picked.projectId) === id) return null;
        delete limits[`${provider}:${id}`];
        // Picked from a pinned thread: only that thread moves, and it stays on the account picked.
        if (local && pinned(provider, picked.id, picked.projectId) !== undefined) {
          if (limited.account(picked.id) === undefined)
            await limited.record(
              picked.id,
              provider,
              accountFor(provider, picked.id, picked.projectId),
            );
          await kv.set("limits:v1", limits);
          await pin({ threadId: picked.id, projectId: picked.projectId }, provider, "thread", id);
          return null;
        }
        // The thread it was picked from continues too: the user asked, even after a Stop or a limit this plugin
        // never noted.
        if (threadId)
          await limited.record(
            threadId,
            provider,
            limited.account(threadId) ?? current(provider),
          );
        if (provider === "codex") {
          inUse.codex ??= codexInUse;
          await codex({ action: "use", id: id === LOCAL ? null : id });
          await kv.set("limits:v1", limits);
          await codexResumed;
          return null;
        }
        if (provider === "claude-code" && id === LOCAL) {
          if (!(await refreshMac()))
            throw new Error(
              "Sign in to Claude Code on this Mac first: run `claude`.",
            );
          if (macNeedsCloud()) throw new Error(MAC_NEEDS_CLOUD);
        }
        // This Mac without a Cursor login would leave Cloud on the previous account.
        if (provider === "acp-cursor" && id === LOCAL) {
          cursorLocal = { email: await localCursorEmail(), at: Date.now() };
          if (!cursorLocal.email)
            throw new Error(
              "Sign in to Cursor on this Mac first: run `cursor-agent login`.",
            );
        }
        move(id, 0, provider);
        const follow = await changed(true);
        const following = provider === "acp-cursor" ? follow.cursor : follow.cloud;
        const account = accounts.find((entry) => entry.id === id);
        if (account) background(refreshUsage(account, true));
        await follow.resumed;
        const failed = cloud ? await following : null;
        if (failed) throw new Error(`Cloud didn't switch accounts: ${failed}`);
        return null;
      },
      "accounts.move": async ({ provider, id, direction }) => {
        if (provider === "codex") {
          await codex({ action: "move", id: stored(id), direction });
          return null;
        }
        const before = [...order[provider]];
        move(
          id,
          ids(provider).indexOf(id) + (direction === "up" ? -1 : 1),
          provider,
        );
        if (
          provider === "claude-code" &&
          current(provider) === LOCAL &&
          macNeedsCloud()
        ) {
          order[provider] = before;
          throw new Error(MAC_NEEDS_CLOUD);
        }
        await changed(true);
        return null;
      },
      "accounts.remove": async ({ provider, id }) => {
        const others = ids("claude-code").filter((entry) => entry !== id && entry !== LOCAL);
        if (
          provider === "claude-code" &&
          id === current(provider) &&
          others.length === 0 &&
          !macCloudReady() &&
          (cloudPending ?? inCloud) === id
        )
          throw new Error(
            "Cloud still runs on this account. Use your Mac's Claude login first (one approval), or Disconnect Claude Code.",
          );
        await remove(provider, id);
        return null;
      },
      "accounts.clear": async ({ provider }) => {
        // The account in use goes last, so Cloud never switches to another one on the way.
        const added = (await views(provider))
          .filter((view) => view.id !== LOCAL)
          .sort((a, b) => Number(a.inUse) - Number(b.inUse));
        for (const view of added) await remove(provider, view.id);
        // Disconnect also removes local records kept because startup couldn't read every record.
        const gone = [...accounts, ...unreadable].filter((entry) => Reflect.get(Object(entry), "provider") === provider);
        const named = (entry: unknown, key: string) => {
          const value: unknown = Reflect.get(Object(entry), key);
          return typeof value === "string" && /^[\w-]+$/.test(value) ? value : null;
        };
        accounts = accounts.filter((entry) => entry.provider !== provider);
        unreadable = unreadable.filter((entry) => !gone.includes(entry));
        for (const entry of gone) {
          const profile = named(entry, "profile");
          const id = named(entry, "id");
          if (profile) await dropProfile(profile);
          if (id && id !== LOCAL) await dropSecret(id);
        }
        if (gone.length > 0) await changed();
        for (const key of Object.keys(localNames))
          if (key.startsWith(`${provider} `)) delete localNames[key];
        await saveLocalNames();
        // Disconnect signs Claude out in Cloud too, so the Mac's Cloud token goes as well.
        if (provider === "claude-code") {
          macCloud = null;
          inCloud = null;
          cloudStale = false;
          await dropSecret(LOCAL);
          await kv.set("mac-cloud:v1", null);
          await kv.set("cloud:v1", null);
          await kv.set("cloud-stale:v1", false);
        }
        return null;
      },
      "accounts.rename": async ({ provider, id, name }) => {
        if (id === LOCAL) {
          const login = await thisLogin(provider);
          if (login === null) throw new Error("This login has no email to name.");
          const key = `${provider} ${login}`;
          if (name.trim()) localNames[key] = name.trim();
          else delete localNames[key];
          await saveLocalNames();
          room.realtime.publish(ACCOUNTS_CHANGED, {});
          return null;
        }
        if (provider === "codex") {
          await codex({ action: "rename", id: stored(id), name });
          return null;
        }
        const account = accounts.find((entry) => entry.id === id);
        if (!account) throw new Error("This account is no longer connected.");
        account.name = name.trim() || null;
        await changed();
        return null;
      },
      "accounts.thread": async (input) => {
        // A new thread's composer names its project and agent: there is no thread yet.
        const thread =
          "threadId" in input
            ? await room.sdk.threads.get({ threadId: input.threadId }).catch(() => null)
            : { id: null, projectId: input.projectId, providerId: input.provider, executionTarget: "local" };
        const provider = providerSchema.safeParse(thread?.providerId);
        if (!thread || !provider.success) return null;
        const list = await views(provider.data);
        const own = (id: string | undefined) =>
          id !== undefined && list.some((view) => view.id === id) ? id : null;
        return {
          provider: provider.data,
          accounts: list.map((view) => ({ id: view.id, label: label(view) })),
          default: current(provider.data),
          thread: thread.id === null ? null : own(pins.thread[thread.id]?.[provider.data]),
          project: own(pins.project[thread.projectId]?.[provider.data]),
          cloud: thread.executionTarget === "cloud",
        };
      },
      "accounts.pin": async (input) => {
        const target =
          "threadId" in input
            ? await room.sdk.threads.get({ threadId: input.threadId }).then((thread) => ({
                threadId: thread.id,
                projectId: thread.projectId,
                providerId: thread.providerId,
              }))
            : { threadId: "", projectId: input.projectId, providerId: input.provider };
        const provider = providerSchema.parse(target.providerId);
        if (input.id !== null && !(await views(provider)).some((view) => view.id === input.id))
          throw new Error("That account is gone. Pick another one.");
        await pin(target, provider, input.scope, input.id);
        return null;
      },
      "claude.start": async (input) => {
        // The Mac's own login already runs Local threads: Cloud only needs its one-year token.
        if (input?.mac) {
          if (!(await refreshMac()))
            throw new Error(
              "Sign in to Claude Code on this Mac first: run `claude`.",
            );
          const started = await claudeLogin.start();
          adding.set(started.sessionId, {
            login: started.sessionId,
            replace: null,
            mac: true,
          });
          return started;
        }
        const replace = input?.id ? stored(input.id) : null;
        const profile = randomUUID();
        try {
          await prepareProfile(profilePath(profile));
          const started = await claudeLogin.start(profilePath(profile));
          adding.set(started.sessionId, {
            login: started.sessionId,
            profile,
            replace,
            mac: false,
          });
          return started;
        } catch (error) {
          void dropProfile(profile);
          throw error;
        }
      },
      "claude.poll": async ({ sessionId }) => {
        const state = adding.get(sessionId);
        if (!state)
          return {
            status: "error" as const,
            message: "This sign-in expired. Start again.",
            authorizeUrl: null,
          };
        const pending = {
          status: "pending" as const,
          message: null,
          authorizeUrl: state.url ?? null,
        };
        if (state.busy) return pending;
        state.busy = true;
        try {
          const result = claudeLogin.poll(state.login);
          if (!result) return pending;
          if (state.mac) {
            adding.delete(sessionId);
            await saveMac(result);
            return { status: "complete" as const, message: null, authorizeUrl: null };
          }
          if (!state.account) {
            state.account = await profileAccount(profilePath(state.profile!));
            const next = await claudeLogin.start();
            state.login = next.sessionId;
            state.url = next.authorizeUrl;
            return { ...pending, authorizeUrl: next.authorizeUrl };
          }
          adding.delete(sessionId);
          await save(state, result);
          return { status: "complete" as const, message: null, authorizeUrl: null };
        } catch (error) {
          adding.delete(sessionId);
          if (state.profile) void dropProfile(state.profile);
          return {
            status: "error" as const,
            message: error instanceof Error ? error.message : String(error),
            authorizeUrl: null,
          };
        } finally {
          state.busy = false;
        }
      },
      "cursor.add": async ({ apiKey }) => {
        await addCursor(apiKey);
        return null;
      },
      "codex.start": async () =>
        codexStartSchema.parse(
          await room.sdk.cloudroom.codexAccounts({ action: "start" }),
        ),
      "codex.poll": async ({ sessionId }) => {
        const polled = codexPollSchema.parse(
          await room.sdk.cloudroom.codexAccounts({ action: "poll", sessionId }),
        );
        if (polled.status === "complete")
          room.realtime.publish(ACCOUNTS_CHANGED, {});
        return polled;
      },
    },
    {
      experimental_discoverable: true,
      experimental_description:
        "Several subscriptions per provider (Claude Code, Codex, Cursor). accounts.list returns one provider's accounts in order, with usage and which one is in use.",
    },
  );

  // A new thread's own pick ("This thread" in its composer) arrives with its first message. Pinned here, before that
  // message's turn starts, so the first turn already runs on it.
  room.experimental_hooks.on("message.dispatch", async ({ experimental_submission: submission, thread }) => {
    const pick =
      submission?.pluginId === room.pluginId ? pendingPinSchema.safeParse(submission.data).data : undefined;
    if (
      pick &&
      thread.providerId === pick.provider &&
      thread.executionTarget !== "cloud" &&
      usable(pick.provider, pick.id) &&
      pins.thread[thread.id]?.[pick.provider] !== pick.id
    )
      await pin({ threadId: thread.id, projectId: thread.projectId }, pick.provider, "thread", pick.id);
    return { action: "proceed" };
  });

  room.providers.experimental_contributeEnv(
    "claude-code",
    async (context: {
      threadId?: string;
      hostId?: string;
      projectId?: string;
      requestId?: string;
      runningTurnRequestId?: string;
    }) => {
      // Another machine runs on its own login unless it gets an account's one-year token below (#531).
      const remote = await onAnotherMachine(context.hostId);
      await refreshMac();
      const id = accountFor("claude-code", context.threadId, context.projectId);
      // Without an account's credentials, another machine runs on its own login and this one on an unknown one.
      const launched = (account?: string) =>
        noteRequest(context, {
          provider: "claude-code",
          own: account === undefined && remote,
          ...(account === undefined ? {} : { account }),
        });
      const account = accounts.find((entry) => entry.id === id);
      if (!account) {
        // This Mac's own login, while it has one.
        await launched(id === LOCAL && !remote && mac !== null ? LOCAL : undefined);
        return [];
      }
      const reason = `Cloudroom account ${account.email ?? account.id}`;
      if (account.profile) {
        // The account's folder exists only on this computer.
        if (remote) {
          await launched(undefined);
          return [];
        }
        await launched(id);
        const profile = profilePath(account.profile);
        await prepareProfile(profile).catch((error: unknown) =>
          room.log.warn(
            `Claude account folder not refreshed: ${error instanceof Error ? error.message : String(error)}`,
          ),
        );
        await startMcpSync(profile, (error: unknown) =>
          room.log.warn(
            `MCP sign-ins not copied to Claude account: ${error instanceof Error ? error.message : String(error)}`,
          ),
        );
        return [
          { name: "CLAUDE_CONFIG_DIR", value: profile, reason },
          { name: "CLAUDE_CODE_OAUTH_TOKEN", value: "", reason },
          { name: "CLAUDE_CODE_SUBSCRIPTION_TYPE", value: "", reason },
          { name: "CLAUDE_SECURESTORAGE_CONFIG_DIR", value: "", reason },
          { name: "ANTHROPIC_API_KEY", value: "", reason },
        ];
      }
      const secret = await readSecret(account.id).catch(() => null);
      // No token: the CLI falls back to whatever login its machine has.
      if (!secret) {
        await launched(undefined);
        return [];
      }
      await launched(id);
      return [
        { name: "CLAUDE_CODE_OAUTH_TOKEN", value: secret.accessToken, reason },
        { name: "ANTHROPIC_API_KEY", value: "", reason },
      ];
    },
  );

  room.providers.experimental_contributeEnv(
    "acp-cursor",
    async (context: {
      threadId?: string;
      hostId?: string;
      projectId?: string;
      requestId?: string;
      runningTurnRequestId?: string;
    }) => {
      const id = accountFor("acp-cursor", context.threadId, context.projectId);
      const account = accounts.find((entry) => entry.id === id);
      const key = account ? await readCursorKey(account).catch(() => null) : null;
      // An account's key runs anywhere. Without one the CLI runs on its machine's own Cursor login: this Mac's only
      // when no account was meant, and another machine's own otherwise.
      const remote = !key && (await onAnotherMachine(context.hostId));
      await noteRequest(context, {
        provider: "acp-cursor",
        own: remote,
        ...(key ? { account: id } : id === LOCAL && !remote ? { account: LOCAL } : {}),
      });
      if (!account || !key) return [];
      const reason = `Cloudroom account ${account.email ?? account.id}`;
      return Object.entries(cursorEnv(key)).map(([name, value]) => ({
        name,
        value,
        reason,
      }));
    },
  );

  room.events.on("turn.failed", async (event) => {
    if (event.errorInfo?.category !== "rate-limit") return;
    // Read before any wait: what the failed request ran on, whatever the thread has become since (Teleport, another
    // agent, another pin or default). Only a failure core says ran Local is one of this computer's launches: a Cloud
    // turn after Teleport can name the last Local request, since the handoff appends none. A request this plugin never
    // saw ran on what the thread was last handed (lastLaunch).
    const local = event.experimental_executionTarget === "local";
    const exact = local ? launches.get(launchKey(event.threadId, event.requestId)) : undefined;
    const latest = local ? lastLaunch.get(event.threadId) : undefined;
    const thread = await room.sdk.threads
      .get({ threadId: event.threadId })
      .catch(() => null);
    // The thread's latest launch stands in only while the thread is still on that agent: a turn of an agent this plugin
    // hands no env to (any other harness) notes nothing, so an older launch would put its limit on the wrong account.
    const launch = exact ?? (latest?.provider === thread?.providerId ? latest : undefined);
    const provider = providerSchema.safeParse(launch?.provider ?? thread?.providerId);
    if (!provider.success) return;
    // The machine's own login hit its limit: no account here is limited, and no switch here moves the thread.
    if (launch?.own) return;
    // A Cloud turn ran on the one login Cloud keeps for its agent. A Local one names an account only when this plugin
    // handed it out; a turn from before a restart ran on one it cannot prove, so no account is marked limited.
    const used =
      event.experimental_executionTarget === "cloud"
        ? inCloudFor(provider.data)
        : launch?.account;
    const several =
      provider.data === "codex"
        ? codexAccounts > 0
        : ids(provider.data).length > 1;
    if (used !== undefined && (used !== LOCAL || several)) {
      limits[`${provider.data}:${used}`] =
        blockedUntil(event.rateLimits) ?? Date.now() + DEFAULT_REST_MS;
      limitedAt.set(`${provider.data}:${used}`, Date.now());
      await changed();
      // A full login's usage read is free, so its bars show the limit right away instead of minutes later.
      const account = accounts.find((entry) => entry.id === used);
      if (account?.profile)
        background(
          refreshUsage(account, true).then(() =>
            room.realtime.publish(ACCOUNTS_CHANGED, {}),
          ),
        );
    }
    // Core continues Cloud threads on a new login (ADR 0117), even one back on this computer since; a thread now in
    // Cloud or on another agent is not this failure's to continue. A failure of unknown origin still waits for a pick.
    if (
      event.experimental_executionTarget === "cloud" ||
      !thread ||
      (await waitingHere(provider.data, thread.id, thread)) === null
    )
      return;
    // Noted even with one account, or pinned: adding and picking a second one, or a new pin, continues it too. A new
    // default never moves a pinned thread (noteInUse). An unknown account still waits for the user's next pick.
    const now = accountFor(provider.data, thread.id, thread.projectId);
    const ranOn = used ?? now;
    await limited.record(thread.id, provider.data, ranOn, event.requestId);
    // It ran on an account the user already switched or pinned away from: it continues on the new one at once.
    if (ranOn !== now && limitedUntil(provider.data, now) === null)
      await limited.resume(thread.id, now);
  });

  // A thread that runs again, or is gone, no longer waits for a switch.
  for (const name of [
    "thread.active",
    "thread.archived",
    "thread.deleted",
  ] as const)
    room.events.on(name, ({ thread }) => limited.forget(thread.id));
  room.events.on("thread.deleted", async ({ thread }) => {
    lastLaunch.delete(thread.id);
    if (!(thread.id in pins.thread)) return;
    delete pins.thread[thread.id];
    await savePins();
  });
  // Plugins hear of no project deletion: a pin to a project that is gone is dropped at start.
  background(
    (async () => {
      let dropped = false;
      for (const projectId of Object.keys(pins.project)) {
        const status = await room.sdk.projects
          .get({ projectId })
          .then(() => 200, (error: unknown) => Reflect.get(Object(error), "status"));
        if (status !== 404) continue;
        delete pins.project[projectId];
        dropped = true;
      }
      if (dropped) await savePins();
    })(),
  );

  // A turn that began after the limit and ended fine: the account it ran on works again, as after a limit reset from
  // Claude. A turn already running when the limit hit proves nothing, so it never clears it. Only a Local turn this
  // plugin launched, named by the request it ended on, clears one: a Cloud turn may name the last Local request.
  room.events.on("thread.idle", async ({ thread, experimental_requestId: requestId }) => {
    if (requestId === undefined || thread.executionTarget === "cloud") return;
    const launch = launches.get(launchKey(thread.id, requestId));
    const used = launch?.account;
    if (!launch || launch.own || used === undefined) return;
    const key = `${launch.provider}:${used}`;
    if (!(key in limits) || launch.at <= (limitedAt.get(key) ?? 0)) return;
    delete limits[key];
    limitedAt.delete(key);
    await kv.set("limits:v1", limits);
    room.realtime.publish(ACCOUNTS_CHANGED, {});
    // The bars read when the limit hit still say 100%, so a full login's are read again at once.
    const account = accounts.find((entry) => entry.id === used);
    if (account?.profile)
      background(
        refreshUsage(account, true).then(() =>
          room.realtime.publish(ACCOUNTS_CHANGED, {}),
        ),
      );
  });

  // Codex signs in from the app (codex-accounts.ts), which never hands its tokens here: a pinned thread only names
  // its account, and the app swaps that name for the account's sign-in.
  room.providers.experimental_contributeEnv(
    "codex",
    async (context: { threadId?: string; projectId?: string; requestId?: string; runningTurnRequestId?: string }) => {
      const pin = pinned("codex", context.threadId, context.projectId);
      // The app picks the sign-in: the pin while the account still exists, else its selected account (none, the Mac's
      // own login, when signed out). This plugin's copy of both is from the last list, which is as close as it gets.
      const runs =
        pin === undefined || (pin !== LOCAL && codexKnown !== undefined && !codexKnown.has(pin)) ? codexInUse : pin;
      await noteRequest(context, { provider: "codex", own: false, account: runs });
      return pin === undefined
        ? []
        : [{ name: CODEX_ACCOUNT_ENV, value: pin, reason: "Cloudroom Codex account pinned to this thread" }];
    },
  );
}
