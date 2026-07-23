// The flagship a2aq demo: a multi-agent task dashboard with an approval
// inbox, running entirely in-browser against in-process mock A2A agents.

import { useState } from "react";
import { AgentQueryDevtools } from "@johnhenry/a2aq/react";
import { broker, hub, q } from "./hub";
import { launchBilling, launchBurst, launchDeploy, launchFlaky, launchResearch } from "./scenarios";
import type { DemoTask } from "./taskList";
import { FleetSidebar } from "./components/FleetSidebar";
import { TaskBoard } from "./components/TaskBoard";
import { TaskDetail } from "./components/TaskDetail";
import { ApprovalInbox } from "./components/ApprovalInbox";

const SCENARIOS: Array<{ label: string; hint: string; run: () => Promise<void> }> = [
  { label: "Research (streaming)", hint: "SSE artifact chunks", run: launchResearch },
  { label: "Deploy (approval)", hint: "pauses INPUT_REQUIRED", run: launchDeploy },
  { label: "Billing (auth)", hint: "pauses AUTH_REQUIRED", run: launchBilling },
  { label: "Flaky run (retry)", hint: "first delivery drops", run: launchFlaky },
  { label: "Fan-out burst", hint: "all agents at once", run: launchBurst },
];

export default function App() {
  const [selected, setSelected] = useState<DemoTask | undefined>(undefined);
  return (
    <div className="app">
      <header className="topbar">
        <h1>
          a2aq <span className="dim">· multi-agent task dashboard</span>
        </h1>
        <div className="scenarios">
          {SCENARIOS.map((s) => (
            <button key={s.label} className="btn btn-launch" title={s.hint} onClick={() => void s.run()}>
              {s.label}
            </button>
          ))}
        </div>
      </header>
      <div className="layout">
        <FleetSidebar />
        <main className="main">
          <TaskBoard selectedKey={selected?.key} onSelect={setSelected} />
          <TaskDetail task={selected} />
        </main>
        <ApprovalInbox />
      </div>
      <AgentQueryDevtools hub={hub} cache={q.cache} broker={broker} status={q.status} title="a2aq devtools" />
    </div>
  );
}
