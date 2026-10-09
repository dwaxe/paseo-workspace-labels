import type {
  PluginClientContext,
  PluginSidebarItemProps,
} from "@getpaseo/plugin/client";
import { SidebarRow } from "@getpaseo/plugin/client/ui";
import { LabelsPanel, LabelsScreen, LabelsSettings } from "./client/labels";

function LabelsItem({ currentScreen, openScreen }: PluginSidebarItemProps) {
  return (
    <SidebarRow
      icon="Tags"
      active={currentScreen?.screenId === "labels"}
      onPress={() => openScreen({ screenId: "labels" })}
    />
  );
}

export default function contribute(client: PluginClientContext) {
  const cleanups = [
    client.addScreen({
      id: "labels",
      title: "Workspace names",
      Component: LabelsScreen,
    }),
    client.addSettingsScreen({
      id: "labels",
      title: "Workspace names",
      icon: "Tags",
      Component: LabelsSettings,
    }),
    client.addSidebarHeaderItem({
      id: "labels",
      title: "Workspace names",
      Component: LabelsItem,
    }),
    client.addWorkspacePanel({
      id: "labels",
      title: "Workspace names",
      icon: "Tags",
      context: "workspace",
      locations: ["workspace", "explorer"],
      Component: LabelsPanel,
    }),
    client.addCommandCenterItem({
      id: "configure-labels",
      title: "Configure workspace names",
      icon: "Tags",
      context: "global",
      keywords: ["automatic", "naming", "checkout", "labels"],
      onSelect({ openScreen }) {
        openScreen({ screenId: "labels" });
      },
    }),
    client.addCommandCenterItem({
      id: "open-workspace-labels",
      title: "Configure this workspace name",
      icon: "Tags",
      context: "workspace",
      keywords: ["automatic", "naming", "checkout", "labels"],
      onSelect({ openPanel }) {
        openPanel("labels");
      },
    }),
    client.addCommandCenterItem({
      id: "open-agent-workspace-labels",
      title: "Configure this workspace name",
      icon: "Tags",
      context: "agent",
      keywords: ["automatic", "naming", "checkout", "labels"],
      onSelect({ openPanel }) {
        openPanel("labels");
      },
    }),
  ];
  return () => {
    for (const dispose of cleanups.reverse()) void dispose();
  };
}
