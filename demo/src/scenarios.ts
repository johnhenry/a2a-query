// Scenario launchers — each sends a real A2A message through the hub and
// registers the resulting TaskHandle on the demo task board. Mounted hooks
// (useTask / useTaskStatus / useTaskArtifacts) drive the handles' loops; no
// explicit result()/subscribe() calls are needed here.

import type { TaskHandle } from "@johnhenry/a2aq";
import { msg, q } from "./hub";
import { taskList } from "./taskList";

const isHandle = (r: unknown): r is TaskHandle =>
  typeof (r as TaskHandle)?.subscribe === "function";

async function launch(agent: string, label: string, text: string): Promise<void> {
  try {
    const reply = await q.sendMessage(agent, msg(text));
    if (isHandle(reply)) taskList.add({ label, agent, handle: reply });
  } catch {
    // Retries exhausted — the fleet chip shows `degraded` with the error.
  }
}

/** Single task: the researcher streams a report's artifact chunks over SSE. */
export const launchResearch = () =>
  launch("researcher", "Research: agent-to-agent protocols", "Survey the state of agent-to-agent protocols");

/** Pauses INPUT_REQUIRED — lands in the approval inbox for a go/no-go. */
export const launchDeploy = () =>
  launch("deployer", "Deploy web-frontend v2.4.1", "Deploy web-frontend v2.4.1 to production");

/** Pauses AUTH_REQUIRED — the human must supply credentials to resume. */
export const launchBilling = () =>
  launch("billing", "Refund invoice INV-1042", "Issue a $250 refund for invoice INV-1042");

/** First delivery drops; the retry (same messageId) recovers. */
export const launchFlaky = () =>
  launch("flaky-runner", "Nightly integration suite", "Run the nightly integration suite");

/** Fan-out burst: hit every agent at once and watch the board light up. */
export const launchBurst = () =>
  Promise.all([
    launchResearch(),
    launchFlaky(),
    launch("flaky-runner", "Rebuild search index", "Rebuild the search index"),
    launchDeploy(),
    launchBilling(),
  ]).then(() => undefined);
