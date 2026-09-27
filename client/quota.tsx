import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { useRpc } from "@getpaseo/plugin/client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo } from "react";
import { Pressable, Text, View } from "react-native";
import { accountsQuota } from "../shared/accounts";
import { errorMessage } from "./errors";
import {
  bucketAccessibilityLabel,
  formatCheckedAt,
  formatResetIn,
  formatResetInLong,
  percentLeft,
  windowLabel,
} from "./quota-format";

/**
 * One account's quota section, rendered inside that account's card. The daemon does the read
 * (`agy -p /usage` under the account's `HOME`); this only displays the answer and asks for a new
 * one when the user presses **Refresh**. Each card owns its query, so one account that is slow or
 * signed out never delays or blanks the others.
 *
 * A read costs tens of seconds and reaches Google through `agy` itself, so the answer is cached for
 * 5 minutes (`staleTime` matches the daemon's cache) and nothing polls: the card fetches on mount
 * and on Refresh only.
 */

type SurfaceChrome = Pick<PluginSurfaceProps, "theme" | "layout">;

interface AccountQuotaProps extends SurfaceChrome {
  accountId: string;
  accountName: string;
}

/** The same window `server/quota.ts` caches an answer for. */
const STALE_TIME_MS = 5 * 60 * 1000;

/** Below this share the bar turns `statusDanger`: the account is about to run out. */
const DANGER_BELOW_PERCENT = 10;

/** The store's reserved id for the real home, as `server/accounts.ts` defines it. */
const DEFAULT_ACCOUNT_ID = "default";

export function AccountQuota({ accountId, accountName, theme, layout }: AccountQuotaProps) {
  const readQuota = useRpc(accountsQuota);
  const queryClient = useQueryClient();
  const queryKey = useMemo(() => ["agy-quota", accountId], [accountId]);
  const quota = useQuery({
    queryKey,
    queryFn: () => readQuota({ id: accountId }),
    staleTime: STALE_TIME_MS,
  });
  // Refresh writes its answer straight into the query cache: the daemon already cached it, so a
  // refetch would only schedule a second read for the same figures.
  const refresh = useMutation({
    mutationFn: () => readQuota({ id: accountId, refresh: true }),
    onSuccess: (next) => queryClient.setQueryData(queryKey, next),
  });

  const styles = useMemo(
    () => ({
      section: {
        borderTopWidth: 1,
        borderTopColor: theme.colors.border,
        gap: 6,
        paddingTop: layout.compact ? 8 : 10,
      },
      row: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        justifyContent: "space-between" as const,
        gap: 8,
      },
      label: { color: theme.colors.foregroundMuted, fontSize: 13 },
      hint: { color: theme.colors.foregroundMuted, fontSize: 13 },
      error: { color: theme.colors.statusDanger, fontSize: 13 },
      action: { color: theme.colors.accent, fontSize: 13 },
      bucket: { gap: 4 },
      bucketTitle: { color: theme.colors.foreground, fontSize: 13, flexShrink: 1 },
      bucketPercent: { color: theme.colors.foreground, fontSize: 13, fontWeight: "600" as const },
      track: {
        height: 6,
        borderRadius: 3,
        backgroundColor: theme.colors.border,
        overflow: "hidden" as const,
      },
      fill: { height: 6, borderRadius: 3 },
    }),
    [theme, layout.compact],
  );

  const busy = quota.isFetching || refresh.isPending;
  const isDefault = accountId === DEFAULT_ACCOUNT_ID;

  function renderBody() {
    if (quota.isPending) return <Text style={styles.hint}>Checking quota…</Text>;
    if (quota.isError) return <Text style={styles.error}>{errorMessage(quota.error)}</Text>;
    const data = quota.data;
    if (data.state === "signed-out") {
      return (
        <Text style={styles.hint}>
          {isDefault ? "Signed out — run agy to sign in" : "Signed out — use Sign in again"}
        </Text>
      );
    }
    if (data.state === "unavailable") return <Text style={styles.hint}>{data.message}</Text>;
    if (data.state === "error") return <Text style={styles.error}>{data.message}</Text>;

    const now = Date.now();
    const rows = data.groups.flatMap((group) =>
      group.buckets.map((bucket, index) => ({
        key: `${group.name}/${bucket.id}/${index}`,
        group: group.name,
        bucket,
      })),
    );
    if (rows.length === 0) return <Text style={styles.hint}>No quota reported</Text>;
    return (
      <>
        {rows.map(({ key, group, bucket }) => {
          const percent = percentLeft(bucket.remainingFraction);
          const windowText = windowLabel(bucket.window, bucket.name);
          const resetText = formatResetIn(bucket.resetTime, now);
          return (
            <View
              key={key}
              accessible
              accessibilityLabel={bucketAccessibilityLabel(
                group,
                windowText,
                percent,
                formatResetInLong(bucket.resetTime, now),
              )}
              style={styles.bucket}
            >
              <View style={styles.row}>
                <Text style={styles.bucketTitle}>
                  {group} · {windowText}
                </Text>
                <Text style={styles.bucketPercent}>{percent}% left</Text>
              </View>
              <View style={styles.track}>
                <View
                  style={[
                    styles.fill,
                    {
                      width: `${percent}%`,
                      backgroundColor:
                        percent < DANGER_BELOW_PERCENT
                          ? theme.colors.statusDanger
                          : theme.colors.accent,
                    },
                  ]}
                />
              </View>
              {resetText === "" ? null : <Text style={styles.hint}>{resetText}</Text>}
            </View>
          );
        })}
        <Text style={styles.hint}>checked {formatCheckedAt(data.fetchedAt)}</Text>
      </>
    );
  }

  return (
    <View style={styles.section}>
      <View style={styles.row}>
        <Text style={styles.label}>Usage quota</Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Check ${accountName} quota now`}
          disabled={busy}
          onPress={() => refresh.mutate()}
        >
          <Text style={styles.action}>{busy ? "Checking…" : "Refresh"}</Text>
        </Pressable>
      </View>
      {renderBody()}
      {refresh.error == null ? null : (
        <Text style={styles.error}>{errorMessage(refresh.error)}</Text>
      )}
    </View>
  );
}
