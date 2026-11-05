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
    const client = new AgyAcpClient({
      cwd: process.cwd(),
    });

    try {
      const init = await client.initialize();
      expect(init.protocolVersion).toBe(1);

      const session = await client.newSession({
        cwd: process.cwd(),
      });
      expect(session.sessionId).toBeDefined();

      const promptResult = await client.prompt([
        { type: "text", text: "Respond with the word 'HELLO_ACP' and nothing else." },
      ]);
      expect(promptResult.stopReason).toBe("end_turn");

      await client.closeSession();
    } finally {
      await client.close();
    }
  });
});
