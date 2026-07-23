// Artifact conveniences: extracting text from the SDK's ts-proto Part oneofs
// (`content: { $case: "text", value }`) without every consumer re-learning the
// encoding. Pure functions — the cache-backed accessors live on A2AQuery/TaskHandle.

import type { Artifact, Part } from "@a2a-js/sdk";

/** The text of a Part, or undefined for non-text parts (raw / url / data). */
export function partText(part: Part): string | undefined {
  return part.content?.$case === "text" ? String(part.content.value) : undefined;
}

/** All text parts of an artifact, concatenated (chunked artifacts read as one string). */
export function artifactText(artifact: Artifact): string {
  return artifact.parts.map((p) => partText(p) ?? "").join("");
}

/** All text across a list of artifacts, artifacts separated by `separator` (default newline). */
export function artifactsText(artifacts: readonly Artifact[], separator = "\n"): string {
  return artifacts
    .map((a) => artifactText(a))
    .filter((s) => s.length > 0)
    .join(separator);
}
