import { describe, expect, it } from "vitest";
import type { AgentView } from "./contracts";
import {
  branchTitle,
  cleanText,
  conversationTitle,
  selectConversation,
} from "./naming";

function agent(overrides: Partial<AgentView> = {}): AgentView {
  return {
    id: "agent-a",
    workspaceId: "workspace",
    title: "Fix sidebar navigation",
    createdAt: "2026-01-02T00:00:00Z",
    parentAgentId: null,
    archived: false,
    closed: false,
    internal: false,
    ...overrides,
  };
}

describe("sidebar title formatting", () => {
  it("collapses whitespace and removes invisible controls", () => {
    expect(cleanText("  Fix\n sidebar\t\u0000navigation\u202e  ")).toBe(
      "Fix sidebar navigation",
    );
    expect(conversationTitle("  Fix\n navigation  ", "alpha")).toBe(
      "Fix navigation · alpha",
    );
  });

  it.each([
    null,
    "",
    "   ",
    "New chat",
    "Untitled conversation",
    "Codex",
    "Loading…",
  ])("waits for meaningful titles instead of using %s", (title) =>
    expect(conversationTitle(title, "alpha")).toBeNull(),
  );

  it("does not append a repeated checkout suffix", () => {
    expect(conversationTitle("Fix sidebar · alpha · alpha", "alpha")).toBe(
      "Fix sidebar · alpha",
    );
    expect(conversationTitle("New chat · alpha", "alpha")).toBeNull();
  });

  it("keeps aliases with invisible characters stable when reformatting", () => {
    const alias = "alpha \u200b beta";
    const title = conversationTitle("Fix sidebar", alias);
    expect(title).toBe("Fix sidebar · alpha beta");
    expect(conversationTitle(title, alias)).toBe(title);
  });

  it("bounds the complete title without breaking emoji or losing its suffix", () => {
    const formatted = conversationTitle("🚀".repeat(100), "alpha");
    expect(formatted?.length).toBeLessThanOrEqual(120);
    expect(formatted).toMatch(/… · alpha$/u);
    expect(formatted).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])/u);
  });

  it("formats generic branch slugs while retaining issue identifiers", () => {
    expect(branchTitle("owner/proj-123-improve-navigation", "alpha")).toBe(
      "PROJ-123 improve navigation · alpha",
    );
    expect(branchTitle("owner/proj-123_improve-navigation", "alpha")).toBe(
      "PROJ-123 improve navigation · alpha",
    );
    expect(branchTitle("refs/heads/feature/fix_network_setup", "beta")).toBe(
      "fix network setup · beta",
    );
    expect(branchTitle("main", "main")).toBe("main · main");
    expect(branchTitle(null, "beta")).toBeNull();
  });
});

describe("conversation selection", () => {
  it("uses the newest root rather than the most recently active old task", () => {
    const old = agent({ id: "old", createdAt: "2026-01-01T00:00:00Z" });
    const current = agent({ id: "current" });
    expect(selectConversation([old, current], "workspace")).toBe(current);
  });

  it("selects a newest untitled conversation without falling back", () => {
    const current = agent({ title: null });
    expect(
      selectConversation(
        [agent({ id: "old", createdAt: "2025-01-01T00:00:00Z" }), current],
        "workspace",
      ),
    ).toBe(current);
  });

  it("uses a deterministic ID tie-break", () => {
    expect(
      selectConversation([agent({ id: "z" }), agent({ id: "a" })], "workspace")
        ?.id,
    ).toBe("a");
  });

  it("excludes children, archived, closed, internal, and other-workspace agents", () => {
    const expected = agent({ id: "eligible" });
    expect(
      selectConversation(
        [
          agent({ id: "child", parentAgentId: "parent" }),
          agent({ id: "archived", archived: true }),
          agent({ id: "closed", closed: true }),
          agent({ id: "internal", internal: true }),
          agent({ id: "other", workspaceId: "other" }),
          expected,
        ],
        "workspace",
      ),
    ).toBe(expected);
  });

  it("honors a pinned conversation and waits when it becomes ineligible", () => {
    const pinned = agent({ id: "pinned", createdAt: "2025-01-01T00:00:00Z" });
    expect(selectConversation([pinned, agent()], "workspace", "pinned")).toBe(
      pinned,
    );
    expect(
      selectConversation(
        [agent({ ...pinned, archived: true }), agent()],
        "workspace",
        "pinned",
      ),
    ).toBeNull();
  });

  it("fails closed when ordering metadata is invalid", () => {
    expect(() =>
      selectConversation(
        [agent({ createdAt: "unknown" }), agent()],
        "workspace",
      ),
    ).toThrow("metadata is invalid");
    expect(() => selectConversation([agent(), agent()], "workspace")).toThrow(
      "metadata is invalid",
    );
  });
});
