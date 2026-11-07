import React, { useState, useEffect } from "react";
import {
  Plus,
  ArrowRight,
  Pause,
  Play,
  Check,
  Target,
  Clock,
  FlaskConical,
  FileText,
  MessageSquare,
  TriangleAlert,
  LayoutGrid,
  List,
  ChevronRight,
  X,
} from "lucide-react";
import { useApp } from "../contexts/AppContext";
import { useRun } from "../contexts/RunContext";
import { Page, PageHeader, SectionTitle } from "../components/ui/Page";
import { Button } from "../components/ui/Button";
import { Badge } from "../components/ui/Badge";
import { Dialog } from "../components/ui/Dialog";
import { ConfirmDialog } from "../components/ui/ConfirmDialog";
import { Field, inputCls, textareaCls } from "../components/ui/Field";
import {
  Panel,
  Back,
  Steps,
  GoalTag,
  Empty,
  SafeNote,
} from "../components/workspace/Shared";
import { uid } from "../utils/format";
import { nowIso } from "../utils/time";
import type { Goal, GoalStatus } from "../types";
import { toast } from "sonner";
export function Goals() {
  const app = useApp(),
    runner = useRun();
  const [filter, setFilter] = useState("all"),
    [board, setBoard] = useState(false),
    [creating, setCreating] = useState(app.route.id === "new"),
    [title, setTitle] = useState(""),
    [brief, setBrief] = useState(""),
    [criteria, setCriteria] = useState(""),
    [minutes, setMinutes] = useState(30),
    [tools, setTools] = useState(24),
    [copy, setCopy] = useState(false),
    [cancel, setCancel] = useState(false),
    [instruction, setInstruction] = useState<string | null>(null);
  const goal = app.goals.find((g) => g.id === app.route.id);
  useEffect(() => {
    if (app.route.id === "new") setCreating(true);
  }, [app.route.id]);
  const close = () => {
    setCreating(false);
    if (app.route.id === "new") app.navigate("goals");
  };
  const patch = (p: Partial<Goal>) =>
    app.setGoals((gs) =>
      gs.map((g) =>
        g.id === goal?.id ? { ...g, ...p, updatedAt: nowIso() } : g,
      ),
    );
  const create = (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim() || !brief.trim() || !criteria.trim()) return;
    const cid = runner.createConversation(title.trim());
    const g: Goal = {
      id: uid("goal"),
      title: title.trim(),
      brief: brief.trim(),
      status: "paused",
      progress: 0,
      criteria: criteria
        .split("\n")
        .filter(Boolean)
        .map((t) => ({ id: uid("criterion"), text: t, state: "unmet" })),
      plan: [
        {
          id: uid("step"),
          label: "Understand the outcome and constraints",
          status: "todo",
        },
        {
          id: uid("step"),
          label: "Gather evidence and do the work",
          status: "todo",
        },
        {
          id: uid("step"),
          label: "Verify every success criterion",
          status: "todo",
        },
      ],
      activity: [
        {
          id: uid("event"),
          time: nowIso(),
          text: "Goal created in the local demo. Ready to start.",
          tone: "accent",
        },
      ],
      budget: {
        toolCalls: 0,
        toolLimit: Math.max(1, Math.min(500, tools)),
        minutes: 0,
        minuteLimit: Math.max(1, Math.min(240, minutes)),
      },
      conversationId: cid,
      instructions: [],
      sources: copy ? app.library.map((f) => f.id) : [],
      updatedAt: nowIso(),
      createdAt: nowIso(),
    };
    app.setGoals((gs) => [g, ...gs]);
    setCreating(false);
    app.navigate("goals", g.id);
    toast.success("Local goal created. Start a demo run when you’re ready.");
  };
  const modal = (
    <Dialog
      open={creating}
      onClose={close}
      title="A clear outcome. A little help."
      description="Give Blip the destination and the evidence that proves it arrived."
      size="lg"
      footer={
        <>
          <Button onClick={close}>Cancel</Button>
          <Button variant="primary" type="submit" form="new-goal">
            Create goal
          </Button>
        </>
      }
    >
      <form id="new-goal" className="ws-stack" onSubmit={create}>
        <div className="flex flex-wrap gap-2">
          {[
            [
              "Clean email",
              "Review promotional email without touching personal messages.",
              "An approved cleanup report with affected senders and counts.",
            ],
            [
              "Research brief",
              "Research a topic with primary-source citations.",
              "Every factual claim has a source. Missing evidence is flagged.",
            ],
            [
              "Tidy workspace",
              "Group files by purpose without overwriting originals.",
              "A browsable index, no lost files, and a change summary.",
            ],
          ].map(([n, b, c]) => (
            <Button
              key={n}
              size="sm"
              variant="subtle"
              onClick={() => {
                setTitle(n);
                setBrief(b);
                setCriteria(c);
              }}
            >
              {n}
            </Button>
          ))}
        </div>
        <Field label="Goal title" htmlFor="goal-title">
          <input
            autoFocus
            id="goal-title"
            className={inputCls}
            required
            maxLength={120}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="The result you want"
          />
        </Field>
        <Field
          label="The brief"
          htmlFor="goal-brief"
          hint="The worker gets a separate conversation. Include the constraints it needs."
        >
          <textarea
            id="goal-brief"
            className={textareaCls}
            required
            value={brief}
            onChange={(e) => setBrief(e.target.value)}
          />
        </Field>
        <Field
          label="What does done look like?"
          htmlFor="goal-success"
          hint="One measurable success criterion per line."
        >
          <textarea
            id="goal-success"
            className={textareaCls}
            required
            value={criteria}
            onChange={(e) => setCriteria(e.target.value)}
          />
        </Field>
        <div className="ws-grid two">
          <Field label="Time budget · minutes" htmlFor="goal-time">
            <input
              id="goal-time"
              className={inputCls}
              type="number"
              min="1"
              max="240"
              value={minutes}
              onChange={(e) => setMinutes(Number(e.target.value))}
            />
          </Field>
          <Field label="Tool-call budget" htmlFor="goal-tools">
            <input
              id="goal-tools"
              className={inputCls}
              type="number"
              min="1"
              max="500"
              value={tools}
              onChange={(e) => setTools(Number(e.target.value))}
            />
          </Field>
        </div>
        <label className="ws-flex text-sm">
          <input
            type="checkbox"
            checked={copy}
            onChange={(e) => setCopy(e.target.checked)}
          />
          Include references to current local Library files
        </label>
        <SafeNote>
          Creates a local demo goal, not a real autonomous task. Sending,
          deleting and other side effects still require a separate approval.
        </SafeNote>
      </form>
    </Dialog>
  );
  if (goal)
    return (
      <Page>
        <Back screen="goals" label="All goals" />
        <PageHeader
          index="04"
          eyebrow="OUTCOME, NOT BUSYWORK"
          title={goal.title}
          description={
            goal.currentStep ??
            "One objective. An inspectable plan. Evidence for every claim."
          }
          actions={
            <>
              <GoalTag status={goal.status} />
              <Button
                icon={goal.status === "paused" ? <Play /> : <Pause />}
                disabled={
                  goal.status === "complete" || goal.status === "cancelled"
                }
                onClick={() => {
                  patch({
                    status: goal.status === "paused" ? "in-progress" : "paused",
                  });
                  toast.info(
                    "Demo goal state updated. No background agent is running.",
                  );
                }}
              >
                {goal.status === "paused" ? "Resume" : "Pause"}
              </Button>
            </>
          }
        />
        {(goal.blocker || goal.error) && (
          <div className="ws-card !bg-amber-soft mb-6">
            <div className="ws-flex text-amber-ink">
              <TriangleAlert size={20} />
              <b className="text-sm">A little help is needed.</b>
            </div>
            <p className="ws-muted mt-3">{goal.blocker ?? goal.error}</p>
            {!goal.conversationId && (
              <Button
                className="mt-4"
                onClick={() => {
                  const id = runner.createConversation(goal.title);
                  patch({
                    conversationId: id,
                    blocker: undefined,
                    error: undefined,
                    status: "paused",
                  });
                }}
              >
                Create replacement conversation
              </Button>
            )}
          </div>
        )}
        <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_300px]">
          <div className="ws-stack">
            <Panel>
              <p className="ws-kicker">THE OBJECTIVE</p>
              <p className="ws-muted mt-4">{goal.brief}</p>
              <div className="ws-rule" />
              <div className="ws-between mb-3">
                <h3>Plan</h3>
                <span className="ws-meta">{goal.progress}% complete</span>
              </div>
              <div className="ws-progress mb-4">
                <span style={{ width: goal.progress + "%" }} />
              </div>
              <Steps steps={goal.plan} />
            </Panel>
            <Panel>
              <div className="ws-flex mb-5">
                <FlaskConical size={18} className="text-accent-ink" />
                <h2>Proof, not just a checkmark.</h2>
              </div>
              {goal.criteria.map((c) => (
                <div
                  key={c.id}
                  className="flex gap-3 border-b border-line py-4 last:border-0"
                >
                  <span
                    className={`ws-step-dot ${c.state === "met" ? "done" : ""}`}
                  >
                    {c.state === "met" ? <Check size={14} /> : <span>·</span>}
                  </span>
                  <div>
                    <p className="text-sm font-medium">{c.text}</p>
                    <p className="ws-meta mt-2 leading-relaxed">
                      {c.evidence ?? "Evidence has not been provided yet."}
                    </p>
                  </div>
                </div>
              ))}
            </Panel>
            <Panel>
              <h2 className="mb-4">Activity</h2>
              {goal.activity.map((a) => (
                <div
                  key={a.id}
                  className="flex gap-4 py-3 border-b border-line last:border-0"
                >
                  <span className="w-2 h-2 rounded-full bg-accent/60 shrink-0 mt-1.5" />
                  <div>
                    <p className="text-sm">{a.text}</p>
                    <p className="ws-meta mt-1">
                      {new Date(a.time).toLocaleString()}
                    </p>
                  </div>
                </div>
              ))}
              {goal.instructions.map((t, i) => (
                <div className="ws-safe-note mt-3" key={i}>
                  <FileText size={14} />
                  <p>{t}</p>
                </div>
              ))}
            </Panel>
          </div>
          <div className="ws-stack">
            <Panel>
              <p className="ws-kicker mb-5">GUARDRAILS</p>
              {[
                ["Tool calls", goal.budget.toolCalls, goal.budget.toolLimit],
                ["Minutes", goal.budget.minutes, goal.budget.minuteLimit],
              ].map(([n, v, max]) => (
                <div key={n} className="mb-5">
                  <div className="ws-between text-sm mb-3">
                    <span>{n}</span>
                    <span className="font-mono text-xs">
                      {v} / {max}
                    </span>
                  </div>
                  <div className="ws-progress">
                    <span
                      style={{
                        width:
                          Math.min(100, (Number(v) / Number(max)) * 100) + "%",
                      }}
                    />
                  </div>
                </div>
              ))}
              <SafeNote>
                Budgets are local fixture values. A production backend must
                enforce them.
              </SafeNote>
            </Panel>
            <Panel>
              <h3 className="mb-4">Keep it moving</h3>
              <div className="ws-stack">
                <Button
                  icon={<MessageSquare />}
                  onClick={() => {
                    if (goal.conversationId)
                      app.navigate("chat", goal.conversationId);
                    else toast.info("Create a replacement conversation first.");
                  }}
                >
                  Open conversation
                </Button>
                <Button icon={<Plus />} onClick={() => setInstruction("")}>
                  Add instruction
                </Button>
                <Button
                  variant="primary"
                  icon={<Play />}
                  disabled={goal.status === "cancelled"}
                  onClick={() => {
                    const cid =
                      goal.conversationId ??
                      runner.createConversation(goal.title);
                    patch({ conversationId: cid, status: "in-progress" });
                    runner.sendMessage(cid, goal.brief);
                    app.navigate("chat", cid);
                  }}
                >
                  Run a demo turn
                </Button>
                <Button
                  variant="ghost"
                  className="!text-rose-ink"
                  onClick={() => setCancel(true)}
                  disabled={goal.status === "cancelled"}
                >
                  Cancel goal
                </Button>
              </div>
            </Panel>
          </div>
        </div>
        <Dialog
          open={instruction !== null}
          onClose={() => setInstruction(null)}
          title="A little more context"
          footer={
            <Button
              variant="primary"
              disabled={!instruction?.trim()}
              onClick={() => {
                patch({
                  instructions: [...goal.instructions, instruction!.trim()],
                });
                setInstruction(null);
                toast.success("Instruction added locally.");
              }}
            >
              Save instruction
            </Button>
          }
        >
          <label htmlFor="goal-instruction" className="sr-only">
            Instruction
          </label>
          <textarea
            id="goal-instruction"
            className={textareaCls}
            value={instruction ?? ""}
            onChange={(e) => setInstruction(e.target.value)}
          />
        </Dialog>
        <ConfirmDialog
          open={cancel}
          onClose={() => setCancel(false)}
          title="Cancel this goal?"
          confirmLabel="Cancel local goal"
          impact={[
            "Stops the local demo goal state.",
            "Already-created outputs remain in the Library. Real effects cannot be undone by cancellation.",
          ]}
          onConfirm={() => {
            patch({ status: "cancelled" });
            toast.info("Local goal cancelled.");
          }}
        />
        {modal}
      </Page>
    );
  const visible = app.goals.filter(
    (g) => filter === "all" || g.status === filter,
  );
  return (
    <Page>
      <PageHeader
        index="04"
        eyebrow="THE BIGGER PICTURE"
        title="Move things forward."
        description="Give Blip an outcome. See the plan, the progress, and the proof."
        actions={
          <Button
            variant="primary"
            icon={<Plus />}
            onClick={() => setCreating(true)}
          >
            New goal
          </Button>
        }
      />
      <div className="ws-toolbar">
        <div className="flex gap-1 flex-wrap">
          {[
            ["all", "All"],
            ["in-progress", "In progress"],
            ["needs-you", "Needs you"],
            ["complete", "Complete"],
            ["paused", "Paused"],
          ].map(([v, n]) => (
            <Button
              key={v}
              size="sm"
              variant={filter === v ? "primary" : "ghost"}
              onClick={() => setFilter(v)}
            >
              {n}
            </Button>
          ))}
        </div>
        <div className="ml-auto flex gap-1">
          <Button
            size="icon"
            variant={!board ? "subtle" : "ghost"}
            aria-label="List view"
            onClick={() => setBoard(false)}
          >
            <List />
          </Button>
          <Button
            size="icon"
            variant={board ? "subtle" : "ghost"}
            aria-label="Board view"
            onClick={() => setBoard(true)}
          >
            <LayoutGrid />
          </Button>
        </div>
      </div>
      {visible.length === 0 ? (
        <Panel>
          <Empty
            title="Room for your next goal."
            body="Start with a clear outcome and let Blip work out a plan."
            action={
              <Button onClick={() => setCreating(true)}>Create a goal</Button>
            }
          />
        </Panel>
      ) : (
        <div className={board ? "ws-grid three" : "ws-stack"}>
          {visible.map((g, i) => (
            <button
              key={g.id}
              className="ws-card ws-goal-card"
              onClick={() => app.navigate("goals", g.id)}
            >
              <div className="ws-between">
                <span className="ws-kicker">
                  GOAL {String(i + 1).padStart(2, "0")}
                </span>
                <GoalTag status={g.status} />
              </div>
              <h2 className="mt-5 mb-2">{g.title}</h2>
              <p className="ws-muted line-clamp-2">
                {g.blocker ?? g.currentStep ?? g.brief}
              </p>
              <div className="ws-progress mt-6">
                <span style={{ width: g.progress + "%" }} />
              </div>
              <div className="ws-between mt-4">
                <span className="ws-meta">
                  {g.progress}% ·{" "}
                  {g.plan.filter((p) => p.status === "done").length} /{" "}
                  {g.plan.length} steps
                </span>
                <span className="text-xs font-medium text-accent-ink flex items-center gap-1">
                  View plan <ChevronRight size={13} />
                </span>
              </div>
            </button>
          ))}
        </div>
      )}
      {modal}
    </Page>
  );
}
