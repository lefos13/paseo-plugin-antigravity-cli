import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgyProcess } from "./agy";
import type { AgyEvent } from "./protocol";

const fakeAgy = fileURLToPath(new URL("./testing/fake-agy.mjs", import.meta.url));

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "antigravity-agy-"));
  chmodSync(fakeAgy, 0o755);
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

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
  it("includes --effort, which never rides with --model, and --agent when provided", async () => {
    const { buildAgyArgs } = await import("./agy");
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
