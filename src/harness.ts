// The only place that constructs the ThinkHarness class. Kept apart from
// harness-config.ts so the offline test can assert on the options object without
// the SDK lifecycle in the import path.
//
// Never install a Sessions capability yourself: ThinkHarness binds its own
// internally, and use(new Sessions()) does not throw (the bound instance is not
// registered), so two writers would share cf_agents_session_messages silently.

import { ThinkHarness } from "agents/harness/think";
import type { ToolSet } from "ai";
import { harnessConfig, type HarnessConfigDeps } from "./harness-config.ts";

export function buildHarness(deps: HarnessConfigDeps): ThinkHarness<ToolSet> {
  const harness = new ThinkHarness<ToolSet>(harnessConfig(deps));
  harness.observe((_session, ev) => deps.onEvent(ev));
  return harness;
}
