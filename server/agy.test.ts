import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgyProcess, buildAgyArgs, locateAgyBinary } from "./agy";
import type { AgyEvent } from "./protocol";

const fakeAgy = fileURLToPath(new URL("./testing/fake-agy.mjs", import.meta.url));
const originalHome = process.env.HOME;
const originalPath = process.env.PATH;
const originalBinary = process.env.PASEO_ANTIGRAVITY_BIN;

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "antigravity-agy-"));
  chmodSync(fakeAgy, 0o755);
});

afterEach(() => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalPath === undefined) delete process.env.PATH;
  else process.env.PATH = originalPath;
  if (originalBinary === undefined) delete process.env.PASEO_ANTIGRAVITY_BIN;
  else process.env.PASEO_ANTIGRAVITY_BIN = originalBinary;
  rmSync(tempDir, { recursive: true, force: true });
});

/** A stand-in `agy` that is executable but, like a real launch, is never run by this lookup. */
function executable(path: string): string {
  writeFileSync(path, "#!/bin/sh\nexit 0\n");
  chmodSync(path, 0o755);
  return path;
}

describe("AgyProcess", () => {
  it("reports a closed stdin instead of raising an unhandled error, then refuses turns", async () => {
    const ready = Promise.withResolvers<void>();
    const reported = Promise.withResolvers<string>();
    const process = new AgyProcess(
      { cwd: tempDir, skipPermissions: false, binary: fakeAgy, env: { FAKE_SCENARIO: "stdin-closed" } },
      {
        onEvent: (event: AgyEvent) => {
          if (event.kind === "init") ready.resolve();
        },
        onStderr: (line) => reported.resolve(line),
        onExit: () => {},
      },
    );
    process.start();
    // The child closed its stdin before reporting init, so both writes below hit a dead pipe.
    await ready.promise;

    await expect(process.writeTurn("hello")).rejects.toThrow(/EPIPE/);
    expect(await reported.promise).toContain("EPIPE");
    await expect(process.writeTurn("again")).rejects.toThrow(/stdin is closed/);

    await process.dispose();
  });
});

describe("buildAgyArgs", () => {
  it("includes --effort, which never rides with --model, and --agent when provided", () => {
    const args = buildAgyArgs({
      cwd: "/test/cwd",
      skipPermissions: false,
      effort: "max",
      agent: "code-reviewer",
    });

    expect(args).not.toContain("--model");
    expect(args).toContain("--effort");
    expect(args[args.indexOf("--effort") + 1]).toBe("max");
    expect(args).toContain("--agent");
    expect(args[args.indexOf("--agent") + 1]).toBe("code-reviewer");
  });
});

describe("locateAgyBinary", () => {
  it("returns an explicit executable path unchanged", () => {
    process.env.PASEO_ANTIGRAVITY_BIN = fakeAgy;

    expect(locateAgyBinary(executable(join(tempDir, "explicit-agy")))).toEqual({
      path: join(tempDir, "explicit-agy"),
      checked: [join(tempDir, "explicit-agy")],
    });
  });

  it("reports an explicit path that is missing or not executable", () => {
    const missing = join(tempDir, "missing-agy");
    const notExecutable = join(tempDir, "plain-agy");
    writeFileSync(notExecutable, "not a program");
    chmodSync(notExecutable, 0o644);

    expect(locateAgyBinary(missing)).toEqual({ path: null, checked: [missing] });
    expect(locateAgyBinary(notExecutable)).toEqual({ path: null, checked: [notExecutable] });
  });

  it("honours PASEO_ANTIGRAVITY_BIN and names it when unusable", () => {
    const missing = join(tempDir, "env-agy");
    process.env.PASEO_ANTIGRAVITY_BIN = missing;

    expect(locateAgyBinary()).toEqual({ path: null, checked: [missing] });

    const present = executable(join(tempDir, "env-agy-present"));
    process.env.PASEO_ANTIGRAVITY_BIN = present;

    expect(locateAgyBinary()).toEqual({ path: present, checked: [present] });
  });

  it.skipIf(process.platform === "win32")(
    "finds the installer's location without PATH or an override",
    () => {
      const home = join(tempDir, "home");
      const bin = join(home, ".local", "bin");
      mkdirSync(bin, { recursive: true });
      const installed = executable(join(bin, "agy"));
      process.env.HOME = home;
      process.env.PATH = "";
      delete process.env.PASEO_ANTIGRAVITY_BIN;

      expect(locateAgyBinary()).toEqual({ path: installed, checked: [installed] });
    },
  );

  it.skipIf(process.platform === "win32")("falls back to agy on PATH", () => {
    const home = join(tempDir, "empty-home");
    mkdirSync(home, { recursive: true });
    const bin = join(tempDir, "bin");
    mkdirSync(bin);
    const onPath = executable(join(bin, "agy"));
    process.env.HOME = home;
    process.env.PATH = bin;
    delete process.env.PASEO_ANTIGRAVITY_BIN;

    expect(locateAgyBinary()).toEqual({
      path: onPath,
      checked: [join(home, ".local", "bin", "agy"), "agy on PATH"],
    });
  });
});
