// Google Calendar and Google Tasks over Composio. The connected account is
// resolved by the caller; this module only maps one compact tool to actions.

export type ProductivityExecutor = (
  toolSlug: string,
  args: Record<string, unknown>
) => Promise<Record<string, unknown>>;

export interface CalendarInput {
  action: "list" | "create" | "update" | "delete" | "calendars";
  calendarId?: string;
  eventId?: string;
  summary?: string;
  start?: string;
  end?: string;
  allDay?: boolean;
  meeting?: boolean;
  location?: string;
  description?: string;
  attendees?: string[];
  timezone?: string;
  recurrence?: string[];
  query?: string;
  from?: string;
  to?: string;
  limit?: number;
}

export interface TasksInput {
  action: "list" | "lists" | "create" | "update" | "complete" | "delete";
  tasklistId?: string;
  taskId?: string;
  title?: string;
  notes?: string;
  due?: string;
  showCompleted?: boolean;
  limit?: number;
}

function rec(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
function arr(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}
function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}
function clamp(value: unknown, fallback: number, max: number): number {
  const n = Math.floor(Number(value) || fallback);
  return Math.max(1, Math.min(max, n));
}
function isoDate(value: string): string {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T00:00:00.000Z` : value;
}
function addOneDay(value: string): string {
  const date = new Date(isoDate(value));
  if (Number.isNaN(date.getTime())) return value;
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
}
function addOneHour(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  date.setUTCHours(date.getUTCHours() + 1);
  return date.toISOString();
}
function payload(data: Record<string, unknown>): Record<string, unknown> {
  const inner = rec(data.response_data);
  return Object.keys(inner).length ? inner : data;
}
function eventRows(data: Record<string, unknown>): Array<Record<string, unknown>> {
  const root = payload(data);
  const direct = arr(root.events).length ? arr(root.events) : arr(root.items);
  if (direct.length) return direct.map(rec);
  const rows: Array<Record<string, unknown>> = [];
  for (const calendar of arr(root.calendars)) {
    const c = rec(calendar);
    for (const event of arr(c.events).length ? arr(c.events) : arr(c.items)) {
      const row = rec(event);
      rows.push({ ...row, calendarId: str(row.calendarId) || str(c.id) });
    }
  }
  return rows;
}
function whenOf(value: unknown): string {
  const slot = rec(value);
  return str(slot.dateTime) || str(slot.date);
}
function eventLine(event: Record<string, unknown>): string {
  const start = whenOf(event.start);
  const end = whenOf(event.end);
  const calendar = str(event.calendarId) || str(event.calendarSummary) || "calendar";
  const location = str(event.location);
  return `- ${start || "no start"}${end ? ` → ${end}` : ""} | ${
    str(event.summary) || "(no title)"
  } | ${calendar}${location ? ` | ${location}` : ""} | id ${str(event.id)}`;
}
function taskRows(data: Record<string, unknown>): Array<Record<string, unknown>> {
  const root = payload(data);
  const direct = arr(root.tasks).length ? arr(root.tasks) : arr(root.items);
  if (direct.length) return direct.map(rec);
  const rows: Array<Record<string, unknown>> = [];
  for (const list of arr(root.tasklists).length ? arr(root.tasklists) : arr(root.lists)) {
    const l = rec(list);
    for (const task of arr(l.tasks).length ? arr(l.tasks) : arr(l.items)) {
      const row = rec(task);
      rows.push({
        ...row,
        tasklistId: str(row.tasklistId) || str(l.id),
        tasklistTitle: str(l.title),
      });
    }
  }
  return rows;
}
function taskLine(task: Record<string, unknown>): string {
  const status = str(task.status) === "completed" ? "x" : " ";
  const list = str(task.tasklistTitle) || str(task.tasklistId) || "tasks";
  return `- [${status}] ${str(task.title) || "(untitled)"}${
    str(task.due) ? ` | due ${str(task.due)}` : ""
  }${str(task.notes) ? ` | ${str(task.notes).slice(0, 120)}` : ""} | ${list} | id ${str(
    task.id
  )}`;
}

export async function runCalendar(
  input: CalendarInput,
  execute: ProductivityExecutor
): Promise<string> {
  const calendarId = input.calendarId?.trim() || "primary";
  if (input.action === "calendars") {
    const data = await execute("GOOGLECALENDAR_LIST_CALENDARS", { max_results: 50 });
    const rows = arr(data.items).length ? arr(data.items) : arr(data.calendars);
    return rows.length
      ? rows
          .map((raw) => {
            const calendar = rec(raw);
            return `- ${str(calendar.summary) || str(calendar.id)} | ${
              calendar.primary ? "primary" : str(calendar.accessRole) || "calendar"
            } | id ${str(calendar.id)}`;
          })
          .join("\n")
      : "No calendars.";
  }
  if (input.action === "list") {
    const limit = clamp(input.limit, 25, 100);
    const timeMin = input.from ? isoDate(input.from) : new Date().toISOString();
    const timeMax = input.to
      ? isoDate(input.to)
      : new Date(Date.now() + 30 * 86_400_000).toISOString();
    const data =
      calendarId === "all"
        ? await execute("GOOGLECALENDAR_EVENTS_LIST_ALL_CALENDARS", {
            time_min: timeMin,
            time_max: timeMax,
            max_results_per_calendar: limit,
            single_events: true,
            response_detail: "full",
          })
        : await execute("GOOGLECALENDAR_EVENTS_LIST", {
            calendarId,
            timeMin,
            timeMax,
            maxResults: limit,
            singleEvents: true,
            orderBy: "startTime",
            ...(input.query ? { q: input.query } : {}),
          });
    const rows = eventRows(data).slice(0, limit);
    return rows.length
      ? rows.sort((a, b) => whenOf(a.start).localeCompare(whenOf(b.start))).map(eventLine).join("\n")
      : "No events in that window.";
  }
  if (input.action === "create") {
    const summary = input.summary?.trim();
    if (!summary) return "create needs a summary.";
    if (!input.start) return "create needs a start time.";
    const args: Record<string, unknown> = {
      calendar_id: calendarId,
      summary,
      timezone: input.timezone || "UTC",
    };
    if (input.allDay) {
      args.start_date = input.start.slice(0, 10);
      args.end_date = input.end
        ? input.end.slice(0, 10)
        : addOneDay(input.start.slice(0, 10));
    } else {
      args.start_datetime = input.start;
      args.end_datetime = input.end || addOneHour(input.start);
    }
    // Google Calendar creates a Meet room by default. A study reminder does not
    // need one, so only ask for it when the caller explicitly wants a meeting.
    args.create_meeting_room = input.meeting === true;
    if (input.location) args.location = input.location;
    if (input.description) args.description = input.description;
    if (input.attendees?.length) args.attendees = input.attendees;
    if (input.recurrence?.length) args.recurrence = input.recurrence;
    const data = await execute("GOOGLECALENDAR_CREATE_EVENT", args);
    const event =
      Object.keys(rec(data.event)).length
        ? rec(data.event)
        : payload(data);
    return `Created event "${summary}" on ${calendarId}${
      str(event.id) ? ` (id ${str(event.id)})` : ""
    }${str(event.htmlLink) ? `\n${str(event.htmlLink)}` : ""}.`;
  }
  if (input.action === "update") {
    if (!input.eventId) return "update needs an eventId.";
    const args: Record<string, unknown> = {
      calendar_id: calendarId,
      event_id: input.eventId,
    };
    if (input.summary) args.summary = input.summary;
    if (input.start) args.start_time = input.start;
    if (input.end) args.end_time = input.end;
    if (input.location) args.location = input.location;
    if (input.description) args.description = input.description;
    if (input.attendees) args.attendees = input.attendees;
    await execute("GOOGLECALENDAR_PATCH_EVENT", args);
    return `Updated event ${input.eventId} on ${calendarId}.`;
  }
  if (input.action === "delete") {
    if (!input.eventId) return "delete needs an eventId.";
    await execute("GOOGLECALENDAR_DELETE_EVENT", {
      calendar_id: calendarId,
      event_id: input.eventId,
      send_updates: "none",
    });
    return `Deleted event ${input.eventId} from ${calendarId}.`;
  }
  return `Unknown calendar action: ${String(input.action)}.`;
}

export async function runTasks(
  input: TasksInput,
  execute: ProductivityExecutor
): Promise<string> {
  if (input.action === "lists") {
    const data = await execute("GOOGLETASKS_LIST_TASK_LISTS", { maxResults: 100 });
    const rows = arr(data.items).length ? arr(data.items) : arr(data.tasklists);
    return rows.length
      ? rows
          .map((raw) => {
            const list = rec(raw);
            return `- ${str(list.title) || "(untitled list)"} | id ${str(list.id)}`;
          })
          .join("\n")
      : "No task lists.";
  }
  if (input.action === "list") {
    const limit = clamp(input.limit, 50, 200);
    const tasklistId = input.tasklistId?.trim();
    const data = tasklistId
      ? await execute("GOOGLETASKS_LIST_TASKS", {
          tasklist_id: tasklistId,
          showCompleted: input.showCompleted !== false,
          maxResults: limit,
        })
      : await execute("GOOGLETASKS_LIST_ALL_TASKS", {
          showCompleted: input.showCompleted !== false,
          max_tasks_total: limit,
        });
    const rows = taskRows(data).slice(0, limit);
    return rows.length ? rows.map(taskLine).join("\n") : "No tasks.";
  }
  const tasklistId = input.tasklistId?.trim() || "@default";
  if (input.action === "create") {
    const title = input.title?.trim();
    if (!title) return "create needs a title.";
    const data = await execute("GOOGLETASKS_INSERT_TASK", {
      tasklist_id: tasklistId,
      title,
      ...(input.notes ? { notes: input.notes } : {}),
      ...(input.due ? { due: isoDate(input.due) } : {}),
    });
    const task =
      Object.keys(rec(data.task)).length
        ? rec(data.task)
        : payload(data);
    return `Created task "${title}" in ${tasklistId}${str(task.id) ? ` (id ${str(task.id)})` : ""}.`;
  }
  if (!input.taskId) return `${input.action} needs a taskId.`;
  if (input.action === "complete") {
    await execute("GOOGLETASKS_PATCH_TASK", {
      tasklist_id: tasklistId,
      task_id: input.taskId,
      status: "completed",
      completed: new Date().toISOString(),
    });
    return `Completed task ${input.taskId} in ${tasklistId}.`;
  }
  if (input.action === "delete") {
    await execute("GOOGLETASKS_DELETE_TASK", {
      tasklist_id: tasklistId,
      task_id: input.taskId,
    });
    return `Deleted task ${input.taskId} from ${tasklistId}.`;
  }
  if (input.action === "update") {
    const args: Record<string, unknown> = {
      tasklist_id: tasklistId,
      task_id: input.taskId,
    };
    if (input.title) args.title = input.title;
    if (input.notes) args.notes = input.notes;
    if (input.due) args.due = isoDate(input.due);
    await execute("GOOGLETASKS_PATCH_TASK", args);
    return `Updated task ${input.taskId} in ${tasklistId}.`;
  }
  return `Unknown tasks action: ${String(input.action)}.`;
}
