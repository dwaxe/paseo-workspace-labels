import {
  enrollmentSchema,
  type Enrollment,
  type LabelSettings,
} from "../shared/contracts";

export function defaultAlias(cwd: string): string {
  const parts = cwd.replace(/\\/g, "/").split("/").filter(Boolean);
  return (
    (parts.at(-1) ?? "workspace")
      .replace(/[\u0000-\u001f\u007f]/g, "")
      .trim()
      .slice(0, 40) || "workspace"
  );
}

export type EnrollmentAction = "enable" | "save" | "pause";
export type EnrollmentDraft = Pick<
  Enrollment,
  "workspaceId" | "alias" | "mode"
> & {
  agentId?: string;
};

/** Only explicit enabling or resuming authorizes taking over a manual name. */
export function enrollmentForAction(
  base: Enrollment | undefined,
  draft: EnrollmentDraft,
  action: EnrollmentAction,
): Enrollment {
  if (action !== "enable" && !base) {
    throw new Error("Enable automatic naming before saving preferences.");
  }
  if (action === "pause") return { ...base!, enabled: false };
  return {
    workspaceId: draft.workspaceId,
    alias: draft.alias.trim(),
    mode: draft.mode,
    ...(draft.mode === "conversation" && draft.agentId
      ? { agentId: draft.agentId }
      : {}),
    enabled: action === "enable" ? true : base!.enabled,
    generation:
      action === "enable" ? (base?.generation ?? -1) + 1 : base!.generation,
  };
}

function sameEnrollment(
  left: Enrollment | undefined,
  right: Enrollment | undefined,
): boolean {
  if (!left || !right) return left === right;
  return (
    left.workspaceId === right.workspaceId &&
    left.alias === right.alias &&
    left.mode === right.mode &&
    left.agentId === right.agentId &&
    left.enabled === right.enabled &&
    left.generation === right.generation
  );
}

/** Merge only this workspace, refusing to overwrite a changed enrollment. */
export function mergeEnrollment(
  settings: LabelSettings,
  expected: Enrollment | undefined,
  desired: Enrollment,
): LabelSettings {
  const current = settings.workspaces.find(
    (entry) => entry.workspaceId === desired.workspaceId,
  );
  if (!sameEnrollment(current, expected)) {
    throw new Error(
      "Naming preferences changed elsewhere. Reload this workspace before saving.",
    );
  }
  const validated = enrollmentSchema.parse(desired);
  return {
    ...settings,
    workspaces: current
      ? settings.workspaces.map((entry) =>
          entry.workspaceId === desired.workspaceId ? validated : entry,
        )
      : [...settings.workspaces, validated],
  };
}
