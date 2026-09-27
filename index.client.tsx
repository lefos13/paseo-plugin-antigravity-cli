import type { PluginClientContext } from "@getpaseo/plugin/client";
import { AccountsSurface } from "./client/accounts";

/**
 * The app-side entry. A sidebar item opens the accounts surface; the surface itself talks to the
 * daemon through the account RPCs and never touches the account store or any file.
 */
export default function contribute(client: PluginClientContext) {
  client.addSurface("accounts", AccountsSurface);
  client.addSidebarItem({
    id: "accounts",
    title: "Antigravity accounts",
    icon: "UserRound",
    surface: "accounts",
  });
  return () => {};
}
