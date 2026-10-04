import type { PluginServerContext } from "@getpaseo/plugin/server";
import {
  accountsAdd,
  accountsList,
  accountsQuota,
  accountsRemove,
  accountsSetActive,
  accountsSettingsGet,
  accountsSettingsUpdate,
  accountsSignIn,
} from "./shared/accounts";
import {
  DEFAULT_ACCOUNT_ID,
  addAccount,
  listAccounts,
  multiAccountSupported,
  readAccountSettings,
  readAccounts,
  removeAccount,
  setActive,
  updateAccountSettings,
} from "./server/accounts";
import { invalidateCatalogCache } from "./server/catalog";
import { createProvider } from "./server/provider";
import { forgetAccountQuota, readAccountQuota } from "./server/quota";
import { launchSignIn } from "./server/signin";

/**
 * Contributes the Antigravity provider and the account RPCs behind the sidebar screen. The
 * handlers only translate: every filesystem decision lives in `server/accounts.ts` and
 * `server/signin.ts`.
 */
export default function contribute(server: PluginServerContext) {
  server.registerProvider(createProvider());

  server.handle(accountsList, () => ({
    active: readAccounts().active,
    accounts: listAccounts(),
    multiAccount: multiAccountSupported(),
  }));

  server.handle(accountsSetActive, ({ id }) => {
    setActive(id);
    // The list of models belongs to the account, so switching drops the discovered lists.
    invalidateCatalogCache();
    return { active: readAccounts().active };
  });

  server.handle(accountsAdd, ({ name }) => {
    const account = addAccount(name);
    return { id: account.id, name: account.name };
  });

  server.handle(accountsRemove, ({ id }) => {
    removeAccount(id);
    // The id can be added again; the new account must not be served the old one's quota.
    forgetAccountQuota(id);
    return { removed: id, active: readAccounts().active };
  });

  server.handle(accountsQuota, ({ id, refresh }) => readAccountQuota(id, { refresh }));

  server.handle(accountsSignIn, ({ id }) => launchSignIn(id));

  server.handle(accountsSettingsGet, ({ id }) => ({
    ...readAccountSettings(id),
    editable: id !== DEFAULT_ACCOUNT_ID,
  }));

  server.handle(accountsSettingsUpdate, ({ id, toolPermission, trustedWorkspaces }) => {
    updateAccountSettings(id, { toolPermission, trustedWorkspaces });
    return { ...readAccountSettings(id), editable: id !== DEFAULT_ACCOUNT_ID };
  });

  return () => {};
}
