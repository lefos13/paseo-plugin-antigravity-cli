import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_ACCOUNT_ID, accountHome, accountKeychainPath, addAccount, removeAccount } from "./accounts";
import { launchSignIn, shellQuote, signInCommand, signInScript } from "./signin";
import { installFakeSecurity, type FakeSecurity } from "./testing/fake-security";

const originalHome = process.env.HOME;
const originalPaseoHome = process.env.PASEO_HOME;
const originalBinary = process.env.PASEO_ANTIGRAVITY_BIN;

const BINARY = "/opt/antigravity/agy";

let root: string;
let paseoHome: string;
/** The fake `/usr/bin/security`: `launchSignIn` syncs the shadow home, so this must never be real. */
let security: FakeSecurity;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "antigravity-signin-"));
  process.env.HOME = join(root, "home");
  mkdirSync(process.env.HOME, { recursive: true });
  paseoHome = join(root, "paseo-home");
  process.env.PASEO_HOME = paseoHome;
  // A fixed path keeps the command string identical across machines.
  process.env.PASEO_ANTIGRAVITY_BIN = BINARY;
  security = installFakeSecurity();
});

afterEach(() => {
  security.restore();
  vi.restoreAllMocks();
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalPaseoHome === undefined) delete process.env.PASEO_HOME;
  else process.env.PASEO_HOME = originalPaseoHome;
  if (originalBinary === undefined) delete process.env.PASEO_ANTIGRAVITY_BIN;
  else process.env.PASEO_ANTIGRAVITY_BIN = originalBinary;
  rmSync(root, { recursive: true, force: true });
});

function commandFile(id: string): string {
  return join(paseoHome, "plugin-data", "antigravity-cli", "accounts", id, "sign-in.command");
}

describe("launchSignIn", () => {
  it("writes an executable script that exports the account HOME and execs agy, then opens it", async () => {
    addAccount("Work");
    const home = accountHome("work");
    const opened: string[] = [];

    const result = await launchSignIn("work", {
      platform: "darwin",
      hostname: () => "daemon.example",
      open: async (file) => {
        opened.push(file);
      },
    });

    expect(result).toEqual({
      launched: true,
      host: "daemon.example",
      command: `HOME=${shellQuote(home!)} ${shellQuote(BINARY)}`,
    });
    const file = commandFile("work");
    expect(opened).toEqual([file]);
    expect(statSync(file).mode & 0o777).toBe(0o700);
    const script = readFileSync(file, "utf8");
    expect(script.startsWith("#!/bin/sh\n")).toBe(true);
    expect(script).toContain(`export HOME=${shellQuote(home!)}`);
    expect(script).toContain(
      `/usr/bin/security unlock-keychain -p '' ${shellQuote(accountKeychainPath(home!))} >/dev/null 2>&1`,
    );
    expect(script).toContain(`exec ${shellQuote(BINARY)}`);
    // Nothing else can leak in: the script is exactly shebang, comment, export, unlock, exec.
    expect(script.trimEnd().split("\n")).toHaveLength(5);
  });

  it("recreates this account's Keychain before it hands the window the script", async () => {
    addAccount("Work");
    const home = accountHome("work")!;
    // As if the account had been synced before this feature existed: no Keychain at all.
    rmSync(join(home, "Library", "Keychains"), { recursive: true, force: true });
    expect(existsSync(accountKeychainPath(home))).toBe(false);

    await launchSignIn("work", { platform: "darwin", open: async () => {} });

    expect(existsSync(accountKeychainPath(home))).toBe(true);
    // Unlocked last, so the window never sees the keychain the plugin just created still locked.
    expect(security.calls.at(-1)?.args).toEqual([
      "unlock-keychain",
      "-p",
      "",
      accountKeychainPath(home),
    ]);
    expect(security.calls.every((call) => call.home === home)).toBe(true);
  });

  it("reports the daemon's host name when no hostname is injected", async () => {
    addAccount("Work");
    const result = await launchSignIn("work", { platform: "darwin", open: async () => {} });
    expect(result.host).toBe(hostname());
  });

  it("returns launched: false with the same command when open fails", async () => {
    addAccount("Work");
    const home = accountHome("work");
    const result = await launchSignIn("work", {
      platform: "darwin",
      hostname: () => "daemon.example",
      open: async () => {
        throw new Error("no application knows how to open .command");
      },
    });
    expect(result).toEqual({
      launched: false,
      host: "daemon.example",
      command: `HOME=${shellQuote(home!)} ${shellQuote(BINARY)}`,
    });
    // The script stays on disk: the user can still run it by hand.
    expect(existsSync(commandFile("work"))).toBe(true);
  });

  it("launches nothing off macOS and writes no file", async () => {
    addAccount("Work");
    const open = vi.fn(async () => {});
    const result = await launchSignIn("work", { platform: "linux", hostname: () => "h", open });
    expect(result.launched).toBe(false);
    expect(result.command).toContain("antigravity");
    expect(open).not.toHaveBeenCalled();
    expect(existsSync(commandFile("work"))).toBe(false);
  });

  it("refuses Default and unknown accounts", async () => {
    addAccount("Work");
    await expect(launchSignIn(DEFAULT_ACCOUNT_ID, { platform: "darwin", open: async () => {} }))
      .rejects.toThrow(/Default account/);
    await expect(launchSignIn("nope", { platform: "darwin", open: async () => {} }))
      .rejects.toThrow(/Unknown account: nope/);
  });

  it("takes the script with the account when the account is removed", async () => {
    addAccount("Work");
    await launchSignIn("work", { platform: "darwin", open: async () => {} });
    expect(existsSync(commandFile("work"))).toBe(true);

    removeAccount("work");

    expect(existsSync(commandFile("work"))).toBe(false);
  });

  it("quotes a home path that contains a single quote", async () => {
    rmSync(paseoHome, { recursive: true, force: true });
    paseoHome = join(root, "paseo's home");
    process.env.PASEO_HOME = paseoHome;
    addAccount("Work");
    const home = accountHome("work")!;

    const result = await launchSignIn("work", { platform: "darwin", open: async () => {} });

    expect(result.command).toContain(`HOME=${shellQuote(home)}`);
    const script = readFileSync(commandFile("work"), "utf8");
    expect(script).toContain(`export HOME=${shellQuote(home)}`);
    expect(script).toContain(`unlock-keychain -p '' ${shellQuote(accountKeychainPath(home))}`);
    // The quote is escaped, not closed: `'paseo'\''s home'`.
    expect(script).toContain(`paseo'\\''s home/`);
  });
});

describe("shell quoting", () => {
  it("wraps in single quotes and escapes embedded quotes", () => {
    expect(shellQuote("/plain/path")).toBe("'/plain/path'");
    expect(shellQuote("it's")).toBe("'it'\\''s'");
  });

  it("builds the copyable line and the script from the same parts", () => {
    expect(signInCommand("/h", "/bin/agy")).toBe("HOME='/h' '/bin/agy'");
    const script = signInScript("/h", "/bin/agy");
    expect(script).toContain("export HOME='/h'");
    expect(script).toContain(
      "/usr/bin/security unlock-keychain -p '' '/h/Library/Keychains/account.keychain-db' >/dev/null 2>&1",
    );
    expect(script).toContain("exec '/bin/agy'");
  });
});
