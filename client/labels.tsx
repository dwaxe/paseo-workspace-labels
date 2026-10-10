import {
  useRpc,
  useSettings,
  useWorkspace,
  type PluginScreenProps,
  type PluginSurfaceProps,
  type PluginWorkspacePanelProps,
  type SettingsState,
} from "@getpaseo/plugin/client";
import type { RpcOutput } from "@getpaseo/plugin";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import {
  inspectLabelsRpc,
  labelSettings,
  type Enrollment,
  type LabelStatus,
} from "../shared/contracts";
import {
  defaultAlias,
  enrollmentForAction,
  mergeEnrollment,
  type EnrollmentAction,
} from "./enrollment";

type Theme = PluginSurfaceProps["theme"];
type ReadySettings = Extract<
  SettingsState<typeof labelSettings.schema>,
  { status: "ready" }
>;
type Workspace = {
  workspaceId: string;
  title: string | null;
  cwd: string | null;
};
type Conversation = RpcOutput<typeof inspectLabelsRpc>["agents"][number];

function createStyles(theme: Theme) {
  return StyleSheet.create({
    screen: { flex: 1, backgroundColor: theme.colors.surface0 },
    content: { padding: 16, gap: 16, width: "100%", maxWidth: 840 },
    title: { color: theme.colors.foreground, fontSize: 22, fontWeight: "600" },
    heading: {
      color: theme.colors.foreground,
      fontSize: 17,
      fontWeight: "600",
    },
    text: { color: theme.colors.foreground, fontSize: 14 },
    muted: { color: theme.colors.foregroundMuted, fontSize: 14 },
    error: { color: theme.colors.statusDanger, fontSize: 14 },
    label: { color: theme.colors.foreground, fontSize: 14, fontWeight: "500" },
    card: {
      padding: 16,
      gap: 14,
      borderWidth: 1,
      borderColor: theme.colors.border,
      borderRadius: 12,
      backgroundColor: theme.colors.surface1,
    },
    group: { gap: 8 },
    row: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
    input: {
      minHeight: 44,
      paddingHorizontal: 12,
      paddingVertical: 10,
      color: theme.colors.foreground,
      backgroundColor: theme.colors.surface0,
      borderColor: theme.colors.border,
      borderWidth: 1,
      borderRadius: 8,
      fontSize: 15,
    },
    button: {
      minHeight: 44,
      paddingHorizontal: 14,
      paddingVertical: 12,
      borderRadius: 8,
      borderWidth: 1,
      borderColor: theme.colors.border,
      backgroundColor: theme.colors.surface2,
      justifyContent: "center",
    },
    primary: {
      backgroundColor: theme.colors.accent,
      borderColor: theme.colors.accent,
    },
    primaryText: { color: theme.colors.accentForeground, fontWeight: "500" },
    selected: { borderColor: theme.colors.accent },
    disabled: { opacity: 0.5 },
    conversations: { maxHeight: 260 },
    conversationList: { gap: 8 },
  });
}

type Styles = ReturnType<typeof createStyles>;

function Button({
  label,
  onPress,
  styles,
  primary = false,
  selected,
  disabled = false,
}: {
  label: string;
  onPress(): void;
  styles: Styles;
  primary?: boolean;
  selected?: boolean;
  disabled?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole={selected === undefined ? "button" : "radio"}
      accessibilityLabel={label}
      accessibilityState={{ disabled, selected }}
      disabled={disabled}
      onPress={onPress}
      style={[
        styles.button,
        primary && styles.primary,
        selected && styles.selected,
        disabled && styles.disabled,
      ]}
    >
      <Text style={primary ? styles.primaryText : styles.text}>{label}</Text>
    </Pressable>
  );
}

function initialDraft(enrollment: Enrollment | undefined, cwd: string | null) {
  return {
    base: enrollment,
    alias: enrollment?.alias ?? defaultAlias(cwd ?? ""),
    mode: enrollment?.mode ?? ("conversation" as const),
    agentId: enrollment?.agentId ?? "",
    dirty: false,
  };
}

