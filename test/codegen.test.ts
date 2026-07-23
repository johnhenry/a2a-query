// Skill codegen — golden fixtures, generated-module behavior over the real
// wire, identifier hygiene, and the CLI (in-process via runCodegenCli).

import { describe, it, expect } from "vitest";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentCard } from "@a2a-js/sdk";
import { A2AQuery, SKILL_METADATA_KEY, generateSkillModule, type TaskHandle } from "../src/index.js";
import { runCodegenCli } from "../src/codegen/cli.js";
import { MockA2AAgent, echoExecutor } from "../src/testing/mockAgent.js";
import { artifactText, demoSkills } from "./helpers.js";
import { sendBookFlight, send2faReset, skills } from "./generated/demo-skills.js";

const demoCard = {
  name: "demo-agent",
  version: "1.0.0",
  description: "in-process demo agent",
  skills: demoSkills,
} as AgentCard;

const skillOf = (mock: MockA2AAgent, at = 0): unknown => {
  const sends = mock.callLog.filter((c) => c.method === "SendMessage");
  const params = sends[at]?.params as { message?: { metadata?: Record<string, unknown> } };
  return params?.message?.metadata?.[SKILL_METADATA_KEY];
};

describe("golden fixtures", () => {
  it("test/generated/demo-skills.ts is exactly what the generator emits", async () => {
    const expected = await readFile(new URL("./generated/demo-skills.ts", import.meta.url), "utf8");
    expect(generateSkillModule(demoCard, { importFrom: "../../src/index.js" })).toBe(expected);
  });

  it("test/generated/demo-skills-hooks.ts is exactly the --hooks emission", async () => {
    const expected = await readFile(new URL("./generated/demo-skills-hooks.ts", import.meta.url), "utf8");
    expect(
      generateSkillModule(demoCard, {
        hooks: true,
        importFrom: "../../src/index.js",
        reactImportFrom: "../../src/react/index.js",
      }),
    ).toBe(expected);
  });
});

describe("the generated module, over the real wire", () => {
  it("sendBookFlight sends a skill-tagged message and returns a live TaskHandle", async () => {
    const mock = new MockA2AAgent(echoExecutor(), { card: { skills: demoSkills } });
    const q = new A2AQuery({ agents: { demo: { url: mock.url, fetchImpl: mock.fetchImpl } }, taskPollMs: 15 });
    const handle = (await sendBookFlight(q, "demo", "book SFO to JFK")) as TaskHandle;
    const task = await handle.result();
    expect(artifactText(task)).toBe("echo: book SFO to JFK");
    expect(skillOf(mock)).toBe("book-flight");
  });

  it("dotted/digit-leading ids generate working helpers (send2faReset)", async () => {
    const mock = new MockA2AAgent(echoExecutor(), { card: { skills: demoSkills } });
    const q = new A2AQuery({ agents: { demo: { url: mock.url, fetchImpl: mock.fetchImpl } }, taskPollMs: 15 });
    const handle = (await send2faReset(q, "demo", "reset for user 7")) as TaskHandle;
    await handle.result();
    expect(skillOf(mock)).toBe("2fa.reset");
  });

  it("skill invocations merge caller message overrides but the skill id key always wins", async () => {
    const mock = new MockA2AAgent(echoExecutor(), { card: { skills: demoSkills } });
    const q = new A2AQuery({ agents: { demo: { url: mock.url, fetchImpl: mock.fetchImpl } }, taskPollMs: 15 });
    const handle = (await sendBookFlight(q, "demo", "fly", {
      message: { metadata: { tenant: "acme", [SKILL_METADATA_KEY]: "spoofed" } },
    })) as TaskHandle;
    await handle.result();
    const params = mock.callLog.find((c) => c.method === "SendMessage")?.params as {
      message: { metadata: Record<string, unknown> };
    };
    expect(params.message.metadata.tenant).toBe("acme");
    expect(params.message.metadata[SKILL_METADATA_KEY]).toBe("book-flight");
  });

  it("the skills record mirrors the card's discovery data", () => {
    expect(Object.keys(skills)).toEqual(["book-flight", "2fa.reset"]);
    expect(skills["book-flight"].examples).toEqual(["book SFO to JFK tomorrow morning"]);
  });
});

