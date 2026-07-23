// 11 · Skill codegen — an AgentCard's skills turned into a typed invocation
// module (the orval / connect-query shape: framework-free sendX helpers, and
// useX hooks over useSkillTask with --hooks). A2A skills declare media modes,
// not parameter schemas, so the helpers honestly take SkillInput
// (string | Part[]) and tag the skill id into message metadata.
// Run: npx tsx examples/11-skill-codegen.ts
//   (CLI equivalent: a2aq-codegen <card-url-or-file> -o skills.ts --hooks)

import { A2AQuery, generateSkillModule, sendSkill, SKILL_METADATA_KEY, type TaskHandle } from "../src/index.js";
import { MockA2AAgent, echoExecutor } from "../src/testing/mockAgent.js";

const mock = new MockA2AAgent(echoExecutor(), {
  name: "travel-agent",
  card: {
    skills: [
      {
        id: "book-flight",
        name: "Book flight",
        description: "Books a flight from a natural-language request.",
        tags: ["travel"],
        examples: ["book SFO to JFK tomorrow morning"],
        inputModes: ["text/plain"],
        outputModes: ["text/plain"],
        securityRequirements: [],
      },
    ],
  },
});

const q = new A2AQuery({ agents: { travel: { url: mock.url, fetchImpl: mock.fetchImpl } }, taskPollMs: 25 });

// ── codegen: card → module source (what `a2aq-codegen --hooks` writes) ───────
const card = await q.card("travel");
const source = generateSkillModule(card, { hooks: true });
console.log("── generated module ──────────────────────────────────────────");
console.log(source.split("\n").slice(0, 24).join("\n"));
console.log(`… (${source.split("\n").length} lines total)\n`);

// ── the generated sendBookFlight() is exactly this call ──────────────────────
const handle = (await sendSkill(q, "travel", "book-flight", "SFO to JFK, tomorrow 9am")) as TaskHandle;
const task = await handle.result();
console.log("result:", handle.artifactText());

// The skill id rode along in message metadata — visible on the wire:
const send = mock.callLog.find((c) => c.method === "SendMessage")?.params as {
  message: { metadata: Record<string, unknown> };
};
console.log(`metadata[${JSON.stringify(SKILL_METADATA_KEY)}]:`, send.message.metadata[SKILL_METADATA_KEY]);
console.log("task state:", task.status?.state);
