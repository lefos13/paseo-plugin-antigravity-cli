import { execFile } from "node:child_process";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { dirname, join } from "node:path";
import { DEFAULT_ACCOUNT_ID, accountHome, accountKeychainPath, readAccounts, syncShadowHome } from "./accounts";
import { resolveAgyBinary } from "./agy";
import { pluginDataDir } from "./plugindata";

/**
 * Signing an account in means running the CLI's own flow, and that flow must run with
 * `HOME=<shadow home>` in a *native* terminal window: a Paseo terminal would put the daemon's
 * machine and the user's screen out of sync, and `osascript` needs an Automation permission the
 * plugin will not ask for.
 *
 * On macOS the launcher therefore writes `accounts/<id>/sign-in.command` (mode 0700) and hands it
 * to `open`, which runs it in whatever app owns `.command` files — Terminal.app by default. The
 * file lives in the account's own directory, so removing the account removes it too. Everywhere
 * else, and whenever that hand-off fails, nothing is launched and the screen shows the same
 * command for the user to run on `host`. The window opens on the daemon's machine, so the caller
 * always gets `host` and `command`, launched or not.
 */

export interface SignInResult {
  /** Whether a terminal window was handed the command on this machine. */
  launched: boolean;
  /** The machine the window would open on; the daemon's host name. */
  host: string;
  /** The exact shell line to run there: `HOME='<shadow home>' '<agy>'`. */
  command: string;
}

/** Injected by the tests; the defaults are the real process and the real `open`. */
export interface SignInOptions {
  platform?: NodeJS.Platform;
  open?: (file: string) => Promise<void>;
  hostname?: () => string;
}

/** The account's shadow home, refusing Default and any id the store does not know. */
function requireSignInHome(id: string): string {
  if (id === DEFAULT_ACCOUNT_ID) {
    throw new Error(
      "The Default account is the real home; plain `agy` already signs it in, so there is nothing to launch",
    );
  }
  if (!readAccounts().accounts.some((account) => account.id === id)) {
    throw new Error(`Unknown account: ${id}`);
  }
  const home = accountHome(id);
  if (home === null) throw new Error(`Unknown account: ${id}`);
  return home;
}

/** POSIX single-quoting: the only characters that matter inside `'…'` are quotes themselves. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * The `.command` file, and the line the user would otherwise paste. The window owns a shell of its
 * own, so it unlocks the account's Keychain before `agy` starts: a locked keychain would stop the
 * sign-in behind a password dialog. Off macOS the `security` call is a no-op failure the script
 * ignores, exactly as it ignores it for the copyable command.
 */
export function signInScript(home: string, binary: string): string {
  return (
    `#!/bin/sh\n` +
    `# Antigravity sign-in: this account's HOME and Keychain, then the CLI's own flow.\n` +
    `export HOME=${shellQuote(home)}\n` +
    `/usr/bin/security unlock-keychain -p '' ${shellQuote(accountKeychainPath(home))} >/dev/null 2>&1\n` +
    `exec ${shellQuote(binary)}\n`
  );
}

/** `HOME='<shadow home>' '<agy>'`, the copyable form of the script. */
export function signInCommand(home: string, binary: string): string {
  return `HOME=${shellQuote(home)} ${shellQuote(binary)}`;
}

function openFile(file: string): Promise<void> {
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  execFile("open", [file], (error) => (error ? reject(error) : resolve()));
  return promise;
}

/**
 * Writes the sign-in script and, on macOS, opens it in the native terminal app. A refused
 * `open` (no app associated with `.command`, no display, `open` missing) is not an error: the
 * caller falls back to showing the command. Anything wrong with the account itself throws.
 */
export async function launchSignIn(id: string, options: SignInOptions = {}): Promise<SignInResult> {
  const platform = options.platform ?? process.platform;
  const open = options.open ?? openFile;
  const host = (options.hostname ?? hostname)();
  const home = requireSignInHome(id);
  // The account's shadow home and its Keychain exist before anything can be launched in them.
  syncShadowHome(id);
  const binary = resolveAgyBinary();
  const command = signInCommand(home, binary);
  if (platform !== "darwin") return { launched: false, host, command };

  const file = join(pluginDataDir("accounts", id), "sign-in.command");
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, signInScript(home, binary), { mode: 0o700 });
  // `writeFileSync`'s mode is filtered by the umask; the script is executable by its owner only.
  chmodSync(file, 0o700);
  try {
    await open(file);
    return { launched: true, host, command };
  } catch {
    return { launched: false, host, command };
  }
}