function WorkspaceControls({
  workspace,
  conversations,
  status,
  settings,
  styles,
  theme,
  unavailable,
  conversationError,
  refresh,
}: {
  workspace: Workspace;
  conversations: Conversation[];
  status: LabelStatus | undefined;
  settings: ReadySettings;
  styles: Styles;
  theme: Theme;
  unavailable: boolean;
  conversationError: string | null;
  refresh(): void;
}) {
  const enrollment = settings.values.workspaces.find(
    (entry) => entry.workspaceId === workspace.workspaceId,
  );
  const [draft, setDraft] = useState(() =>
    initialDraft(enrollment, workspace.cwd),
  );
  const [error, setError] = useState<string | null>(null);
  const [choosingConversation, setChoosingConversation] = useState(false);
  const [reloadCount, setReloadCount] = useState(0);
  const resetDraft = useRef(false);
  const latestSettings = useRef(settings);
  latestSettings.current = settings;
  const enrollmentKey = JSON.stringify(enrollment ?? null);
  useEffect(() => {
    const forceReset = resetDraft.current;
    resetDraft.current = false;
    setDraft((current) =>
      current.dirty && !forceReset
        ? current
        : initialDraft(enrollment, workspace.cwd),
    );
    // Track changes to this enrollment, rather than other workspace saves.
  }, [enrollmentKey, workspace.cwd, reloadCount]);

  const busy = settings.saving || unavailable;
  const sourceUnavailable =
    unavailable || (draft.mode === "conversation" && !!conversationError);
  const enabled = enrollment?.enabled ?? false;
  const paused = enabled && status?.state === "paused";
  const source = conversations.find((agent) => agent.id === draft.agentId);
  const title =
    workspace.title ||
    (workspace.cwd ? defaultAlias(workspace.cwd) : workspace.workspaceId);

  const save = async (action: EnrollmentAction) => {
    setError(null);
    const current = latestSettings.current;
    if (current.saving || (sourceUnavailable && action !== "pause")) return;
    try {
      const desired = enrollmentForAction(
        draft.base,
        {
          workspaceId: workspace.workspaceId,
          alias: draft.alias,
          mode: draft.mode,
          agentId: draft.agentId,
        },
        action,
      );
      if (desired.alias.length === 0 || desired.alias.length > 40) {
        setError("Enter a checkout label between 1 and 40 characters.");
        return;
      }
      const next = mergeEnrollment(current.values, draft.base, desired);
      if (await current.save(next, current.revision)) {
        setDraft(initialDraft(desired, workspace.cwd));
        refresh();
      }
    } catch (failure) {
      setError(
        failure instanceof Error ? failure.message : "Could not save changes.",
      );
    }
  };

  const reload = async () => {
    setError(null);
    await settings.reload();
    // Read the reloaded settings on the next render, after the SDK's update.
    resetDraft.current = true;
    setReloadCount((count) => count + 1);
    refresh();
  };

  return (
    <View style={styles.card}>
      <View style={styles.group}>
        <Text style={styles.heading}>{title}</Text>
        <Text selectable style={styles.muted}>
          {workspace.cwd ?? workspace.workspaceId}
        </Text>
        <Text style={styles.muted}>
          {!enabled
            ? "Automatic naming is off."
            : (status?.message ?? "Automatic naming is enabled.")}
        </Text>
        {enabled && status?.preview ? (
          <Text style={styles.text}>Name: {status.preview}</Text>
        ) : null}
      </View>
      <View style={styles.group}>
        <Text style={styles.label}>Checkout label</Text>
        <TextInput
          accessibilityLabel={`Checkout label for ${title}`}
          value={draft.alias}
          onChangeText={(alias) =>
            setDraft((current) => ({ ...current, alias, dirty: true }))
          }
          editable={!busy}
          maxLength={40}
          autoCapitalize="none"
          autoCorrect={false}
          placeholder="alpha"
          placeholderTextColor={theme.colors.foregroundMuted}
          style={styles.input}
        />
        <Text style={styles.muted}>
          Added to the name, for example “DHCP fix · alpha”.
        </Text>
      </View>
      <View style={styles.group}>
        <Text style={styles.label}>Name from</Text>
        <View accessibilityRole="radiogroup" style={styles.row}>
          {(["conversation", "branch"] as const).map((mode) => (
            <Button
              key={mode}
              label={
                mode === "conversation" ? "Conversation title" : "Git branch"
              }
              selected={draft.mode === mode}
              styles={styles}
              disabled={busy}
              onPress={() =>
                setDraft((current) => ({ ...current, mode, dirty: true }))
              }
            />
          ))}
        </View>
      </View>
      {draft.mode === "conversation" ? (
        <View style={styles.group}>
          {conversationError ? (
            <Text accessibilityRole="alert" style={styles.error}>
              {conversationError}
            </Text>
          ) : null}
          <Text style={styles.muted}>
            {draft.agentId
              ? `Follow: ${source?.title || "Selected conversation"}`
              : "Follow the newest conversation in this workspace."}
          </Text>
          {draft.agentId && !source ? (
            <Text style={styles.error}>
              The selected conversation is unavailable.
            </Text>
          ) : null}
          <Button
            label={
              choosingConversation
                ? "Close conversation choices"
                : "Choose conversation"
            }
            styles={styles}
            disabled={busy || !!conversationError}
            onPress={() => setChoosingConversation((current) => !current)}
          />
          {choosingConversation ? (
            <ScrollView
              nestedScrollEnabled
              style={styles.conversations}
              contentContainerStyle={styles.conversationList}
            >
              {[
                { id: "", title: "Newest conversation automatically" },
                ...conversations,
              ].map((agent) => (
                <Button
                  key={agent.id}
                  label={agent.title || "Untitled conversation"}
                  selected={draft.agentId === agent.id}
                  styles={styles}
                  disabled={busy || !!conversationError}
                  onPress={() => {
                    setDraft((current) => ({
                      ...current,
                      agentId: agent.id,
                      dirty: true,
                    }));
                    setChoosingConversation(false);
                  }}
                />
              ))}
            </ScrollView>
          ) : null}
        </View>
      ) : (
        <Text style={styles.muted}>
          Follow the Git branch checked out in this directory.
        </Text>
      )}
      <View style={styles.row}>
        {!enabled || paused ? (
          <Button
            label={
              paused ? "Resume automatic naming" : "Enable automatic naming"
            }
            primary
            styles={styles}
            disabled={settings.saving || sourceUnavailable}
            onPress={() => void save("enable")}
          />
        ) : (
          <>
            {draft.dirty ? (
              <Button
                label="Save changes"
                primary
                styles={styles}
                disabled={settings.saving || sourceUnavailable}
                onPress={() => void save("save")}
              />
            ) : null}
            <Button
              label="Pause automatic naming"
              styles={styles}
              disabled={settings.saving}
              onPress={() => void save("pause")}
            />
          </>
        )}
        {draft.dirty || error || settings.saveError ? (
          <Button
            label="Reload preferences"
            styles={styles}
            disabled={settings.saving}
            onPress={() =>
              void reload().catch(() =>
                setError("Could not reload preferences."),
              )
            }
          />
        ) : null}
      </View>
      {error ? (
        <Text accessibilityRole="alert" style={styles.error}>
          {error}
        </Text>
      ) : null}
    </View>
  );
}

