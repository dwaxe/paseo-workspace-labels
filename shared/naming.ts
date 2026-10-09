import type { AgentView } from "./contracts";

export const MAX_TITLE_LENGTH = 120;

/** Keep metadata suitable for a one-line sidebar label. */
export function cleanText(value: string): string {
  return value
    .replace(/\s+/gu, " ")
    .replace(/[\p{Cc}\p{Cf}]/gu, "")
    .trim();
}

function withoutSuffix(title: string, suffix: string): string {
  while (title.endsWith(suffix)) title = title.slice(0, -suffix.length).trim();
  return title;
}

function truncate(value: string, length: number): string {
  if (value.length <= length) return value;
  let result = "";
  for (const character of value) {
    if (result.length + character.length > length - 1) break;
    result += character;
  }
  return `${result.trimEnd()}…`;
}

function withAlias(title: string, alias: string): string | null {
  const suffix = ` · ${cleanText(alias)}`;
  const text = withoutSuffix(cleanText(title), suffix);
  if (!text || suffix.length >= MAX_TITLE_LENGTH) return null;
  return `${truncate(text, MAX_TITLE_LENGTH - suffix.length)}${suffix}`;
}

export function conversationTitle(
  title: string | null,
  alias: string,
): string | null {
  if (!title) return null;
  const text = withoutSuffix(cleanText(title), ` · ${cleanText(alias)}`);
  if (
    !text ||
    /^(?:new (?:chat|conversation|agent)|untitled(?: (?:chat|conversation|agent))?|chat|conversation|agent|codex(?: agent)?|claude(?: code)?|loading[.…]*)$/iu.test(
      text,
    )
  ) {
    return null;
  }
  return withAlias(text, alias);
}

export function branchTitle(
  branch: string | null,
  alias: string,
): string | null {
  if (!branch) return null;
  let text = cleanText(branch).replace(/^refs\/heads\//u, "");
  // Git branches commonly use an owner or a category before their task slug.
  text = text.replace(/^[^/]+\//u, "");
  text = text
    .replace(
      /\b([a-z][a-z0-9]*)-(\d+)\b/giu,
      (_, prefix: string, number: string) =>
        `${prefix.toUpperCase()}\u0000${number}`,
    )
    .replace(/[-_/]+/gu, " ")
    .replace(/\u0000/gu, "-");
  return withAlias(text, alias);
}

/** Select the current root conversation, even if its title is not ready yet. */
export function selectConversation(
  agents: AgentView[],
  workspaceId: string,
  pinnedAgentId?: string,
): AgentView | null {
  const eligible = agents.filter(
    (agent) =>
      agent.workspaceId === workspaceId &&
      !agent.archived &&
      !agent.closed &&
      !agent.internal &&
      agent.parentAgentId === null &&
      (!pinnedAgentId || agent.id === pinnedAgentId),
  );
  if (
    eligible.some((agent) => !Number.isFinite(Date.parse(agent.createdAt))) ||
    new Set(eligible.map((agent) => agent.id)).size !== eligible.length
  ) {
    throw new Error(
      "Conversation metadata is invalid; naming is paused for this run.",
    );
  }
  eligible.sort((left, right) => {
    const byCreated = Date.parse(right.createdAt) - Date.parse(left.createdAt);
    if (byCreated) return byCreated;
    return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
  });
  return eligible[0] ?? null;
}
