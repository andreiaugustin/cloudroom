import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { CodexAccounts } from "../../src/services/cloudroom/codex-accounts.js";

it("uses pinned Codex credentials without changing the default and falls back after removal", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "codex-pins-"));
  const fetchUsage = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response("{}"));
  let selected = "a";
  let ids = ["a", "b"];
  const accounts = new CodexAccounts(
    async () => ({
      selected,
      accounts: ids.map((id) => ({
        id, name: id, email: `${id}@example.invalid`, plan: null,
        accountId: `account-${id}`, error: null, accessToken: `token-${id}`, expiresAt: null,
      })),
    }),
    async () => "user",
    path.join(dir, "accounts.json"),
    () => {},
  );
  const token = async (pin?: string) =>
    (await accounts.environment(pin)).find((entry) => entry.name === "CLOUDROOM_CODEX_ACCESS_TOKEN")?.value;
  try {
    expect(await token()).toBe("token-a");
    expect(await token("b")).toBe("token-b");
    expect(await token()).toBe("token-a");
    expect(await accounts.environment("local")).toEqual([]);
    selected = "b";
    // Mutation refreshes the same cache used by environment().
    await accounts.request({ action: "rename", id: "b", name: "B" });
    expect(await token("a")).toBe("token-a");
    expect(await token()).toBe("token-b");
    ids = ["b"];
    await accounts.request({ action: "remove", id: "a" });
    expect(await token("a")).toBe("token-b");
  } finally {
    fetchUsage.mockRestore();
    await rm(dir, { recursive: true, force: true });
  }
});

it("refreshes the website's list when the pinned account's token is close to expiry", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "codex-pins-"));
  const fetchUsage = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response("{}"));
  const year = Date.now() + 365 * 86_400_000;
  let pinnedExpiry = Date.now() + 60_000;
  let lists = 0;
  const accounts = new CodexAccounts(
    async () => {
      lists++;
      return {
        selected: "a",
        accounts: [
          { id: "a", name: "a", email: null, plan: null, accountId: "account-a", error: null, accessToken: "token-a", expiresAt: year },
          { id: "b", name: "b", email: null, plan: null, accountId: "account-b", error: null, accessToken: `token-b-${lists}`, expiresAt: pinnedExpiry },
        ],
      };
    },
    async () => "user",
    path.join(dir, "accounts.json"),
    () => {},
  );
  const token = async (pin?: string) =>
    (await accounts.environment(pin)).find((entry) => entry.name === "CLOUDROOM_CODEX_ACCESS_TOKEN")?.value;
  try {
    expect(await token()).toBe("token-a");
    expect(lists).toBe(1);
    // The selected token is fresh, so only the pin's expiry asks for a new list.
    pinnedExpiry = year;
    expect(await token("b")).toBe("token-b-2");
    expect(lists).toBe(2);
    expect(await token("b")).toBe("token-b-2");
    expect(lists).toBe(2);
  } finally {
    fetchUsage.mockRestore();
    await rm(dir, { recursive: true, force: true });
  }
});
