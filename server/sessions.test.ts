import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_ACCOUNT_ID, addAccount } from "./accounts";
import { listConversations } from "./sessions";
import { writeConversationDb, type ConversationFixture } from "./testing/conversation-db";
import { installFakeSecurity, type FakeSecurity } from "./testing/fake-security";

const originalHome = process.env.HOME;
const originalPaseoHome = process.env.PASEO_HOME;

let root: string;
/** The real home: Default's index lives here, and every account shadow home mirrors the entry. */
let home: string;
let paseoHome: string;
let cwd: string;
/** Accounts are added here, so the shadow-home sync must never reach the real `/usr/bin/security`. */
let security: FakeSecurity;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "antigravity-sessions-"));
  home = join(root, "home");
  paseoHome = join(root, "paseo-home");
  cwd = join(home, "workspace");
  mkdirSync(cwd, { recursive: true });
  // The CLI's index lives under the home directory, which is how a test repoints it; the accounts
  // themselves are addressed by PASEO_HOME so nothing touches the developer's own data.
  process.env.HOME = home;
  process.env.PASEO_HOME = paseoHome;
  security = installFakeSecurity("linux");
});

afterEach(() => {
  security.restore();
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalPaseoHome === undefined) delete process.env.PASEO_HOME;
  else process.env.PASEO_HOME = originalPaseoHome;
  rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});

/** What a row's persistence must carry: the conversation and the account whose CLI wrote it. */
function persistence(conversationId: string, accountId = DEFAULT_ACCOUNT_ID) {
  return { version: 1, data: { conversationId, accountId } };
}

/** Where `server/accounts.ts` puts an account's shadow home, and with it its own index. */
function shadowHome(id: string): string {
  return join(paseoHome, "plugin-data", "antigravity-cli", "accounts", id, "home");
}

function conversation(overrides: Partial<ConversationFixture> = {}): ConversationFixture {
  return {
    conversationId: "11111111-1111-1111-1111-111111111111",
    title: "Replace Word In File",
    preview: "In hello.txt change the word hello to bye.",
    lastModifiedTime: "2026-09-23 13:31:32.28859+00:00",
    workspacePaths: [cwd],
    ...overrides,
  };
}

describe("listConversations", () => {
  it("lists the newest conversation first with its title, preview and timestamp", () => {
    writeConversationDb(home, [
      conversation({ conversationId: "older", lastModifiedTime: "2026-09-23 09:00:00+00:00" }),
      conversation({
        conversationId: "newest",
        title: "",
        preview: "Explain the streaming protocol",
        lastModifiedTime: "2026-09-23 15:45:49.636929+00:00",
      }),
    ]);

    expect(listConversations({})).toEqual([
      {
        persistence: persistence("newest"),
        cwd,
        description: "Explain the streaming protocol",
        updatedAt: "2026-09-23T15:45:49.636Z",
      },
      {
        persistence: persistence("older"),
        cwd,
        title: "Replace Word In File",
        description: "In hello.txt change the word hello to bye.",
        updatedAt: "2026-09-23T09:00:00.000Z",
      },
    ]);
  });

  it("keeps only the conversations of the requested workspace", () => {
    const other = join(home, "other-workspace");
    mkdirSync(other, { recursive: true });
    writeConversationDb(home, [
      conversation({ conversationId: "here" }),
      conversation({ conversationId: "elsewhere", workspacePaths: [other] }),
      // A conversation with no workspace cannot belong to any workspace request.
      conversation({ conversationId: "orphan", workspacePaths: [] }),
      // Subagent runs are not conversations a user can open.
      conversation({ conversationId: "subagent", parentConversationId: "here" }),
    ]);

    expect(listConversations({ cwd }).map((session) => session.persistence)).toEqual([
      persistence("here"),
    ]);
    // Without a cwd filter the workspace-less one is still listed.
    expect(listConversations({}).map((session) => session.persistence)).toEqual([
      persistence("here"),
      persistence("elsewhere"),
      persistence("orphan"),
    ]);
  });

  it("filters by a case-insensitive substring of the title or the preview", () => {
    writeConversationDb(home, [
      conversation({ conversationId: "a", title: "Fix the flaky test" }),
      conversation({ conversationId: "b", title: "Something else", preview: "The FLAKY part" }),
      conversation({ conversationId: "c", title: "Unrelated", preview: "nothing to match" }),
    ]);

    expect(listConversations({ query: "flaky" }).map((session) => session.persistence)).toEqual([
      persistence("a"),
      persistence("b"),
    ]);
    expect(listConversations({ query: "no such text" })).toEqual([]);
  });

  it("honors the limit", () => {
    writeConversationDb(home, [
      conversation({ conversationId: "one", lastModifiedTime: "2026-09-23 12:00:01+00:00" }),
      conversation({ conversationId: "two", lastModifiedTime: "2026-09-23 12:00:02+00:00" }),
      conversation({ conversationId: "three", lastModifiedTime: "2026-09-23 12:00:03+00:00" }),
    ]);

    expect(listConversations({ limit: 2 }).map((session) => session.persistence)).toEqual([
      persistence("three"),
      persistence("two"),
    ]);
  });

  it("returns nothing, and logs no fault, when the database is missing", () => {
    // No index at all is a normal state: a fresh install, or an account whose CLI has not run yet.
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});

    expect(listConversations({ cwd })).toEqual([]);
    expect(logged).not.toHaveBeenCalled();
  });

  it("returns nothing when the database is corrupt", () => {
    const path = writeConversationDb(home, [conversation()]);
    writeFileSync(path, "this is not a database");
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});

    expect(listConversations({ cwd })).toEqual([]);
    expect(logged).toHaveBeenCalled();
  });

  it("returns nothing when the table has drifted", () => {
    // A future agy could rename the table; an empty list is the only sane answer.
    const path = join(home, ".gemini", "antigravity-cli", "conversation_summaries.db");
    mkdirSync(join(home, ".gemini", "antigravity-cli"), { recursive: true });
    const db = new DatabaseSync(path);
    db.exec("create table something_else (id text)");
    db.close();
    vi.spyOn(console, "error").mockImplementation(() => {});

    expect(listConversations({})).toEqual([]);
  });

  it("leaves the database untouched", () => {
    const path = writeConversationDb(home, [conversation()]);
    const before = readDatabaseBytes(path);

    listConversations({ cwd });

    expect(readDatabaseBytes(path)).toEqual(before);
  });
});

