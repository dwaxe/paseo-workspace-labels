import { describe, expect, it } from "vitest";
import type { Enrollment } from "../shared/contracts";
import {
  defaultAlias,
  enrollmentForAction,
  mergeEnrollment,
} from "./enrollment";

function enrollment(workspaceId: string, alias = workspaceId): Enrollment {
  return {
    workspaceId,
    alias,
    mode: "conversation",
    enabled: true,
    generation: 0,
  };
}

describe("checkout label defaults", () => {
  it("uses the existing directory name on Unix and Windows", () => {
    expect(defaultAlias("/home/user/project/alpha/")).toBe("alpha");
    expect(defaultAlias("C:\\projects\\beta\\")).toBe("beta");
  });

  it("produces a valid label for empty and unusually long paths", () => {
    expect(defaultAlias("/")).toBe("workspace");
    expect(defaultAlias(`/tmp/${"a".repeat(80)}`)).toHaveLength(40);
    expect(defaultAlias("/tmp/\u0001\u007f")).toBe("workspace");
  });
});

describe("workspace enrollment changes", () => {
  it("preserves other workspaces and leaves the input document unchanged", () => {
    const first = enrollment("first");
    const other = enrollment("other", "renamed elsewhere");
    const original = { workspaces: [first, other] };
    const desired = { ...first, alias: "alpha", generation: 1 };
    const result = mergeEnrollment(original, first, desired);

    expect(result.workspaces).toEqual([desired, other]);
    expect(result.workspaces[1]).toBe(other);
    expect(original.workspaces).toEqual([first, other]);
    expect(result.workspaces).not.toBe(original.workspaces);
  });

  it("refuses to replace preferences that changed while a draft was open", () => {
    const before = enrollment("first");
    const current = { ...before, enabled: false };
    expect(() =>
      mergeEnrollment({ workspaces: [current] }, before, {
        ...before,
        alias: "alpha",
      }),
    ).toThrow("Naming preferences changed elsewhere");
  });

  it("refuses to recreate an enrollment removed while a draft was open", () => {
    const before = enrollment("first");
    expect(() => mergeEnrollment({ workspaces: [] }, before, before)).toThrow(
      "Naming preferences changed elsewhere",
    );
  });

  it("refuses to overwrite a concurrent first enrollment", () => {
    const current = enrollment("first");
    expect(() =>
      mergeEnrollment({ workspaces: [current] }, undefined, {
        ...current,
        alias: "alpha",
      }),
    ).toThrow("Naming preferences changed elsewhere");
  });

  it("enrolls one workspace without enabling any other workspace", () => {
    const existing = { ...enrollment("existing"), enabled: false };
    const added = enrollment("added");
    expect(
      mergeEnrollment({ workspaces: [existing] }, undefined, added).workspaces,
    ).toEqual([existing, added]);
  });

  it("validates checkout labels before saving", () => {
    for (const alias of ["", "\u200b", "\u200e \u200f"]) {
      expect(() =>
        mergeEnrollment(
          { workspaces: [] },
          undefined,
          enrollment("first", alias),
        ),
      ).toThrow();
    }
  });
});

describe("automatic naming actions", () => {
  it("keeps the current generation when saving changed naming preferences", () => {
    const base = { ...enrollment("first"), generation: 4 };
    const desired = enrollmentForAction(
      base,
      { workspaceId: "first", alias: "alpha", mode: "branch" },
      "save",
    );
    expect(desired).toEqual({
      ...base,
      alias: "alpha",
      mode: "branch",
      generation: 4,
    });
  });

  it("does not turn paused naming back on when saving preferences", () => {
    const base = { ...enrollment("first"), enabled: false, generation: 4 };
    const desired = enrollmentForAction(
      base,
      {
        workspaceId: "first",
        alias: "alpha",
        mode: "conversation",
        agentId: "source",
      },
      "save",
    );
    expect(desired.enabled).toBe(false);
    expect(desired.generation).toBe(4);
    expect(desired.agentId).toBe("source");
  });

  it("increments the generation only when explicitly resuming naming", () => {
    const base = { ...enrollment("first"), generation: 4 };
    const desired = enrollmentForAction(base, base, "enable");
    expect(desired.enabled).toBe(true);
    expect(desired.generation).toBe(5);
  });

  it("starts the first enrollment at generation zero", () => {
    expect(
      enrollmentForAction(
        undefined,
        { workspaceId: "first", alias: "alpha", mode: "conversation" },
        "enable",
      ),
    ).toEqual({
      workspaceId: "first",
      alias: "alpha",
      mode: "conversation",
      enabled: true,
      generation: 0,
    });
  });

  it("pauses without changing the generation or saving an unfinished draft", () => {
    const base = { ...enrollment("first"), generation: 4 };
    const desired = enrollmentForAction(
      base,
      { workspaceId: "first", alias: "unfinished", mode: "branch" },
      "pause",
    );
    expect(desired).toEqual({ ...base, enabled: false });
  });
});
