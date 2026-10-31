// Google Calendar and Tasks mapping over a fake Composio executor.

import assert from "node:assert/strict";
import { runCalendar, runTasks } from "../src/composio-productivity.ts";

let checks = 0;
const failures = [];
async function check(name, fn) {
  checks++;
  try {
    await fn();
  } catch (err) {
    failures.push(`${name}: ${err && err.message ? err.message : String(err)}`);
  }
}

function recorder(responses) {
  const calls = [];
  return {
    calls,
    execute: async (slug, args) => {
      calls.push({ slug, args });
      return typeof responses[slug] === "function"
        ? responses[slug](args)
        : responses[slug] ?? {};
    },
  };
}

await check("calendar list sorts events and names the calendar", async () => {
  const fake = recorder({
    GOOGLECALENDAR_EVENTS_LIST_ALL_CALENDARS: {
      calendars: [
        {
          id: "primary",
          events: [
            {
              id: "e2",
              summary: "Physics exam",
              start: { dateTime: "2026-11-03T09:00:00Z" },
              end: { dateTime: "2026-11-03T11:00:00Z" },
            },
            {
              id: "e1",
              summary: "Math homework",
              start: { dateTime: "2026-11-02T18:00:00Z" },
              end: { dateTime: "2026-11-02T19:00:00Z" },
            },
          ],
        },
      ],
    },
  });
  const out = await runCalendar(
    { action: "list", calendarId: "all", limit: 10 },
    fake.execute
  );
  assert.match(out, /Math homework/);
  assert.match(out, /Physics exam/);
  assert.ok(out.indexOf("Math homework") < out.indexOf("Physics exam"));
  assert.equal(fake.calls[0].slug, "GOOGLECALENDAR_EVENTS_LIST_ALL_CALENDARS");
});

await check("calendar create maps all-day and timed fields", async () => {
  const fake = recorder({
    GOOGLECALENDAR_CREATE_EVENT: { response_data: { id: "evt_1" } },
  });
  const out = await runCalendar(
    {
      action: "create",
      summary: "Study block",
      start: "2026-11-04T17:00:00Z",
      end: "2026-11-04T19:00:00Z",
      description: "Chapter 4",
      timezone: "Africa/Casablanca",
      attendees: ["friend@example.com"],
    },
    fake.execute
  );
  assert.match(out, /Created event "Study block"/);
  assert.match(out, /evt_1/);
  assert.equal(fake.calls[0].args.summary, "Study block");
  assert.equal(fake.calls[0].args.create_meeting_room, false);
  assert.equal(fake.calls[0].args.start_datetime, "2026-11-04T17:00:00Z");
  assert.equal(fake.calls[0].args.end_datetime, "2026-11-04T19:00:00Z");
  assert.deepEqual(fake.calls[0].args.attendees, ["friend@example.com"]);
});

await check("tasks list covers all lists and marks completed items", async () => {
  const fake = recorder({
    GOOGLETASKS_LIST_ALL_TASKS: {
      tasklists: [
        {
          id: "@default",
          title: "My Tasks",
          tasks: [
            { id: "t1", title: "Revise physics", status: "needsAction", due: "2026-11-03" },
            { id: "t2", title: "Submit math", status: "completed" },
          ],
        },
      ],
    },
  });
  const out = await runTasks({ action: "list", limit: 10 }, fake.execute);
  assert.match(out, /\[ \] Revise physics/);
  assert.match(out, /\[x\] Submit math/);
  assert.equal(fake.calls[0].slug, "GOOGLETASKS_LIST_ALL_TASKS");
});

await check("task complete patches status and completion time", async () => {
  const fake = recorder({ GOOGLETASKS_PATCH_TASK: {} });
  const out = await runTasks(
    { action: "complete", tasklistId: "@default", taskId: "t1" },
    fake.execute
  );
  assert.match(out, /Completed task t1/);
  assert.equal(fake.calls[0].args.status, "completed");
  assert.equal(fake.calls[0].args.task_id, "t1");
  assert.ok(fake.calls[0].args.completed);
});

await check("task create defaults to the primary list", async () => {
  const fake = recorder({ GOOGLETASKS_INSERT_TASK: { response_data: { id: "t3" } } });
  const out = await runTasks(
    { action: "create", title: "Chemistry revision", due: "2026-11-05" },
    fake.execute
  );
  assert.match(out, /Created task "Chemistry revision"/);
  assert.match(out, /t3/);
  assert.equal(fake.calls[0].args.tasklist_id, "@default");
  assert.equal(fake.calls[0].args.due, "2026-11-05T00:00:00.000Z");
});

if (failures.length) {
  for (const failure of failures) console.error(`FAIL ${failure}`);
  console.error(`composio-productivity: ${failures.length} of ${checks} failed`);
  process.exit(1);
}
console.log(`composio-productivity: ${checks} checks passed`);
