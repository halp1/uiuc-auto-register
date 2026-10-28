import { describe, expect, test } from "bun:test";
import {
  approvalButtons,
  approvalCustomId,
  describeDiscordError,
  isAuthorized,
  parseCustomId,
  resolveButtonPress,
  retryDelayMs,
  slashCommands,
  DiscordChannel,
  MAX_RETRY_MS,
} from "../../src/notify/discord";
import { defaultSettings } from "../../src/core/db";

const OWNER = "123456789012345678";

describe("authorization", () => {
  test("only the configured owner is authorized", () => {
    expect(isAuthorized(OWNER, OWNER)).toBe(true);
    expect(isAuthorized("999999999999999999", OWNER)).toBe(false);
    expect(isAuthorized(OWNER, null)).toBe(false);
    expect(isAuthorized(OWNER, "")).toBe(false);
    expect(isAuthorized(undefined, OWNER)).toBe(false);
  });

  test("unauthorized button presses never reach the control api", async () => {
    let calls = 0;
    const control = {
      approve: async () => (calls++, { ok: true, detail: "Registered" }),
      skip: async () => (calls++, { ok: true, detail: "Skipped" }),
    };
    const outcome = await resolveButtonPress({ customId: "approve:5", userId: "1" }, OWNER, control);
    expect(outcome).toEqual({ kind: "unauthorized" });
    expect(calls).toBe(0);
  });

  test("authorized presses call the matching action", async () => {
    const seen: string[] = [];
    const control = {
      approve: async (id: number, via: string) => (seen.push(`approve ${id} ${via}`), { ok: true, detail: "Registered for CS 225" }),
      skip: async (id: number, via: string) => (seen.push(`skip ${id} ${via}`), { ok: true, detail: "Skipped" }),
    };
    expect(await resolveButtonPress({ customId: "approve:5", userId: OWNER }, OWNER, control)).toEqual({
      kind: "result",
      action: "approve",
      approvalId: 5,
      ok: true,
      text: "Registered for CS 225",
    });
    await resolveButtonPress({ customId: "skip:6", userId: OWNER }, OWNER, control);
    expect(seen).toEqual(["approve 5 discord", "skip 6 discord"]);
    expect(await resolveButtonPress({ customId: "drop:6", userId: OWNER }, OWNER, control)).toEqual({ kind: "invalid" });
  });

  test("control errors become a failed result instead of throwing", async () => {
    const control = {
      approve: async () => {
        throw new Error("boom");
      },
      skip: async () => ({ ok: true, detail: "" }),
    };
    const outcome = await resolveButtonPress({ customId: "approve:1", userId: OWNER }, OWNER, control);
    expect(outcome).toMatchObject({ kind: "result", ok: false, text: "Failed: boom" });
  });
});

describe("custom ids", () => {
  test("round trip", () => {
    expect(parseCustomId(approvalCustomId("approve", 42))).toEqual({ action: "approve", approvalId: 42 });
    expect(parseCustomId(approvalCustomId("skip", 1))).toEqual({ action: "skip", approvalId: 1 });
  });

  test("rejects anything else", () => {
    for (const id of ["", "approve", "approve:", "approve:0", "approve:-1", "approve:1.5", "approve:1x", "skip:1:2", "APPROVE:1", " approve:1", "drop:3"]) {
      expect(parseCustomId(id)).toBeNull();
    }
  });

  test("buttons use the agreed ids, labels and styles", () => {
    const row = approvalButtons(9).toJSON();
    expect(row.components).toEqual([
      expect.objectContaining({ custom_id: "approve:9", label: "Register", style: 3 }),
      expect.objectContaining({ custom_id: "skip:9", label: "Skip", style: 2 }),
    ]);
  });
});

describe("commands and errors", () => {
  test("slash commands allow bot DMs", () => {
    const json = slashCommands().map(command => command.toJSON());
    expect(json.map(c => c.name)).toEqual(["status", "pause", "resume"]);
    for (const command of json) {
      expect(command.contexts).toContain(1); // BotDM
      expect(command.integration_types).toContain(0); // GuildInstall
    }
  });

  test("errors read as plain sentences", () => {
    expect(describeDiscordError({ code: "TokenInvalid", message: "An invalid token was provided." })).toContain("rejected the bot token");
    expect(describeDiscordError({ code: 50007, status: 403, message: "Cannot send messages to this user" })).toContain("share a server");
  });

  test("retry backoff caps at ten minutes", () => {
    expect(retryDelayMs(0)).toBe(15_000);
    expect(retryDelayMs(20)).toBe(MAX_RETRY_MS);
  });

  test("no token means off, and send fails with a readable message", async () => {
    const channel = new DiscordChannel({ settings: () => defaultSettings(), control: () => null, log: () => {} });
    await channel.start();
    expect(channel.status().state).toBe("off");
    await expect(channel.send({ title: "t", body: "b", severity: "info", tag: "t" })).rejects.toThrow("Discord is not connected");
  });
});