describe("accounts", () => {
  it("merges every account's index, newest first, each tagged with its account", () => {
    writeConversationDb(home, [
      conversation({
        conversationId: "default-old",
        lastModifiedTime: "2026-09-23 09:00:00+00:00",
      }),
    ]);
    addAccount("Work");
    // The account's own index, where its CLI writes it: under the shadow home's real `.gemini`.
    writeConversationDb(shadowHome("work"), [
      conversation({
        conversationId: "work-new",
        lastModifiedTime: "2026-09-23 15:00:00+00:00",
      }),
      conversation({
        conversationId: "work-old",
        lastModifiedTime: "2026-09-23 12:00:00+00:00",
      }),
      // A conversation of a workspace this list is not asked about: filtered like any other.
      conversation({
        conversationId: "work-elsewhere",
        lastModifiedTime: "2026-09-23 08:00:00+00:00",
        workspacePaths: [join(home, "elsewhere")],
      }),
    ]);

    // The newest row is `work`'s, so the merge is by time and not by account.
    expect(listConversations({}).map((session) => session.persistence)).toEqual([
      persistence("work-new", "work"),
      persistence("work-old", "work"),
      persistence("default-old"),
      persistence("work-elsewhere", "work"),
    ]);
    expect(listConversations({ cwd }).map((session) => session.persistence)).toEqual([
      persistence("work-new", "work"),
      persistence("work-old", "work"),
      persistence("default-old"),
    ]);
    // The limit cuts across accounts, which only a merged ordering can honor.
    expect(listConversations({ limit: 2 }).map((session) => session.persistence)).toEqual([
      persistence("work-new", "work"),
      persistence("work-old", "work"),
    ]);
  });

  it("contributes nothing, and logs no fault, for an account with no index yet", () => {
    writeConversationDb(home, [conversation({ conversationId: "default-only" })]);
    addAccount("Fresh");
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});

    expect(listConversations({}).map((session) => session.persistence)).toEqual([
      persistence("default-only"),
    ]);
    expect(logged).not.toHaveBeenCalled();
  });

  it("still lists the other accounts when one index is unreadable", () => {
    writeConversationDb(home, [conversation({ conversationId: "default-only" })]);
    addAccount("Broken");
    const path = writeConversationDb(shadowHome("broken"), [conversation()]);
    writeFileSync(path, "this is not a database");
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});

    expect(listConversations({}).map((session) => session.persistence)).toEqual([
      persistence("default-only"),
    ]);
    expect(logged).toHaveBeenCalledWith(expect.stringContaining("account broken"));
  });
});

/** Raw file bytes, plus the WAL if the CLI keeps one: reading through sqlite could itself write. */
function readDatabaseBytes(path: string): Buffer {
  const wal = `${path}-wal`;
  return Buffer.concat([readFileSync(path), existsSync(wal) ? readFileSync(wal) : Buffer.alloc(0)]);
}
