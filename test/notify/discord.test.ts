import { describe, expect, test } from "bun:test";
import { approvalButtons, approvalCustomId, isAuthorized, parseCustomId, resolveButtonPress, retryDelayMs, DiscordChannel } from "../../src/notify/discord";
import { defaultSettings } from "../../src/core/db";

const OWNER = "123456789012345678";

const recordingControl = () => {
  const seen: string[] = [];
  return {
    seen,
    approve: async (id: number, via: string) => (seen.push(`approve ${id} ${via}`), { ok: true, detail: "Registered" }),
    skip: async (id: number, via: string) => (seen.push(`skip ${id} ${via}`), { ok: true, detail: "Skipped" }),
  };
};

describe("authorization", () => {
  test.each([
    [OWNER, OWNER, true],
    ["999999999999999999", OWNER, false],
    [OWNER, null, false],
    [OWNER, "", false],
    [undefined, OWNER, false],
  ])("isAuthorized(%p, %p) is %p", (user, owner, expected) => {
    expect(isAuthorized(user, owner)).toBe(expected);
  });

  test("unauthorized or malformed presses never reach the control api", async () => {
    const control = recordingControl();
    expect(await resolveButtonPress({ customId: "approve:5", userId: "1" }, OWNER, control)).toEqual({ kind: "unauthorized" });
    expect(await resolveButtonPress({ customId: "approve:5", userId: OWNER }, null, control)).toEqual({ kind: "unauthorized" });
    expect(await resolveButtonPress({ customId: "drop:6", userId: OWNER }, OWNER, control)).toEqual({ kind: "invalid" });
    expect(control.seen).toEqual([]);
  });

  test("authorized presses call the matching action, and control errors become a failed result", async () => {
    const control = recordingControl();
    expect(await resolveButtonPress({ customId: "approve:5", userId: OWNER }, OWNER, control)).toEqual({
      kind: "result",
      action: "approve",
      approvalId: 5,
      ok: true,
      text: "Registered",
    });
    await resolveButtonPress({ customId: "skip:6", userId: OWNER }, OWNER, control);
    expect(control.seen).toEqual(["approve 5 discord", "skip 6 discord"]);

    const throwing = { ...control, approve: async () => Promise.reject(new Error("boom")) };
    expect(await resolveButtonPress({ customId: "approve:1", userId: OWNER }, OWNER, throwing)).toMatchObject({ kind: "result", ok: false });
  });
});

describe("custom ids", () => {
  test("buttons carry ids that round trip through the parser", () => {
    const ids = approvalButtons(9).toJSON().components.map(c => (c as { custom_id: string }).custom_id);
    expect(ids.map(parseCustomId)).toEqual([
      { action: "approve", approvalId: 9 },
      { action: "skip", approvalId: 9 },
    ]);
    expect(parseCustomId(approvalCustomId("approve", 42))).toEqual({ action: "approve", approvalId: 42 });
  });

  test.each(["", "approve", "approve:", "approve:0", "approve:-1", "approve:1.5", "approve:1x", "skip:1:2", "APPROVE:1", " approve:1", "drop:3"])(
    "rejects %p",
    id => {
      expect(parseCustomId(id)).toBeNull();
    },
  );
});

test("retry backoff starts at 15 s, doubles, and caps", () => {
  expect([0, 1, 2].map(retryDelayMs)).toEqual([15_000, 30_000, 60_000]);
  expect(retryDelayMs(20)).toBe(retryDelayMs(30));
  expect(retryDelayMs(20)).toBeLessThan(retryDelayMs(0) * 2 ** 20);
});

test("no token means off, and send refuses", async () => {
  const channel = new DiscordChannel({ settings: () => defaultSettings(), control: () => null, log: () => {} });
  await channel.start();
  expect(channel.status().state).toBe("off");
  await expect(channel.send({ title: "t", body: "b", severity: "info", tag: "t" })).rejects.toThrow();
});
