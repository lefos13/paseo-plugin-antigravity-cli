import { writeFileSync } from "node:fs";
import { setKeychainRuntime } from "../accounts";

/** One `/usr/bin/security` invocation, as the plugin would make it. */
export interface SecurityCall {
  args: readonly string[];
  /** The `HOME` the call carried: the account's shadow home, never the real one. */
  home: string | undefined;
}

/** A fake `/usr/bin/security` installed for the duration of a test. */
export interface FakeSecurity {
  readonly calls: SecurityCall[];
  /** Makes every later call throw, as a locked or busy keychain would. */
  failWith(error: Error): void;
  /** Restores the real runtime; call from `afterEach` so no test can reach `/usr/bin/security`. */
  restore(): void;
}

/**
 * Replaces `/usr/bin/security` for one test file. The fake records every call, throws on demand,
 * and on `create-keychain` writes the database file exactly as the real tool does, so a second sync
 * takes the unlock-only path. Nothing here can touch the real Keychain.
 */
export function installFakeSecurity(platform: NodeJS.Platform = "darwin"): FakeSecurity {
  const calls: SecurityCall[] = [];
  let failure: Error | null = null;
  setKeychainRuntime({
    platform,
    run: (args, env) => {
      calls.push({ args: [...args], home: env.HOME });
      if (failure !== null) throw failure;
      if (args[0] === "create-keychain") writeFileSync(args[3], "", "utf8");
    },
  });
  return {
    calls,
    failWith: (error) => {
      failure = error;
    },
    restore: () => setKeychainRuntime(null),
  };
}
