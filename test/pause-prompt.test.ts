// The testing executors can carry the question the agent is asking when it pauses, so an approval
// UI has something to show. Before this, the status message of an INPUT_REQUIRED / AUTH_REQUIRED
// pause was always absent and the demo's approval inbox read "(no prompt text)".

import { describe, expect, it } from "vitest";
import { InteractionBroker, partText, type InputDecision, type TaskHandle } from "../src/index.js";
import { askAuthThenEchoExecutor, askThenEchoExecutor } from "../src/testing/mockAgent.js";
import { setup, msg, until } from "./helpers.js";

const promptOf = (payload: unknown): string =>
  ((payload as { status?: { message?: { parts?: Parameters<typeof partText>[0][] } } }).status?.message?.parts ?? [])
    .map((p) => partText(p) ?? "")
    .join("");

describe("pause prompt", () => {
  it("INPUT_REQUIRED carries the configured prompt in the paused task's status message", async () => {
    const broker = new InteractionBroker<InputDecision>();
    const { q } = setup(askThenEchoExecutor({ prompt: "Ship v2.4.1 to production?" }), broker);
    const handle = (await q.sendMessage("a1", msg("deploy"))) as TaskHandle;
    handle.result().catch(() => {});
    await until(() => broker.list().length > 0);
    expect(broker.list()[0]?.type).toBe("input-required");
    expect(promptOf(broker.list()[0]?.payload)).toBe("Ship v2.4.1 to production?");
  });

  it("AUTH_REQUIRED carries the configured prompt too", async () => {
    const broker = new InteractionBroker<InputDecision>();
    const { q } = setup(askAuthThenEchoExecutor({ prompt: "Provide a billing API token." }), broker);
    const handle = (await q.sendMessage("a1", msg("refund"))) as TaskHandle;
    handle.result().catch(() => {});
    await until(() => broker.list().length > 0);
    expect(broker.list()[0]?.type).toBe("auth-required");
    expect(promptOf(broker.list()[0]?.payload)).toBe("Provide a billing API token.");
  });

  it("without a prompt the pause is unchanged (no status message)", async () => {
    const broker = new InteractionBroker<InputDecision>();
    const { q } = setup(askThenEchoExecutor(), broker);
    const handle = (await q.sendMessage("a1", msg("start"))) as TaskHandle;
    handle.result().catch(() => {});
    await until(() => broker.list().length > 0);
    expect(promptOf(broker.list()[0]?.payload)).toBe("");
  });
});
