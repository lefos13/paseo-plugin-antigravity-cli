import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { useRpc } from "@getpaseo/plugin/client";
import { copyText } from "@getpaseo/plugin/client/react-native";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { Pressable, ScrollView, Text, TextInput, View } from "react-native";
import {
  accountsAdd,
  accountsList,
  accountsRemove,
  accountsSetActive,
  accountsSignIn,
} from "../shared/accounts";
import { AccountSettings } from "./account-settings";
import { errorMessage } from "./errors";
import { AccountQuota } from "./quota";

const ACCOUNTS_KEY = ["antigravity-accounts"];

/** The store's reserved id for the real home, as `server/accounts.ts` defines it. */
const DEFAULT_ACCOUNT_ID = "default";

/** What the sign-in block shows after `accounts.sign-in`, launched or not. */
interface SignInNotice {
  id: string;
  name: string;
  launched: boolean;
  host: string;
  command: string;
}

/**
 * The "Antigravity accounts" screen. The daemon owns the store and the shadow homes; this surface
 * lists them, switches the host-wide active account (each non-active row has its own **Use**
 * button; pressing a row's name only chooses whose settings the pane below shows), creates and
 * removes accounts, and hands the user the exact command that signs an account in where no window
 * could be opened for them.
 *
 * Text is always coloured from `theme.colors`, and padding follows `layout.compact`, so the screen
 * is legible in every theme and on a phone.
 */
