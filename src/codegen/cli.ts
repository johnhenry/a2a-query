#!/usr/bin/env node
// a2aq-codegen — AgentCard → typed skill-invocation module.
//
//   a2aq-codegen <card-url-or-file> [-o out.ts] [--hooks]
//                [--import-from spec] [--react-import-from spec]
//
// <card-url-or-file>: an AgentCard JSON file, a direct card URL, or an agent
// base URL (the well-known path /.well-known/agent-card.json is tried when
// the given URL doesn't answer with a card). Output goes to -o or stdout.

import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import type { AgentCard } from "@a2a-js/sdk";
import { generateSkillModule, type GenerateSkillModuleOptions } from "./generate.js";

/** Injectable edges so the CLI is testable in-process. */
export interface CodegenCliIO {
  fetchImpl?: typeof fetch;
  log?: (line: string) => void;
  error?: (line: string) => void;
}

const USAGE =
  "usage: a2aq-codegen <card-url-or-file> [-o out.ts] [--hooks] [--import-from spec] [--react-import-from spec]";

const isCard = (v: unknown): v is AgentCard =>
  typeof v === "object" && v !== null && Array.isArray((v as AgentCard).skills);

async function loadCard(source: string, fetchImpl: typeof fetch): Promise<AgentCard> {
  if (/^https?:\/\//.test(source)) {
    // Direct card URL first; agent BASE urls fall back to the well-known path.
    for (const url of [source, `${source.replace(/\/$/, "")}/.well-known/agent-card.json`]) {
      try {
        const res = await fetchImpl(url);
        if (!res.ok) continue;
        const json: unknown = await res.json();
        if (isCard(json)) return json;
      } catch {
        // fall through to the next candidate
      }
    }
    throw new Error(`no AgentCard (with a "skills" array) found at ${source}`);
  }
  const json: unknown = JSON.parse(await readFile(source, "utf8"));
  if (!isCard(json)) throw new Error(`${source} is not an AgentCard (missing "skills" array)`);
  return json;
}

/** The CLI, in-process: returns the exit code instead of exiting. */
export async function runCodegenCli(argv: string[], io: CodegenCliIO = {}): Promise<number> {
  const log = io.log ?? console.log;
  const error = io.error ?? console.error;
  const fetchImpl = io.fetchImpl ?? fetch;

  let source: string | undefined;
  let out: string | undefined;
  const gen: GenerateSkillModuleOptions = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "-o" || arg === "--out") out = argv[++i];
    else if (arg === "--hooks") gen.hooks = true;
    else if (arg === "--import-from") gen.importFrom = argv[++i];
    else if (arg === "--react-import-from") gen.reactImportFrom = argv[++i];
    else if (arg === "-h" || arg === "--help") {
      log(USAGE);
      return 0;
    } else if (arg.startsWith("-")) {
      error(`unknown option: ${arg}\n${USAGE}`);
      return 1;
    } else if (source === undefined) source = arg;
    else {
      error(`unexpected argument: ${arg}\n${USAGE}`);
      return 1;
    }
  }
  if (!source) {
    error(USAGE);
    return 1;
  }

  try {
    const card = await loadCard(source, fetchImpl);
    const code = generateSkillModule(card, gen);
    if (out) {
      await writeFile(out, code, "utf8");
      error(`a2aq-codegen: wrote ${card.skills.length} skill(s) from "${card.name}" to ${out}`);
    } else {
      log(code);
    }
    return 0;
  } catch (err) {
    error(`a2aq-codegen: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}

// Run when invoked as a bin (never when imported).
const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(entry).href) {
  process.exitCode = await runCodegenCli(process.argv.slice(2));
}
