import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { JSON_RPC_ERRORS, JsonRpcConnection, JsonRpcError } from "./rpc";

describe("JsonRpcConnection", () => {
  it("correlates request and response with incrementing numeric IDs", async () => {
    const toAgent = new PassThrough();
    const fromAgent = new PassThrough();
    const client = new JsonRpcConnection(fromAgent, toAgent);

    // Read the message the client writes
    const linesPromise = new Promise<string>((resolve) => {
      toAgent.once("data", (chunk: Buffer) => resolve(chunk.toString("utf8")));
    });

    const requestPromise = client.request("testMethod", { foo: "bar" });

    const sentLine = await linesPromise;
    const sentObj = JSON.parse(sentLine.trim());
    expect(sentObj).toEqual({
      jsonrpc: "2.0",
      id: 1,
      method: "testMethod",
      params: { foo: "bar" },
    });

    // Agent replies with result for id 1
    fromAgent.write(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { success: true } }) + "\n");

    const result = await requestPromise;
    expect(result).toEqual({ success: true });

    client.close();
  });

  it("handles incoming agent requests with string IDs and sends back responses", async () => {
    const toAgent = new PassThrough();
    const fromAgent = new PassThrough();
    const client = new JsonRpcConnection(fromAgent, toAgent);

    client.onRequest("agentQuestion", async (params) => {
      const p = params as { query: string };
      return { answer: `Received: ${p.query}` };
    });

    const agentReceived = new Promise<string>((resolve) => {
      toAgent.once("data", (chunk: Buffer) => resolve(chunk.toString("utf8")));
    });

    // Agent sends a request with string id "request-42"
    fromAgent.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: "request-42",
        method: "agentQuestion",
        params: { query: "what is the status?" },
      }) + "\n",
    );

    const replyLine = await agentReceived;
    const replyObj = JSON.parse(replyLine.trim());
    expect(replyObj).toEqual({
      jsonrpc: "2.0",
      id: "request-42",
      result: { answer: "Received: what is the status?" },
    });

    client.close();
  });

  it("responds with METHOD_NOT_FOUND when an unknown request is received", async () => {
    const toAgent = new PassThrough();
    const fromAgent = new PassThrough();
    const client = new JsonRpcConnection(fromAgent, toAgent);

    const agentReceived = new Promise<string>((resolve) => {
      toAgent.once("data", (chunk: Buffer) => resolve(chunk.toString("utf8")));
    });

    fromAgent.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: "req-unknown",
        method: "nonExistentMethod",
      }) + "\n",
    );

    const replyLine = await agentReceived;
    const replyObj = JSON.parse(replyLine.trim());
    expect(replyObj).toEqual({
      jsonrpc: "2.0",
      id: "req-unknown",
      error: {
        code: JSON_RPC_ERRORS.METHOD_NOT_FOUND,
        message: "Method not found: nonExistentMethod",
      },
    });

    client.close();
  });

  it("dispatches notifications without an ID in both directions", async () => {
    const toAgent = new PassThrough();
    const fromAgent = new PassThrough();
    const client = new JsonRpcConnection(fromAgent, toAgent);

    const receivedNotifications: unknown[] = [];
    client.onNotification("session/update", (params) => {
      receivedNotifications.push(params);
    });

    // Incoming notification from agent
    fromAgent.write(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "session/update",
        params: { text: "chunk 1" },
      }) + "\n",
    );

    // Allow event loop to process line
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(receivedNotifications).toEqual([{ text: "chunk 1" }]);

    // Outgoing notification from client
    const agentReceived = new Promise<string>((resolve) => {
      toAgent.once("data", (chunk: Buffer) => resolve(chunk.toString("utf8")));
    });

    client.notify("session/cancel", { sessionId: "s-123" });

    const sentLine = await agentReceived;
    expect(JSON.parse(sentLine.trim())).toEqual({
      jsonrpc: "2.0",
      method: "session/cancel",
      params: { sessionId: "s-123" },
    });

    client.close();
  });

  it("tolerates malformed lines, empty lines, and non-JSON noise", async () => {
    const toAgent = new PassThrough();
    const fromAgent = new PassThrough();
    const client = new JsonRpcConnection(fromAgent, toAgent);

    const reqPromise = client.request("ping");

    // Feed garbage, banners, blank lines
    fromAgent.write("\n");
    fromAgent.write("   \n");
    fromAgent.write("Welcome to Antigravity CLI v1.5.0\n");
    fromAgent.write("{corrupt json payload\n");
    fromAgent.write("null\n");
    fromAgent.write("12345\n");

    // Now send the valid response
    fromAgent.write(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "pong" }) + "\n");

    const result = await reqPromise;
    expect(result).toBe("pong");

    client.close();
  });

  it("rejects in-flight pending requests when connection is closed or stream errors", async () => {
    const toAgent = new PassThrough();
    const fromAgent = new PassThrough();
    const client = new JsonRpcConnection(fromAgent, toAgent);

    const req1 = client.request("call1");
    const req2 = client.request("call2");

    client.close(new Error("Connection aborted by test"));

    await expect(req1).rejects.toThrow("Connection aborted by test");
    await expect(req2).rejects.toThrow("Connection aborted by test");

    // Attempting a request after close should reject immediately
    await expect(client.request("call3")).rejects.toThrow("Connection aborted by test");
  });

  it("converts JSON-RPC error responses to JsonRpcError instances", async () => {
    const toAgent = new PassThrough();
    const fromAgent = new PassThrough();
    const client = new JsonRpcConnection(fromAgent, toAgent);

    const reqPromise = client.request("failMethod");

    fromAgent.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        error: {
          code: -32001,
          message: "Custom failure message",
          data: { detail: "xyz" },
        },
      }) + "\n",
    );

    await expect(reqPromise).rejects.toThrow("Custom failure message");
    try {
      await reqPromise;
    } catch (err) {
      expect(err).toBeInstanceOf(JsonRpcError);
      const rpcErr = err as JsonRpcError;
      expect(rpcErr.code).toBe(-32001);
      expect(rpcErr.data).toEqual({ detail: "xyz" });
    }

    client.close();
  });

  it("safely drops write failures without unhandled promise rejections when agent closes mid-request", async () => {
    const toAgent = new PassThrough();
    const fromAgent = new PassThrough();
    const client = new JsonRpcConnection(fromAgent, toAgent);

    client.onRequest("slowQuestion", async () => {
      // Simulate handler throwing when stream is broken
      throw new Error("Handler failed");
    });

    // Destroy output stream so any respond or respondError will fail
    toAgent.destroy(new Error("Stream destroyed by agent death"));

    // Send an incoming request line from the dying agent
    fromAgent.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: "die-1",
        method: "slowQuestion",
        params: {},
      }) + "\n",
    );

    // Also send an incoming request for a method that does not exist
    fromAgent.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: "die-2",
        method: "missingMethod",
        params: {},
      }) + "\n",
    );

    // Wait a tick to ensure no unhandled promise rejection escapes
    await new Promise((resolve) => setTimeout(resolve, 20));

    client.close();
  });
});
