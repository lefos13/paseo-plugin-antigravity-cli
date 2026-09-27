import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { useRpc } from "@getpaseo/plugin/client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { Pressable, Text, TextInput, View } from "react-native";
import {
  TOOL_PERMISSIONS,
  accountsSettingsGet,
  accountsSettingsUpdate,
} from "../shared/accounts";
import { errorMessage } from "./errors";

/**
 * The `toolPermission` and `trustedWorkspaces` half of the accounts screen: the two settings the
 * plugin owns. Everything else in the account's `settings.json` belongs to `agy` and is left as it
 * is by the daemon handler. Default's file is the real one the CLI maintains, so it is shown
 * read-only.
 *
 * The editor writes one whole value at a time (the daemon handler preserves the rest of the file),
 * and the screen reacts to the reply, so a refetch is not needed to see its own change.
 */

type SurfaceChrome = Pick<PluginSurfaceProps, "theme" | "layout">;

interface AccountSettingsProps extends SurfaceChrome {
  accountId: string;
  accountName: string;
}

export function AccountSettings({ accountId, accountName, theme, layout }: AccountSettingsProps) {
  const getSettings = useRpc(accountsSettingsGet);
  const updateSettings = useRpc(accountsSettingsUpdate);
  const queryClient = useQueryClient();
  const queryKey = useMemo(() => ["antigravity-account-settings", accountId], [accountId]);
  const settings = useQuery({ queryKey, queryFn: () => getSettings({ id: accountId }) });
  const [draftPath, setDraftPath] = useState("");
  const [inputError, setInputError] = useState(null as string | null);

  const save = useMutation({
    mutationFn: (patch: { toolPermission?: string; trustedWorkspaces?: string[] }) =>
      updateSettings({ id: accountId, ...patch }),
    onSuccess: (next) => {
      queryClient.setQueryData(queryKey, next);
      setInputError(null);
      setDraftPath("");
    },
  });

  const styles = useMemo(
    () => ({
      card: {
        borderWidth: 1,
        borderColor: theme.colors.border,
        borderRadius: 8,
        gap: layout.compact ? 8 : 10,
        padding: layout.compact ? 12 : 16,
        backgroundColor: theme.colors.surface1,
      },
      title: { color: theme.colors.foreground, fontSize: 15, fontWeight: "600" as const },
      body: { color: theme.colors.foreground },
      hint: { color: theme.colors.foregroundMuted, fontSize: 13 },
      label: { color: theme.colors.foregroundMuted, fontSize: 13 },
      error: { color: theme.colors.statusDanger, fontSize: 13 },
      options: { flexDirection: "row" as const, flexWrap: "wrap" as const, gap: 8 },
      option: {
        borderWidth: 1,
        borderColor: theme.colors.border,
        borderRadius: 999,
        paddingHorizontal: 12,
        paddingVertical: 6,
      },
      optionSelected: {
        borderColor: theme.colors.accent,
        backgroundColor: theme.colors.accent,
      },
      optionText: { color: theme.colors.foreground, fontSize: 13 },
      optionTextSelected: { color: theme.colors.accentForeground, fontSize: 13 },
      row: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        justifyContent: "space-between" as const,
        gap: 8,
      },
      path: { color: theme.colors.foreground, flexShrink: 1 },
      action: { color: theme.colors.accent, fontSize: 13 },
      danger: { color: theme.colors.statusDanger, fontSize: 13 },
      inputRow: { flexDirection: "row" as const, alignItems: "center" as const, gap: 8 },
      input: {
        flex: 1,
        borderWidth: 1,
        borderColor: theme.colors.border,
        borderRadius: 8,
        color: theme.colors.foreground,
        paddingHorizontal: 10,
        paddingVertical: layout.compact ? 8 : 10,
        backgroundColor: theme.colors.surface0,
      },
    }),
    [theme, layout.compact],
  );

  if (settings.isPending) {
    return (
      <View style={styles.card}>
        <Text style={styles.hint}>Loading settings…</Text>
      </View>
    );
  }
  if (settings.isError) {
    return (
      <View style={styles.card}>
        <Text style={styles.error}>{errorMessage(settings.error)}</Text>
      </View>
    );
  }

  const current = settings.data;
  const permission = current.toolPermission;
  const options =
    permission !== null && !TOOL_PERMISSIONS.includes(permission)
      ? [...TOOL_PERMISSIONS, permission]
      : TOOL_PERMISSIONS;

  if (!current.editable) {
    return (
      <View style={styles.card}>
        <Text style={styles.title}>{accountName} settings</Text>
        <Text style={styles.hint}>
          Managed by agy: this is the real home's own settings file, written by the CLI.
        </Text>
        <Text style={styles.label}>Tool permission</Text>
        <Text style={styles.body}>{permission ?? "not set (agy default)"}</Text>
        <Text style={styles.label}>Trusted workspaces</Text>
        {current.trustedWorkspaces.length === 0 ? (
          <Text style={styles.body}>none</Text>
        ) : (
          current.trustedWorkspaces.map((path) => (
            <Text key={path} style={styles.body}>
              {path}
            </Text>
          ))
        )}
      </View>
    );
  }

  function addWorkspace(): void {
    const path = draftPath.trim();
    if (path.length === 0) {
      setInputError("Enter a workspace path");
      return;
    }
    if (current.trustedWorkspaces.includes(path)) {
      setInputError("That path is already trusted");
      return;
    }
    save.mutate({ trustedWorkspaces: [...current.trustedWorkspaces, path] });
  }

  return (
    <View style={styles.card}>
      <Text style={styles.title}>{accountName} settings</Text>

      <Text style={styles.label}>Tool permission</Text>
      <View style={styles.options}>
        {options.map((value) => {
          const selected = value === permission;
          return (
            <Pressable
              key={value}
              accessibilityRole="button"
              accessibilityState={{ selected }}
              accessibilityLabel={`Set tool permission to ${value}`}
              disabled={save.isPending}
              onPress={() => save.mutate({ toolPermission: value })}
              style={[styles.option, selected && styles.optionSelected]}
            >
              <Text style={selected ? styles.optionTextSelected : styles.optionText}>{value}</Text>
            </Pressable>
          );
        })}
      </View>
      <Text style={styles.hint}>
        {permission === null ? "Currently not set, so agy's own default applies." : `Currently ${permission}.`}
      </Text>

      <Text style={styles.label}>Trusted workspaces</Text>
      {current.trustedWorkspaces.length === 0 ? (
        <Text style={styles.hint}>No workspace is trusted for this account yet.</Text>
      ) : (
        current.trustedWorkspaces.map((path) => (
          <View key={path} style={styles.row}>
            <Text style={styles.path}>{path}</Text>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Stop trusting ${path}`}
              disabled={save.isPending}
              onPress={() =>
                save.mutate({
                  trustedWorkspaces: current.trustedWorkspaces.filter((entry) => entry !== path),
                })
              }
            >
              <Text style={styles.danger}>Remove</Text>
            </Pressable>
          </View>
        ))
      )}
      <View style={styles.inputRow}>
        <TextInput
          style={styles.input}
          value={draftPath}
          onChangeText={(text) => {
            setDraftPath(text);
            setInputError(null);
          }}
          placeholder="/absolute/path/to/workspace"
          placeholderTextColor={theme.colors.foregroundMuted}
          autoCapitalize="none"
          autoCorrect={false}
        />
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Trust the workspace path"
          disabled={save.isPending}
          onPress={addWorkspace}
        >
          <Text style={styles.action}>{save.isPending ? "Saving…" : "Add"}</Text>
        </Pressable>
      </View>

      {inputError === null ? null : <Text style={styles.error}>{inputError}</Text>}
      {save.isError ? (
        <Text style={styles.error}>{errorMessage(save.error)}</Text>
      ) : null}
      <Text style={styles.hint}>Changes apply to the account's next launch.</Text>
    </View>
  );
}
