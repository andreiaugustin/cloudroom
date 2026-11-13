// @vitest-environment jsdom

import { renderHook } from "@testing-library/react";
import type { JsonValue } from "@get-bb/plugin-sdk";
import { expect, it, vi } from "vitest";
import {
  submittedPluginData,
  useDraftPreservingOptionChange,
} from "./NewThreadComposer";

it("records an effort click that matches the shown default, without a draft snapshot (#656)", () => {
  const [setValue, snapshot] = [vi.fn(), vi.fn()];
  const { result } = renderHook(() =>
    useDraftPreservingOptionChange<string>("high", setValue, snapshot, true),
  );
  result.current("high");
  expect(setValue).toHaveBeenCalledExactlyOnceWith("high");
  expect(snapshot).not.toHaveBeenCalled();
});

it("sends the first plugin data held for ordinary sends, never to Cloud, and a plugin's own submit instead", () => {
  const held = new Map<string, JsonValue>([
    ["accounts", { provider: "claude-code", id: "b" }],
    ["other", 1],
  ]);
  expect(submittedPluginData(undefined, held, "local")).toEqual({
    pluginId: "accounts",
    data: { provider: "claude-code", id: "b" },
  });
  expect(submittedPluginData(undefined, held, "cloud")).toBeUndefined();
  expect(submittedPluginData(undefined, new Map(), "local")).toBeUndefined();
  const own = { pluginId: "drafts", data: { kind: "draft" } };
  expect(submittedPluginData(own, held, "local")).toBe(own);
});
