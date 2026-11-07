import React, { useState, useEffect } from "react";
import {
  Plus,
  Clock,
  Globe,
  Webhook,
  ArrowRight,
  Play,
  Pause,
  Repeat,
  Trash2,
  Check,
  ChevronRight,
  TriangleAlert,
} from "lucide-react";
import { useApp } from "../contexts/AppContext";
import { useRun } from "../contexts/RunContext";
import { Page, PageHeader } from "../components/ui/Page";
import { Button } from "../components/ui/Button";
import { Badge } from "../components/ui/Badge";
import { Dialog } from "../components/ui/Dialog";
import { ConfirmDialog } from "../components/ui/ConfirmDialog";
import {
  Field,
  inputCls,
  textareaCls,
  selectCls,
} from "../components/ui/Field";
import { Panel, Back, SafeNote, Empty } from "../components/workspace/Shared";
import { describeTrigger, nextRunLabel } from "../utils/schedule";
import { TIMEZONES, nowIso } from "../utils/time";
import { uid } from "../utils/format";
import type { Automation, Trigger } from "../types";
import { toast } from "sonner";
export function Automations() {
  const app = useApp(),
    runner = useRun();
  const [creating, setCreating] = useState(app.route.id === "new"),
    [name, setName] = useState(""),
    [instructions, setInstructions] = useState(""),
    [trigger, setTrigger] = useState("schedule"),
    [freq, setFreq] = useState("daily"),
    [time, setTime] = useState("08:00"),
    [url, setUrl] = useState(""),
    [zone, setZone] = useState(app.settings.timezone),
    [target, setTarget] = useState(app.conversations[0]?.id ?? ""),
    [remove, setRemove] = useState(false),
    [preview, setPreview] = useState(false);
  const a = app.automations.find((x) => x.id === app.route.id);
  useEffect(() => {
    if (app.route.id === "new") setCreating(true);
  }, [app.route.id]);
  const close = () => {
    setCreating(false);
    if (app.route.id === "new") app.navigate("automations");
  };
  const patch = (p: Partial<Automation>) =>
    app.setAutomations((xs) =>
      xs.map((x) => (x.id === a?.id ? { ...x, ...p } : x)),
    );
  const toggle = (id: string) =>
    app.setAutomations((xs) =>
      xs.map((x) => {
        if (x.id !== id) return x;
        if (!x.targetChatId) {
          toast.info("Choose a conversation before resuming.");
          app.navigate("automations", id);
          return x;
        }
        return { ...x, enabled: !x.enabled, autoPausedReason: undefined };
      }),
    );
  const create = (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || !instructions.trim() || !target) return;
    const t: Trigger =
      trigger === "schedule"
        ? {
            type: "schedule",
            schedule: {
              freq: freq as "daily" | "weekdays" | "weekly",
              time,
              weekday: 1,
            },
          }
        : trigger === "watch"
          ? { type: "watch", url, everyHours: 6 }
          : {
              type: "webhook",
              source: "Custom webhook",
              event: "event.received",
              endpoint: "https://example.invalid/demo-webhook",
            };
    const n: Automation = {
      id: uid("routine"),
      name: name.trim(),
      instructions: instructions.trim(),
      trigger: t,
      checks: "Check permission scope and ask before any external side effect.",
      does: instructions.trim(),
      timezone: zone,
      targetChatId: target,
      enabled: true,
      history: [],
      createdAt: nowIso(),
    };
    app.setAutomations((xs) => [n, ...xs]);
    setCreating(false);
    app.navigate("automations", n.id);
    toast.success(
      "Local routine saved. No real schedule or webhook is registered.",
    );
  };
  const modal = (
    <Dialog
      open={creating}
      onClose={close}
      title="A little routine. A lot off your mind."
      description="Set the cue, the context, and the outcome. This is saved locally as demo data."
      footer={
        <>
          <Button onClick={close}>Cancel</Button>
          <Button variant="primary" form="routine-form" type="submit">
            Save routine
          </Button>
        </>
      }
    >
      <form id="routine-form" onSubmit={create} className="ws-stack">
        <Field label="Routine name" htmlFor="routine-name">
          <input
            id="routine-name"
            required
            className={inputCls}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Morning brief"
          />
        </Field>
        <Field label="When should it start?" htmlFor="routine-trigger">
          <select
            id="routine-trigger"
            className={selectCls}
            value={trigger}
            onChange={(e) => setTrigger(e.target.value)}
          >
            <option value="schedule">On a schedule</option>
            <option value="watch">When a page changes</option>
            <option value="webhook">When a webhook arrives</option>
          </select>
        </Field>
        {trigger === "schedule" ? (
          <div className="ws-grid two">
            <Field label="Frequency" htmlFor="routine-freq">
              <select
                id="routine-freq"
                className={selectCls}
                value={freq}
                onChange={(e) => setFreq(e.target.value)}
              >
                <option value="daily">Every day</option>
                <option value="weekdays">Weekdays</option>
                <option value="weekly">Mondays</option>
              </select>
            </Field>
            <Field label="Local time" htmlFor="routine-time">
              <input
                id="routine-time"
                className={inputCls}
                type="time"
                required
                value={time}
                onChange={(e) => setTime(e.target.value)}
              />
            </Field>
          </div>
        ) : trigger === "watch" ? (
          <Field
            label="Page URL"
            htmlFor="routine-url"
            hint="Demo checks every 6 hours. No request is made."
          >
            <input
              id="routine-url"
              type="url"
              pattern="https://.*"
              required
              className={inputCls}
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://docs.example.com/changelog"
            />
          </Field>
        ) : (
          <SafeNote>
            A non-routable example endpoint is shown after saving. No real
            webhook is provisioned.
          </SafeNote>
        )}
        <Field label="Timezone" htmlFor="routine-zone">
          <select
            id="routine-zone"
            className={selectCls}
            value={zone}
            onChange={(e) => setZone(e.target.value)}
          >
            {TIMEZONES.map((z) => (
              <option value={z.id} key={z.id}>
                {z.label} · {z.id}
              </option>
            ))}
          </select>
        </Field>
        <Field label="What should Blip do?" htmlFor="routine-instructions">
          <textarea
            id="routine-instructions"
            required
            className={textareaCls}
            value={instructions}
            onChange={(e) => setInstructions(e.target.value)}
          />
        </Field>
        <Field label="Target conversation" htmlFor="routine-chat">
          <select
            id="routine-chat"
            required
            className={selectCls}
            value={target}
            onChange={(e) => setTarget(e.target.value)}
          >
            <option value="">Choose a conversation</option>
            {app.conversations.map((c) => (
              <option key={c.id} value={c.id}>
                {c.title}
              </option>
            ))}
          </select>
        </Field>
      </form>
    </Dialog>
  );
  if (a) {
    const Icon =
      a.trigger.type === "schedule"
        ? Clock
        : a.trigger.type === "watch"
          ? Globe
          : Webhook;
    return (
      <Page>
        <Back screen="automations" label="All routines" />
        <PageHeader
          index="05"
          eyebrow="SET IT, STAY IN CONTROL"
          title={a.name}
          description={describeTrigger(a.trigger)}
          actions={
            <>
              <Badge tone={a.enabled ? "healthy" : "neutral"} dot>
                {a.autoPausedReason
                  ? "Needs attention"
                  : a.enabled
                    ? "Active · demo"
                    : "Paused"}
              </Badge>
              <Button
                onClick={() => toggle(a.id)}
                icon={a.enabled ? <Pause /> : <Play />}
              >
                {a.enabled ? "Pause" : "Resume"}
              </Button>
              <Button
                size="icon"
                aria-label="Delete routine"
                onClick={() => setRemove(true)}
              >
                <Trash2 />
              </Button>
            </>
          }
        />
        {(a.lastError || a.autoPausedReason) && (
          <div className="ws-card !bg-amber-soft mb-6">
            <p className="font-medium text-amber-ink">
              {a.lastError?.message ?? a.autoPausedReason}
            </p>
            <label className="block text-sm mt-4">
              Choose a target conversation
              <select
                className={selectCls + " mt-2"}
                value={a.targetChatId ?? ""}
                onChange={(e) =>
                  patch({
                    targetChatId: e.target.value,
                    lastError: undefined,
                    autoPausedReason: undefined,
                  })
                }
              >
                <option value="">Choose one…</option>
                {app.conversations.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.title}
                  </option>
                ))}
              </select>
            </label>
          </div>
        )}
        <div className="ws-grid three">
          {[
            {
              n: "01",
              label: "When",
              icon: Icon,
              text: describeTrigger(a.trigger),
            },
            { n: "02", label: "Check", icon: Check, text: a.checks },
            { n: "03", label: "Do", icon: Play, text: a.does },
          ].map((s) => (
            <Panel key={s.n}>
              <div className="ws-between">
                <p className="ws-kicker">
                  {s.n} · {s.label}
                </p>
                <s.icon size={18} className="text-accent-ink" />
              </div>
              <p className="text-sm leading-relaxed mt-5 min-h-[70px]">
                {s.text}
              </p>
            </Panel>
          ))}
        </div>
        <div className="ws-grid two mt-6">
          <Panel>
            <h2>Up next</h2>
            <p className="text-xl font-semibold mt-5">{nextRunLabel(a)}</p>
            <p className="ws-meta mt-2">
              {a.timezone} ·{" "}
              {a.enabled ? "Schedule preview only" : "Not running while paused"}
            </p>
            <div className="ws-rule" />
            <h3 className="mb-3">Instructions</h3>
            <p className="ws-muted whitespace-pre-wrap">{a.instructions}</p>
            <div className="flex flex-wrap gap-2 mt-6">
              <Button
                icon={<Play />}
                variant="primary"
                disabled={!a.targetChatId}
                onClick={() => {
                  const cid = a.targetChatId!;
                  runner.sendMessage(cid, a.instructions);
                  patch({
                    history: [
                      {
                        id: uid("run"),
                        time: nowIso(),
                        result: "skipped",
                        note: "Manual request handed to local conversation simulator. No real automation executed.",
                        simulated: true,
                      },
                      ...a.history,
                    ],
                  });
                  app.navigate("chat", cid);
                }}
              >
                Run demo turn
              </Button>
              <Button onClick={() => setPreview(true)}>Preview prompt</Button>
            </div>
          </Panel>
          <Panel>
            <h2 className="mb-4">Run history</h2>
            {a.history.length === 0 ? (
              <Empty
                title="Nothing has run yet."
                body="Manual demo runs will appear here. No background scheduler is active."
              />
            ) : (
              a.history.map((h) => (
                <div
                  key={h.id}
                  className="border-b border-line py-4 last:border-0"
                >
                  <div className="ws-between">
                    <Badge
                      tone={
                        h.result === "success"
                          ? "healthy"
                          : h.result === "failed"
                            ? "danger"
                            : "neutral"
                      }
                    >
                      {h.result}
                    </Badge>
                    <span className="ws-meta">
                      {new Date(h.time).toLocaleString()}
                    </span>
                  </div>
                  <p className="text-sm mt-3 leading-relaxed">{h.note}</p>
                  <span className="ws-meta">
                    Demo fixture / simulated event
                  </span>
                </div>
              ))
            )}
          </Panel>
        </div>
        <div className="mt-6">
          <SafeNote>
            Automations are editable local fixtures. This demo never runs a real
            background job, watches a page, or registers a webhook.
          </SafeNote>
        </div>
        <Dialog
          open={preview}
          onClose={() => setPreview(false)}
          title="The prompt Blip would receive"
        >
          <pre className="ws-code">
            {a.instructions +
              "\n\nConstraints: " +
              a.checks +
              "\nTimezone: " +
              a.timezone}
          </pre>
        </Dialog>
        <ConfirmDialog
          open={remove}
          onClose={() => setRemove(false)}
          title="Remove this routine?"
          confirmLabel="Remove local routine"
          impact={[
            "Removes this demo trigger and its local history.",
            "No real schedule, webhook or account is affected.",
          ]}
          onConfirm={() => {
            app.setAutomations((xs) => xs.filter((x) => x.id !== a.id));
            app.navigate("automations");
          }}
        />
        {modal}
      </Page>
    );
  }
  return (
    <Page>
      <PageHeader
        index="05"
        eyebrow="THE GOOD KIND OF REPETITION"
        title="On it. Again and again."
        description="Small routines that quietly make room in your day. One place for schedules, watchers, and webhooks."
        actions={
          <Button
            variant="primary"
            icon={<Plus />}
            onClick={() => setCreating(true)}
          >
            New routine
          </Button>
        }
      />
      <div className="ws-grid two">
        {app.automations.map((a) => {
          const Icon =
            a.trigger.type === "schedule"
              ? Clock
              : a.trigger.type === "watch"
                ? Globe
                : Webhook;
          return (
            <Panel key={a.id}>
              <div className="ws-between">
                <span className="grid h-11 w-11 place-items-center rounded-2xl bg-accent-soft text-accent-ink">
                  <Icon size={20} />
                </span>
                <button
                  className={`ws-toggle ${a.enabled ? "on" : ""}`}
                  role="switch"
                  aria-checked={a.enabled}
                  aria-label={`${a.enabled ? "Pause" : "Resume"} ${a.name}`}
                  onClick={() => toggle(a.id)}
                />
              </div>
              <button
                className="text-left w-full mt-5"
                onClick={() => app.navigate("automations", a.id)}
              >
                <h2>{a.name}</h2>
                <p className="ws-muted mt-2 min-h-[44px] line-clamp-2">
                  {a.instructions}
                </p>
                <div className="ws-rule" />
                <div className="ws-between">
                  <span>
                    <span className="ws-kicker block mb-1">
                      {a.autoPausedReason
                        ? "NEEDS ATTENTION"
                        : "NEXT WINDOW · DEMO"}
                    </span>
                    <span className="text-sm">
                      {a.autoPausedReason ?? nextRunLabel(a)}
                    </span>
                  </span>
                  <ChevronRight size={17} />
                </div>
              </button>
            </Panel>
          );
        })}
      </div>
      {app.automations.length === 0 && (
        <Empty
          title="A little help, on repeat."
          body="Create a routine to explore schedules, page watching, and webhook triggers."
        />
      )}
      {modal}
    </Page>
  );
}
