// Source-level guards for the automation-origin path. src/agent.ts imports the
// Agents SDK, so Node cannot import it; these checks pin the security-critical
// shape and the pure behavior is covered by the engine tests.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const here = (name) => readFileSync(new URL(`../src/${name}`, import.meta.url), "utf8");
const agent = here("agent.ts");
const types = here("types.ts");
const failures = [];

function check(name, fn) {
  try {
    fn();
  } catch (err) {
    failures.push(`${name}: ${err && err.message ? err.message : String(err)}`);
  }
}

check("submitTurn accepts an origin and only humans get directives", () => {
  assert.match(agent, /origin: TurnOrigin = \{ kind: "human" \}/);
  assert.match(agent, /origin\.kind === "human" \? this\.directKind\(content\) : null/);
});

check("automation origin records the run and suppresses title work", () => {
  assert.match(agent, /this\.automationOrigins\.set\(operationId/);
  // An automation turn is never titled, queued or not.
  assert.match(agent, /if \(origin\.kind === "human"\) this\.startTitle/);
});

check("a parked automation turn is not reported as complete", () => {
  assert.match(agent, /private readonly parkedAutomationOps/);
  assert.match(agent, /if \(pending && this\.automationOrigins\.has\(turnId\)\)/);
  assert.match(agent, /const automationParked = this\.parkedAutomationOps\.has\(rootOp\)/);
  assert.match(agent, /if \(automation && !automationParked\)/);
});

check("finalize reports automation completion and turnStatus reconciles", () => {
  assert.match(agent, /private async reportAutomationRun/);
  assert.match(agent, /async turnStatus\(sessionId: string, streamId: string\)/);
  assert.match(agent, /this\.hub\.settled\(streamId\) \? "done" : "running"/);
});

check("shared types expose the automation wire contracts", () => {
  assert.match(types, /export type TurnOrigin/);
  assert.match(types, /export interface AutomationRunCompletion/);
  assert.match(types, /export interface AutomationAgentStub/);
  assert.match(types, /AUTOMATION: DurableObjectNamespace/);
  assert.match(types, /turnStatus\(/);
});

if (failures.length) {
  for (const failure of failures) console.error(`FAIL ${failure}`);
  process.exit(1);
}
