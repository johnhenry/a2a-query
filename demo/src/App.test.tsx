// Smoke test (happy-dom): mount the real <App/> against the real in-process
// mock agents and walk the flagship flow — fleet renders, cards resolve,
// a deploy pauses INPUT_REQUIRED into the approval inbox, approving resumes
// the task to completion and the decision lands in the audit trail.

import { describe, expect, it } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import App from "./App";
import { AGENTS, broker } from "./hub";

describe("demo app", () => {
  it("renders the fleet, runs the approval flow end to end", async () => {
    render(<App />);

    // Panes are up.
    expect(screen.getByText(/Agent fleet/i)).toBeTruthy();
    expect(screen.getByText(/Task board/i)).toBeTruthy();
    expect(screen.getByText(/Approval inbox/i)).toBeTruthy();

    // All four agents are listed…
    expect(AGENTS).toEqual(["researcher", "deployer", "billing", "flaky-runner"]);
    for (const agent of AGENTS) {
      expect(screen.getAllByText(agent).length).toBeGreaterThan(0);
    }
    // …and their cards resolve (mounting useAgentCard triggers the fetch).
    await waitFor(() => expect(screen.getByText("deploy-bot")).toBeTruthy());
    await waitFor(() => expect(screen.getAllByText("ready").length).toBeGreaterThan(0));

    // Launch the approval scenario: the deployer pauses INPUT_REQUIRED.
    fireEvent.click(screen.getByText("Deploy (approval)"));
    await waitFor(() => expect(screen.getByText("Deploy web-frontend v2.4.1")).toBeTruthy());
    await waitFor(() => expect(broker.list().length).toBe(1), { timeout: 10_000 });
    await waitFor(() => expect(screen.getAllByText("input-required").length).toBeGreaterThan(0));

    // Approve with the free-text reply — the task resumes and completes.
    fireEvent.click(screen.getByText("approve"));
    await waitFor(() => expect(broker.list().length).toBe(0));
    await waitFor(() => expect(screen.getByText(/Completed/)).toBeTruthy(), { timeout: 10_000 });

    // The decision is on the audit trail.
    expect(broker.auditLog().some((e) => e.outcome === "approved" && e.peer === "deployer")).toBe(true);
    await waitFor(() => expect(screen.getByText("approved")).toBeTruthy());
  });
});
