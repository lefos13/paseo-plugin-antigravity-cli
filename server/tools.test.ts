import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseAgyLine, type AgyToolInfo } from "./protocol";
import { mapToolDetail, shorten, snapshotDiff, summarizeParameters } from "./tools";

const fixturesDir = fileURLToPath(new URL("../fixtures", import.meta.url));
const CWD = "/workspace/project";

function detail(name: string, info: AgyToolInfo) {
  return mapToolDetail(name, info, CWD);
}

/**
 * The captured edit run (fixtures/06-edit.ndjson) is the ground truth for what the stream carries:
 * `replace_file_content` arrives with `TargetFile` and nothing else. agy's own trajectory for the
 * same call holds `TargetContent`/`ReplacementContent`/`StartLine`/`EndLine`, which is what the
 * hand-built parameter sets below exercise.
 */
function capturedToolSteps() {
  const raw = readFileSync(`${fixturesDir}/06-edit.ndjson`, "utf8");
  const steps = raw
    .split("\n")
    .flatMap((line) => (line.trim().length === 0 ? [] : [parseAgyLine(line)]))
    .flatMap((event) => (event?.kind === "step_update" && event.step.step_type === "tool" ? [event.step] : []));
  const init = parseAgyLine(raw.split("\n")[0] ?? "");
  return { steps, cwd: init?.kind === "init" ? (init.cwd ?? CWD) : CWD };
}

describe("mapToolDetail from the captured edit run", () => {
  it("maps the captured steps to native rows without inventing content", () => {
    const { steps, cwd } = capturedToolSteps();
    const read = steps.find((step) => step.tool_name === "view_file");
    const edit = steps.find((step) => step.state === "DONE" && step.tool_name === "replace_file_content");

    expect(mapToolDetail("view_file", read?.tool_info, cwd)).toEqual({
      type: "read",
      filePath: `${cwd}/hello.txt`,
    });
    // The stream reports the target file only, so the row names the file and claims no diff text.
    expect(mapToolDetail("replace_file_content", edit?.tool_info, cwd)).toEqual({
      type: "edit",
      filePath: `${cwd}/hello.txt`,
    });
  });

  it("maps manage_task steps to shell tool calls", () => {
    expect(
      detail("manage_task", {
        name: "manage_task",
        parameters: { Action: "status", TaskId: "task-123" },
        output: "Task status: RUNNING",
      }),
    ).toEqual({
      type: "shell",
      command: "status task-123",
      cwd: CWD,
      output: "Task status: RUNNING",
    });
  });
});

describe("mapToolDetail edits", () => {
  it("carries the old and new text of a single replacement", () => {
    expect(
      detail("replace_file_content", {
        name: "replace_file_content",
        parameters: {
          TargetFile: "/workspace/project/hello.txt",
          TargetContent: "hello world",
          ReplacementContent: "bye world",
        },
      }),
    ).toEqual({
      type: "edit",
      filePath: "/workspace/project/hello.txt",
      oldString: "hello world",
      newString: "bye world",
    });
  });

  it("renders one hunk per chunk of a multi-chunk edit", () => {
    const mapped = mapToolDetail(
      "multi_replace_file_content",
      {
        name: "multi_replace_file_content",
        parameters: {
          TargetFile: "/workspace/project/hello.txt",
          ReplacementChunks: [
            // A chunk that grows the file shifts the new-file numbering of the chunks after it.
            { StartLine: 1, EndLine: 1, TargetContent: "alpha", ReplacementContent: "ALPHA\nsecond" },
            {
              StartLine: 2,
              EndLine: 2,
              TargetContent: "beta\n",
              ReplacementContent: "BETA\n",
            },
          ],
        },
      },
      CWD,
    );

    expect(mapped).toMatchObject({ type: "edit", filePath: "/workspace/project/hello.txt" });
    expect(mapped.type === "edit" ? mapped.unifiedDiff : undefined).toBe(
      [
        "--- a/hello.txt",
        "+++ b/hello.txt",
        "@@ -1,1 +1,2 @@",
        "-alpha",
        "+ALPHA",
        "+second",
        "@@ -2,1 +3,1 @@",
        "-beta",
        "+BETA",
      ].join("\n"),
    );
  });

  it("falls back to the parameters instead of throwing on chunks it cannot trust", () => {
    const filePath = "/workspace/project/hello.txt";
    const malformed: Array<unknown> = [
      "not an array",
      [],
      [{ TargetContent: "alpha" }],
      [{ StartLine: 1, EndLine: 1, TargetContent: 5, ReplacementContent: "ALPHA" }],
      [{ StartLine: 0, EndLine: 1, TargetContent: "alpha", ReplacementContent: "ALPHA" }],
      [null],
    ];

    for (const ReplacementChunks of malformed) {
      const mapped = detail("multi_replace_file_content", {
        name: "multi_replace_file_content",
        parameters: { TargetFile: filePath, ReplacementChunks },
      });
      expect(mapped).toMatchObject({ type: "plain_text", label: "multi_replace_file_content" });
      expect(mapped.type === "edit" ? mapped.unifiedDiff : undefined).toBeUndefined();
    }
  });

  it("maps a whole-file write to its content", () => {
    expect(
      detail("write_to_file", {
        name: "write_to_file",
        parameters: { TargetFile: "/workspace/project/notes.txt", CodeContent: "alpha\n" },
      }),
    ).toEqual({ type: "write", filePath: "/workspace/project/notes.txt", content: "alpha\n" });
  });
});