function LabelsView({
  theme,
  host,
  layout,
  workspaceId,
  liveWorkspace,
}: PluginSurfaceProps & {
  workspaceId?: string;
  liveWorkspace?: Workspace | null;
}) {
  const settings = useSettings(labelSettings);
  const inspect = useRpc(inspectLabelsRpc);
  const snapshot = useQuery({
    queryKey: ["paseo-workspace-labels", host.id],
    queryFn: () => inspect({}),
    refetchInterval: 5000,
    retry: false,
  });
  const styles = useMemo(() => createStyles(theme), [theme]);
  const refresh = () => void snapshot.refetch();
  const workspaces =
    snapshot.data?.workspaces ??
    (settings.status === "ready"
      ? settings.values.workspaces.map(({ workspaceId, alias }) => ({
          workspaceId,
          title: alias,
          cwd: null,
        }))
      : []);
  const shownWorkspaces = liveWorkspace
    ? [liveWorkspace]
    : workspaces.filter(
        (entry) => !workspaceId || entry.workspaceId === workspaceId,
      );

  return (
    <ScrollView
      style={styles.screen}
      contentContainerStyle={[
        styles.content,
        !layout.compact && { padding: 24 },
      ]}
      keyboardShouldPersistTaps="handled"
    >
      <Text style={styles.title}>Workspace names</Text>
      <Text style={styles.muted}>
        Keep task names visible while reusing your checkouts. Enable it for the
        workspaces you choose. Manual renames pause automatic naming.
      </Text>
      {settings.status !== "ready" ? (
        <View style={styles.group}>
          <Text
            style={settings.status === "loading" ? styles.muted : styles.error}
          >
            {settings.status === "loading"
              ? "Loading naming preferences…"
              : settings.error}
          </Text>
          {settings.status !== "loading" ? (
            <Button
              label="Reload preferences"
              styles={styles}
              onPress={() => void settings.reload()}
            />
          ) : null}
        </View>
      ) : null}
      {snapshot.isPending ? (
        <Text style={styles.muted}>Loading workspaces…</Text>
      ) : null}
      {snapshot.error ? (
        <View style={styles.group}>
          <Text accessibilityRole="alert" style={styles.error}>
            Could not load workspace names. {snapshot.error.message}
          </Text>
          <Button label="Try again" styles={styles} onPress={refresh} />
        </View>
      ) : null}
      {settings.saveError ? (
        <Text accessibilityRole="alert" style={styles.error}>
          {settings.saveError}
        </Text>
      ) : null}
      {settings.status === "ready" &&
        shownWorkspaces.map((workspace) => (
          <WorkspaceControls
            key={workspace.workspaceId}
            workspace={workspace}
            conversations={(snapshot.data?.agents ?? [])
              .filter((agent) => agent.workspaceId === workspace.workspaceId)
              .sort((left, right) =>
                right.createdAt.localeCompare(left.createdAt),
              )}
            status={snapshot.data?.statuses.find(
              (entry) => entry.workspaceId === workspace.workspaceId,
            )}
            settings={settings}
            styles={styles}
            theme={theme}
            unavailable={
              !snapshot.data || snapshot.isPending || snapshot.isError
            }
            conversationError={snapshot.data?.agentsError ?? null}
            refresh={refresh}
          />
        ))}
      {settings.status === "ready" &&
      snapshot.isSuccess &&
      shownWorkspaces.length === 0 ? (
        <Text style={styles.muted}>
          {workspaceId
            ? "This workspace is unavailable."
            : "No workspaces on this host yet."}
        </Text>
      ) : null}
    </ScrollView>
  );
}

export function LabelsScreen(props: PluginScreenProps) {
  const workspaceId =
    typeof props.params.workspaceId === "string"
      ? props.params.workspaceId
      : undefined;
  return <LabelsView {...props} workspaceId={workspaceId} />;
}

export function LabelsSettings(props: PluginSurfaceProps) {
  return <LabelsView {...props} />;
}

export function LabelsPanel(props: PluginWorkspacePanelProps) {
  const workspace = useWorkspace(
    props.workspaceId,
    ({ id, title, name, directory }) => ({
      workspaceId: id,
      title: title ?? name,
      cwd: directory,
    }),
  );
  return <LabelsView {...props} liveWorkspace={workspace} />;
}
