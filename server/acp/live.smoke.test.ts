import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AgyAcpClient } from "./client";

/**
 * Opt-in live smoke test against a real `agy acp` binary.
 *
 * ONLY executed when AGY_LIVE=1 is set in the environment.
 * Do NOT run as part of normal CI or development test suites,
 * as real runs consume user quota and create conversations in history.
 */
describe.skipIf(!process.env.AGY_LIVE)("live agy acp smoke test", () => {
  it("initializes, starts a session, and prompts agy acp", async () => {
    const smokeDir = mkdtempSync(join(tmpdir(), "agy-smoke-test-"));
    const client = new AgyAcpClient({
      cwd: smokeDir,
    });

    let responseText = "";
    client.on("update", (update) => {
      if (
        update.sessionUpdate === "agent_message_chunk" &&
        "content" in update &&
        update.content.type === "text"
      ) {
        responseText += update.content.text;
      }
    });

    try {
      const init = await client.initialize();
      expect(init.protocolVersion).toBe(1);

      const session = await client.newSession({
        cwd: smokeDir,
      });
      expect(session.sessionId).toBeDefined();
      console.log("AGY_LIVE session", session.sessionId);

      const promptResult = await client.prompt([
        { type: "text", text: "Respond with the word 'HELLO_ACP' and nothing else." },
      ]);
      expect(promptResult.stopReason).toBe("end_turn");
      expect(responseText).toContain("HELLO_ACP");

      await client.closeSession();
    } finally {
      await client.close();
      rmSync(smokeDir, { recursive: true, force: true });
    }
  }, 120_000);
});