export function AccountsSurface({ theme, layout }: PluginSurfaceProps) {
  const listAccounts = useRpc(accountsList);
  const setActiveAccount = useRpc(accountsSetActive);
  const addAccount = useRpc(accountsAdd);
  const removeAccount = useRpc(accountsRemove);
  const signIn = useRpc(accountsSignIn);
  const queryClient = useQueryClient();

  const accountsQuery = useQuery({
    queryKey: ACCOUNTS_KEY,
    queryFn: () => listAccounts({}),
  });
  const [selectedId, setSelectedId] = useState(null as string | null);
  const [notice, setNotice] = useState<SignInNotice | null>(null);
  const [draftName, setDraftName] = useState("");
  const [confirmId, setConfirmId] = useState(null as string | null);
  const [formError, setFormError] = useState(null as string | null);

  const refresh = () => queryClient.invalidateQueries({ queryKey: ACCOUNTS_KEY });

  // Activating only happens through a row's Use button, and it keeps the settings pane on the
  // account it activated; pressing a row's name selects without spawning any RPC.
  const activate = useMutation({
    mutationFn: setActiveAccount,
    onSuccess: (result) => {
      setSelectedId(result.active);
      void refresh();
    },
  });
  const create = useMutation({
    mutationFn: (name: string) => addAccount({ name }),
    onSuccess: async (account) => {
      setDraftName("");
      setSelectedId(account.id);
      await refresh();
      // The account exists from here on, so a refused sign-in must not hide it: the row is
      // already in the list and the message below says what to do.
      try {
        setNotice({ id: account.id, name: account.name, ...(await signIn({ id: account.id })) });
      } catch (error) {
        setFormError(
          `Account "${account.name}" was created, but the sign-in request failed: ${errorMessage(error)}`,
        );
      }
    },
  });
  const signInAgain = useMutation({
    mutationFn: (account: { id: string; name: string }) =>
      signIn({ id: account.id }).then((result) => ({ account, result })),
    onSuccess: ({ account, result }) => setNotice({ id: account.id, name: account.name, ...result }),
  });
  const remove = useMutation({
    mutationFn: (id: string) => removeAccount({ id }),
    onSuccess: (result, id) => {
      setConfirmId(null);
      setNotice((current) => (current?.id === id ? null : current));
      setSelectedId(result.active);
      // The id can be added again, and the new account must not inherit the old one's figures.
      queryClient.removeQueries({ queryKey: ["agy-quota", id] });
      void refresh();
    },
  });

  const styles = useMemo(
    () => ({
      screen: { flex: 1, backgroundColor: theme.colors.surface0 },
      content: {
        padding: layout.compact ? 16 : 24,
        gap: layout.compact ? 12 : 16,
      },
      title: { color: theme.colors.foreground, fontSize: layout.compact ? 20 : 24, fontWeight: "600" as const },
      body: { color: theme.colors.foreground },
      hint: { color: theme.colors.foregroundMuted, fontSize: 13 },
      label: { color: theme.colors.foregroundMuted, fontSize: 13, textTransform: "uppercase" as const },
      error: { color: theme.colors.statusDanger, fontSize: 13 },
      card: {
        borderWidth: 1,
        borderColor: theme.colors.border,
        borderRadius: 8,
        gap: layout.compact ? 8 : 10,
        padding: layout.compact ? 12 : 16,
        backgroundColor: theme.colors.surface1,
      },
      cardSelected: { borderColor: theme.colors.accent },
      cardTitle: { color: theme.colors.foreground, fontSize: 15, fontWeight: "600" as const },
      row: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        justifyContent: "space-between" as const,
        gap: 8,
      },
      rowMain: { flexDirection: "row" as const, alignItems: "center" as const, gap: 8, flexShrink: 1 },
      accountName: { color: theme.colors.foreground, fontSize: 16 },
      accountNameActive: { color: theme.colors.accent, fontSize: 16, fontWeight: "600" as const },
      badge: {
        borderWidth: 1,
        borderColor: theme.colors.accent,
        borderRadius: 999,
        color: theme.colors.accent,
        fontSize: 12,
        paddingHorizontal: 8,
        paddingVertical: 2,
      },
      actions: { flexDirection: "row" as const, alignItems: "center" as const, gap: 12 },
      action: { color: theme.colors.accent, fontSize: 13 },
      danger: { color: theme.colors.statusDanger, fontSize: 13 },
      command: {
        borderWidth: 1,
        borderColor: theme.colors.border,
        borderRadius: 6,
        color: theme.colors.foreground,
        fontFamily: layout.platform === "ios" ? "Courier" : "monospace",
        fontSize: 13,
        padding: 8,
        backgroundColor: theme.colors.surface0,
      },
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
      primary: {
        borderRadius: 8,
        paddingHorizontal: 14,
        paddingVertical: layout.compact ? 8 : 10,
        backgroundColor: theme.colors.accent,
      },
      primaryText: { color: theme.colors.accentForeground, fontWeight: "600" as const },
      useButton: {
        borderWidth: 1,
        borderColor: theme.colors.accent,
        borderRadius: 6,
        paddingHorizontal: 12,
        paddingVertical: layout.compact ? 4 : 6,
      },
      useButtonText: { color: theme.colors.accent, fontSize: 13, fontWeight: "600" as const },
    }),
    [theme, layout.compact, layout.platform],
  );

  const accounts = accountsQuery.data?.accounts ?? [];
  const settingsId =
    selectedId !== null && accounts.some((account) => account.id === selectedId)
      ? selectedId
      : (accountsQuery.data?.active ?? DEFAULT_ACCOUNT_ID);
  const settingsName = accounts.find((account) => account.id === settingsId)?.name ?? settingsId;
  const failure = formError ?? create.error ?? activate.error ?? signInAgain.error ?? remove.error;

  function submitName(): void {
    const name = draftName.trim();
    if (name.length === 0) {
      setFormError("Enter a name for the new account");
      return;
    }
    setFormError(null);
    create.mutate(name);
  }

  async function copyNoticeCommand() {
    if (notice === null) return;
    try {
      await copyText(notice.command);
      setFormError(null);
    } catch {
      setFormError("The command could not be copied here; select it above and copy it by hand.");
    }
  }

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      <Text style={styles.title}>Antigravity accounts</Text>
      <Text style={styles.hint}>
        New agents run under the active account, and an imported conversation resumes under the
        account that created it. Default is the real home, exactly as agy runs it today.
      </Text>

      {failure === null ? null : <Text style={styles.error}>{errorMessage(failure)}</Text>}

      <View style={styles.card}>
        <Text style={styles.cardTitle}>Add account</Text>
        <Text style={styles.hint}>
          Creates the account's own folder, then opens the CLI's sign-in there.
        </Text>
        <View style={styles.inputRow}>
          <TextInput
            style={styles.input}
            value={draftName}
            onChangeText={(text) => {
              setDraftName(text);
              setFormError(null);
            }}
            placeholder="Account name, e.g. Work"
            placeholderTextColor={theme.colors.foregroundMuted}
            autoCapitalize="none"
            autoCorrect={false}
            onSubmitEditing={submitName}
          />
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Add the account and sign in"
            disabled={create.isPending}
            onPress={submitName}
            style={styles.primary}
          >
            <Text style={styles.primaryText}>{create.isPending ? "Adding…" : "Add"}</Text>
          </Pressable>
        </View>
      </View>

      {notice === null ? null : (
        <View style={styles.card}>
          <Text style={styles.cardTitle}>
            {notice.launched
              ? `A Terminal window opened on ${notice.host}, finish Google sign-in there`
              : `Run this in a terminal on ${notice.host}`}
          </Text>
          <Text selectable style={styles.command}>
            {notice.command}
          </Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Copy the sign-in command"
            onPress={() => void copyNoticeCommand()}
          >
            <Text style={styles.action}>Copy command</Text>
          </Pressable>
        </View>
      )}

      <Text style={styles.label}>Accounts</Text>
      {accountsQuery.isPending ? (
        <Text style={styles.hint}>Loading accounts…</Text>
      ) : accountsQuery.isError ? (
        <Text style={styles.error}>{errorMessage(accountsQuery.error)}</Text>
      ) : (
        accounts.map((account) => {
          const isActive = account.id === accountsQuery.data?.active;
          const isSelected = account.id === settingsId;
          const isDefault = account.id === DEFAULT_ACCOUNT_ID;
          return (
            <View key={account.id} style={[styles.card, isSelected && styles.cardSelected]}>
              <View style={styles.row}>
                <Pressable
                  accessibilityRole="button"
                  accessibilityState={{ selected: isSelected }}
                  accessibilityLabel={`Show settings for ${account.name}`}
                  onPress={() => setSelectedId(account.id)}
                  style={styles.rowMain}
                >
                  <Text style={isActive ? styles.accountNameActive : styles.accountName}>
                    {account.name}
                  </Text>
                </Pressable>
                <View style={styles.actions}>
                  {isActive ? (
                    <Text style={styles.badge}>active</Text>
                  ) : (
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel={`Make ${account.name} the active account`}
                      disabled={activate.isPending}
                      onPress={() => activate.mutate({ id: account.id })}
                      style={styles.useButton}
                    >
                      <Text style={styles.useButtonText}>
                        {activate.isPending && activate.variables?.id === account.id
                          ? "Using…"
                          : "Use"}
                      </Text>
                    </Pressable>
                  )}
                  {isDefault ? null : (
                    <>
                      <Pressable
                        accessibilityRole="button"
                        accessibilityLabel={`Sign ${account.name} in again`}
                        disabled={signInAgain.isPending}
                        onPress={() => signInAgain.mutate({ id: account.id, name: account.name })}
                      >
                        <Text style={styles.action}>
                          {signInAgain.isPending && signInAgain.variables?.id === account.id
                            ? "Opening…"
                            : "Sign in again"}
                        </Text>
                      </Pressable>
                      <Pressable
                        accessibilityRole="button"
                        accessibilityLabel={`Remove ${account.name}`}
                        disabled={remove.isPending}
                        onPress={() => setConfirmId(account.id)}
                      >
                        <Text style={styles.danger}>Remove</Text>
                      </Pressable>
                    </>
                  )}
                </View>
              </View>
              <AccountQuota
                accountId={account.id}
                accountName={account.name}
                theme={theme}
                layout={layout}
              />
              {isDefault ? (
                <Text style={styles.hint}>The real home, with the sign-in agy already has.</Text>
              ) : confirmId === account.id ? (
                <View style={styles.card}>
                  <Text style={styles.body}>
                    Remove {account.name}? This deletes the account's folder: its sign-in and its
                    conversation history. The real ~/.gemini is untouched.
                  </Text>
                  <View style={styles.actions}>
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel={`Confirm removing ${account.name}`}
                      disabled={remove.isPending}
                      onPress={() => remove.mutate(account.id)}
                    >
                      <Text style={styles.danger}>
                        {remove.isPending ? "Removing…" : "Yes, remove it"}
                      </Text>
                    </Pressable>
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel="Keep the account"
                      onPress={() => setConfirmId(null)}
                    >
                      <Text style={styles.action}>Cancel</Text>
                    </Pressable>
                  </View>
                </View>
              ) : null}
            </View>
          );
        })
      )}

      <AccountSettings
        key={settingsId}
        accountId={settingsId}
        accountName={settingsName}
        theme={theme}
        layout={layout}
      />
    </ScrollView>
  );
}