describe("generator edge cases", () => {
  it("colliding ids get deterministic numeric suffixes (first-come keeps the clean name)", () => {
    const card = {
      ...demoCard,
      skills: [
        { ...demoSkills[0]!, id: "a-b" },
        { ...demoSkills[0]!, id: "a.b" },
        { ...demoSkills[0]!, id: "a b" },
      ],
    } as AgentCard;
    const out = generateSkillModule(card);
    expect(out).toContain("export function sendAB(");
    expect(out).toContain("export function sendAB2(");
    expect(out).toContain("export function sendAB3(");
  });

  it("a card with no skills emits an empty record and no imports", () => {
    const out = generateSkillModule({ ...demoCard, skills: [] } as AgentCard);
    expect(out).toContain("export const skills = {\n} as const;");
    expect(out).not.toContain("import ");
    expect(out).toContain("DO NOT EDIT");
  });

  it("default import specifiers point at the published package", () => {
    const out = generateSkillModule(demoCard, { hooks: true });
    expect(out).toContain('from "@johnhenry/a2aq"');
    expect(out).toContain('from "@johnhenry/a2aq/react"');
  });
});

describe("a2aq-codegen CLI", () => {
  const cardFile = async (): Promise<string> => {
    const dir = await mkdtemp(join(tmpdir(), "a2aq-codegen-"));
    const file = join(dir, "card.json");
    await writeFile(file, JSON.stringify(demoCard));
    return file;
  };
  const io = () => {
    const out: string[] = [];
    const err: string[] = [];
    return { out, err, io: { log: (l: string) => out.push(l), error: (l: string) => err.push(l) } };
  };

  it("writes the module to -o (with --hooks) and reports on stderr", async () => {
    const file = await cardFile();
    const dest = join(file, "..", "skills.ts");
    const { err, io: sink } = io();
    const code = await runCodegenCli([file, "-o", dest, "--hooks"], sink);
    expect(code).toBe(0);
    const written = await readFile(dest, "utf8");
    expect(written).toContain("export function sendBookFlight(");
    expect(written).toContain("export function useBookFlight(");
    expect(err.join("\n")).toContain("wrote 2 skill(s)");
  });

  it("prints to stdout without -o; honors --import-from / --react-import-from", async () => {
    const file = await cardFile();
    const { out, io: sink } = io();
    const code = await runCodegenCli([file, "--hooks", "--import-from", "./x.js", "--react-import-from", "./y.js"], sink);
    expect(code).toBe(0);
    expect(out.join("\n")).toContain('from "./x.js"');
    expect(out.join("\n")).toContain('from "./y.js"');
  });

  it("fetches a direct card URL, and falls back to the well-known path for base URLs", async () => {
    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input);
      if (url === "https://agent.example/card.json" || url.endsWith("/.well-known/agent-card.json")) {
        return new Response(JSON.stringify(demoCard), { headers: { "content-type": "application/json" } });
      }
      return new Response("not here", { status: 404 });
    };
    for (const source of ["https://agent.example/card.json", "https://agent.example"]) {
      const { out, io: sink } = io();
      const code = await runCodegenCli([source], { ...sink, fetchImpl });
      expect(code).toBe(0);
      expect(out.join("\n")).toContain("sendBookFlight");
    }
  });

  it("fails cleanly: no args, unknown flag, extra positional, non-card input, unreachable URL", async () => {
    const notCard = join(await mkdtemp(join(tmpdir(), "a2aq-codegen-")), "nope.json");
    await writeFile(notCard, JSON.stringify({ hello: 1 }));
    const dead: typeof fetch = async () => new Response("no", { status: 500 });
    for (const [argv, ioExtra] of [
      [[], {}],
      [["--wat"], {}],
      [["a", "b"], {}],
      [[notCard], {}],
      [["https://dead.example"], { fetchImpl: dead }],
    ] as const) {
      const { err, io: sink } = io();
      expect(await runCodegenCli([...argv], { ...sink, ...ioExtra })).toBe(1);
      expect(err.length).toBeGreaterThan(0);
    }
  });

  it("--help prints usage and exits 0", async () => {
    const { out, io: sink } = io();
    expect(await runCodegenCli(["--help"], sink)).toBe(0);
    expect(out.join("\n")).toContain("usage:");
  });
});
