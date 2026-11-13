import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

export const providerSchema = z.enum(["claude-code", "codex", "acp-cursor"]);
export type Provider = z.infer<typeof providerSchema>;
export const MAX_ACCOUNTS = 10;
export const LOCAL = "local";
export const ACCOUNTS_CHANGED = "accounts-changed";
// A Local Codex thread pinned to an account names it here; the app swaps it for that account's sign-in.
// Keep in sync with apps/server/src/services/threads/thread-runtime-config.ts.
export const CODEX_ACCOUNT_ENV = "CLOUDROOM_CODEX_ACCOUNT";

export const usageWindowSchema = z.object({
  label: z.string(),
  usedPercent: z.number(),
  resetsAt: z.number().nullable(),
  // The model family ("fable") a row is for. Missing: the limit covers every model.
  model: z.string().nullish(),
});
export type UsageWindow = z.infer<typeof usageWindowSchema>;

export const accountViewSchema = z.object({
  id: z.string(),
  name: z.string().nullable(),
  email: z.string().nullable(),
  plan: z.string().nullable(),
  inUse: z.boolean(),
  limitedUntil: z.number().nullable(),
  error: z.string().nullable(),
  credits: z.object({ detail: z.string().nullable() }).nullable(),
  windows: z.array(usageWindowSchema),
  // The Mac's own Claude login while Cloud is on another account: Use first asks for one approval for Cloud.
  needsSignIn: z.boolean(),
  // A Claude account added before full logins: it runs on its one-year token, without claude.ai connectors.
  limitedLogin: z.boolean(),
});
export type AccountView = z.infer<typeof accountViewSchema>;

export const threadAccountsSchema = z.object({
  provider: providerSchema,
  accounts: z.array(z.object({ id: z.string(), label: z.string() })),
  // The default every unpinned thread uses.
  default: z.string(),
  thread: z.string().nullable(),
  project: z.string().nullable(),
  // Cloud threads use the default account: Cloud keeps one login per agent (ADR 0197).
  cloud: z.boolean(),
});
export type ThreadAccounts = z.infer<typeof threadAccountsSchema>;

// A new thread's own pick, sent with its first message (useComposer().experimental_setSubmissionData). The
// message.dispatch hook pins it before that message's turn starts.
export const pendingPinSchema = z.object({ provider: providerSchema, id: z.string().min(1) });

const target = z.object({ provider: providerSchema, id: z.string().min(1) });
const ok = z.null();
const poll = z.object({ sessionId: z.string() });
const polled = z.object({
  status: z.enum(["pending", "complete", "error"]),
  message: z.string().nullable(),
  // Claude's second sign-in, for the one-year token Cloud uses.
  authorizeUrl: z.string().nullish(),
});

export const accountsRpcContract = defineRpcContract({
  "accounts.list": {
    input: z.object({ provider: providerSchema }),
    output: z.array(accountViewSchema),
  },
  "accounts.use": {
    // `cloud` waits until Cloud is on the account too, and fails if it isn't. `threadId` is the thread it was picked
    // from, at its plan limit: it continues with every other thread that limit stopped (ADR 20261107-082836).
    input: target.extend({
      cloud: z.boolean().optional(),
      threadId: z.string().min(1).optional(),
    }),
    output: ok,
  },
  "accounts.move": {
    input: target.extend({ direction: z.enum(["up", "down"]) }),
    output: ok,
  },
  "accounts.remove": { input: target, output: ok },
  // Disconnect in Settings → Agents → Harness removes every added account first (ADR 0327).
  "accounts.clear": { input: z.object({ provider: providerSchema }), output: ok },
  "accounts.rename": {
    input: target.extend({ name: z.string().max(60) }),
    output: ok,
  },
  // `mac` only approves the Mac's own login for Cloud (one-year token); `id` signs an added account in again.
  "claude.start": {
    input: z
      .object({ mac: z.boolean().optional(), id: z.string().optional() })
      .nullable(),
    output: z.object({ sessionId: z.string(), authorizeUrl: z.string() }),
  },
  "codex.start": {
    input: z.null(),
    output: z.object({
      sessionId: z.string(),
      verificationUri: z.string(),
      userCode: z.string(),
      expiresAt: z.number(),
    }),
  },
  // Cursor accounts are added with a user API key from cursor.com/dashboard.
  "cursor.add": { input: z.object({ apiKey: z.string().max(4096) }), output: ok },
  // The account a thread runs on: its own pick, else its project's, else the default (the top account). Null for an
  // agent without accounts here.
  "accounts.thread": {
    // A new thread's composer has no thread yet: it names the project and the agent picked.
    input: z.union([
      z.object({ threadId: z.string().min(1) }),
      z.object({ projectId: z.string().min(1), provider: providerSchema }),
    ]),
    output: threadAccountsSchema.nullable(),
  },
  // Pins the thread's agent to an account for this thread or its whole project; null follows the default again.
  "accounts.pin": {
    input: z.union([
      z.object({
        threadId: z.string().min(1),
        scope: z.enum(["thread", "project"]),
        id: z.string().min(1).nullable(),
      }),
      // From a new thread's composer: only the project pin, the thread's own pick goes with its first message.
      z.object({
        projectId: z.string().min(1),
        provider: providerSchema,
        scope: z.literal("project"),
        id: z.string().min(1).nullable(),
      }),
    ]),
    output: ok,
  },
  "claude.poll": { input: poll, output: polled },
  "codex.poll": { input: poll, output: polled },
});