describe("mapToolDetail shells and MCP", () => {
  it("shows a tracked command's output for command_status", () => {
    expect(
      detail("command_status", {
        name: "command_status",
        parameters: { CommandId: "cmd_7" },
        output: "still running",
      }),
    ).toEqual({ type: "shell", command: "cmd_7", cwd: CWD, output: "still running" });
  });

  it("labels an MCP call with its server and tool", () => {
    expect(
      detail("call_mcp_tool", {
        name: "call_mcp_tool",
        parameters: { ServerName: "paseo", ToolName: "list_agents", Arguments: { limit: 5 } },
      }),
    ).toEqual({ type: "plain_text", label: "paseo/list_agents", text: "limit=5" });

    expect(
      detail("call_mcp_tool", {
        name: "call_mcp_tool",
        parameters: { ServerName: "paseo", ToolName: "list_agents" },
        output: "3 agents",
      }),
    ).toEqual({ type: "plain_text", label: "paseo/list_agents", text: "3 agents" });
  });
});

describe("mapToolDetail existing mappings", () => {
  it("keeps shell, read, search, and fetch detail shapes", () => {
    expect(
      detail("run_command", { name: "run_command", parameters: { CommandLine: "ls -la" } }),
    ).toEqual({ type: "shell", command: "ls -la", cwd: CWD, output: undefined });
    expect(
      detail("grep_search", { name: "grep_search", parameters: { Query: "hello" }, output: "1 match" }),
    ).toEqual({ type: "search", query: "hello", toolName: "grep", content: "1 match" });
    expect(
      detail("find_by_name", { name: "find_by_name", parameters: { Pattern: "*.ts" } }),
    ).toEqual({ type: "search", query: "*.ts", toolName: "glob", content: undefined });
    expect(
      detail("read_url_content", { name: "read_url_content", parameters: { Url: "https://x.dev" } }),
    ).toEqual({ type: "fetch", url: "https://x.dev", result: undefined });
    expect(detail("unknown_tool", { name: "unknown_tool", parameters: { a: 1, b: "two" } })).toEqual({
      type: "plain_text",
      label: "unknown_tool",
      text: "a=1, b=two",
    });
  });
});

describe("summarizeParameters", () => {
  it("caps the key count and shortens a long value", () => {
    expect(summarizeParameters({})).toBe("");
    expect(summarizeParameters({ a: 1, b: 2, c: 3, d: 4, e: 5 })).toBe("a=1, b=2, c=3, d=4, …");
    expect(summarizeParameters({ text: "x".repeat(200) })).toBe(`text=${"x".repeat(80)}…`);
    expect(shorten(undefined)).toBe("undefined");
  });
});

describe("snapshotDiff", () => {
  const FILE = "/workspace/project/hello.txt";
  const CWD = "/workspace/project";

  function hunksOf(diff: string | null): string[] {
    return (diff ?? "").split("\n").filter((line) => line.startsWith("@@"));
  }

  it("describes a replacement, an insertion, and a deletion", () => {
    expect(snapshotDiff(FILE, "hello world\n", "bye world\n", CWD)).toBe(
      ["--- a/hello.txt", "+++ b/hello.txt", "@@ -1,1 +1,1 @@", "-hello world", "+bye world"].join(
        "\n",
      ),
    );
    expect(snapshotDiff(FILE, "a\nb\n", "a\nx\nb\n", CWD)).toBe(
      ["--- a/hello.txt", "+++ b/hello.txt", "@@ -1,2 +1,3 @@", " a", "+x", " b"].join("\n"),
    );
    expect(snapshotDiff(FILE, "a\nx\nb\n", "a\nb\n", CWD)).toBe(
      ["--- a/hello.txt", "+++ b/hello.txt", "@@ -1,3 +1,2 @@", " a", "-x", " b"].join("\n"),
    );
  });

  it("keeps changes within six unchanged lines in one hunk and splits wider gaps", () => {
    const lines = Array.from({ length: 20 }, (_, index) => `line ${index + 1}`);

    const near = [...lines];
    near[1] = "CHANGED 2";
    near[8] = "CHANGED 9";
    expect(hunksOf(snapshotDiff(FILE, `${lines.join("\n")}\n`, `${near.join("\n")}\n`, CWD))).toEqual([
      "@@ -1,12 +1,12 @@",
    ]);

    const far = [...lines];
    far[1] = "CHANGED 2";
    far[17] = "CHANGED 18";
    expect(hunksOf(snapshotDiff(FILE, `${lines.join("\n")}\n`, `${far.join("\n")}\n`, CWD))).toEqual([
      "@@ -1,5 +1,5 @@",
      "@@ -15,6 +15,6 @@",
    ]);
  });

  it("keeps a last line that has no trailing newline", () => {
    expect(snapshotDiff(FILE, "hello world", "bye world", CWD)).toBe(
      ["--- a/hello.txt", "+++ b/hello.txt", "@@ -1,1 +1,1 @@", "-hello world", "+bye world"].join(
        "\n",
      ),
    );
  });

  it("reports nothing for an unchanged file", () => {
    expect(snapshotDiff(FILE, "hello world\n", "hello world\n", CWD)).toBeNull();
    expect(snapshotDiff(FILE, "", "", CWD)).toBeNull();
    expect(snapshotDiff(FILE, "a\nb", "a\nb", CWD)).toBeNull();
  });

  it("describes a file that did not exist yet", () => {
    expect(snapshotDiff(FILE, "", "alpha\n", CWD)).toBe(
      ["--- a/hello.txt", "+++ b/hello.txt", "@@ -0,0 +1,1 @@", "+alpha"].join("\n"),
    );
  });

  it("names a file outside the workspace by its absolute path", () => {
    expect(snapshotDiff("/tmp/other/hello.txt", "a\n", "b\n", CWD)?.split("\n").slice(0, 2)).toEqual([
      "--- /tmp/other/hello.txt",
      "+++ /tmp/other/hello.txt",
    ]);
  });
});
