import React, { useState, useEffect } from "react";
import {
  Check,
  ShieldCheck,
  ArrowRight,
  Undo2,
  X,
  ChevronRight,
  Inbox,
} from "lucide-react";
import { useApp } from "../contexts/AppContext";
import { useRun } from "../contexts/RunContext";
import { Page, PageHeader } from "../components/ui/Page";
import { Button } from "../components/ui/Button";
import { Badge } from "../components/ui/Badge";
import { inputCls, textareaCls } from "../components/ui/Field";
import { Panel, SafeNote, Empty } from "../components/workspace/Shared";
import { toast } from "sonner";
export function Approvals() {
  const app = useApp(),
    run = useRun();
  const [filter, setFilter] = useState("pending"),
    [excluded, setExcluded] = useState<string[]>([]),
    [edited, setEdited] = useState(""),
    [denying, setDenying] = useState(false),
    [reason, setReason] = useState("");
  const shown = app.approvals.filter(
    (a) => filter === "all" || a.status === filter,
  );
  const selected = app.approvals.find((a) => a.id === app.route.id) ?? shown[0];
  useEffect(() => {
    if (app.route.screen === "approvals" && !app.route.id && selected)
      app.navigate("approvals", selected.id, { replace: true });
  }, [app.route.screen, app.route.id, selected?.id, app.navigate]);
  useEffect(() => {
    setExcluded([]);
    setEdited(
      selected?.editable?.kind === "text" ? selected.editable.value : "",
    );
    setDenying(false);
    setReason("");
  }, [selected?.id]);
  return (
    <Page>
      <PageHeader
        index="03"
        eyebrow="YOUR DECISIONS"
        title={<>You’re in the loop.</>}
        description="Blip does the legwork. You decide what happens outside the workspace."
      />
      <div className="ws-toolbar">
        {["pending", "approved", "denied", "all"].map((s) => (
          <Button
            size="sm"
            variant={filter === s ? "primary" : "ghost"}
            key={s}
            onClick={() => setFilter(s)}
          >
            {s[0].toUpperCase() + s.slice(1)}{" "}
            <span className="ml-1 opacity-60">
              {
                app.approvals.filter((a) => s === "all" || a.status === s)
                  .length
              }
            </span>
          </Button>
        ))}
      </div>
      <div className="grid gap-6 xl:grid-cols-[300px_minmax(0,1fr)]">
        <div className="ws-stack">
          {shown.length === 0 ? (
            <Panel>
              <Empty
                title="All clear."
                body="Nothing needs a decision in this view."
              />
            </Panel>
          ) : (
            shown.map((a) => (
              <button
                key={a.id}
                className={`ws-row-button !items-start ${selected?.id === a.id ? "!border-accent/50 !bg-accent-soft/30" : ""}`}
                onClick={() => app.navigate("approvals", a.id)}
              >
                <ShieldCheck
                  size={19}
                  className="text-amber-ink mt-1 shrink-0"
                />
                <span>
                  <b className="text-sm block leading-relaxed">{a.title}</b>
                  <span className="ws-meta block mt-2">
                    {a.app} · {a.affectedLabel}
                  </span>
                  <span className="block mt-3">
                    <Badge
                      tone={
                        a.status === "pending"
                          ? "attention"
                          : a.status === "approved"
                            ? "healthy"
                            : "neutral"
                      }
                    >
                      {a.status}
                    </Badge>
                  </span>
                </span>
              </button>
            ))
          )}
        </div>
        {selected && (
          <Panel>
            <div className="ws-between flex-wrap">
              <p className="ws-kicker">PROPOSED ACTION · DEMO</p>
              <Badge
                tone={selected.reversible ? "healthy" : "attention"}
                icon={<Undo2 />}
              >
                {selected.reversible ? "Reversible" : "Not reversible"}
              </Badge>
            </div>
            <h2 className="!text-2xl mt-4 mb-3">{selected.title}</h2>
            <p className="ws-muted">{selected.rationale}</p>
            <div className="ws-rule" />
            <div className="ws-grid two">
              <div className="ws-label-pair">
                <small>App & account</small>
                <span>
                  {selected.app}
                  <br />
                  <small className="ws-meta">{selected.account}</small>
                </span>
              </div>
              <div className="ws-label-pair">
                <small>Exact tool</small>
                <span className="font-mono text-xs">{selected.tool}</span>
              </div>
            </div>
            <p className="ws-muted mt-5">{selected.reversibleNote}</p>
            <h3 className="mt-7 mb-3">What changes</h3>
            <div className="divide-y divide-line border border-line rounded-xl overflow-hidden">
              {selected.changes.map((c) => (
                <div className="p-4" key={c.label}>
                  <span className="ws-meta block mb-2">{c.label}</span>
                  <div className="flex items-center gap-4 text-sm">
                    <span className="text-ink-3">{c.before}</span>
                    <ArrowRight size={14} />
                    <b>{c.after}</b>
                  </div>
                </div>
              ))}
            </div>
            <h3 className="mt-7 mb-3">
              Affected items{" "}
              <span className="font-normal text-ink-3">
                · {selected.affectedLabel}
              </span>
            </h3>
            <div className="max-h-[300px] overflow-y-auto divide-y divide-line border border-line rounded-xl">
              {selected.affected.map((a) => (
                <label
                  key={a.id}
                  className="flex items-start gap-3 p-4 text-sm"
                >
                  <input
                    type="checkbox"
                    disabled={selected.status !== "pending"}
                    checked={!excluded.includes(a.id)}
                    className="accent-[rgb(var(--accent))] mt-1"
                    aria-label={`Include ${a.primary}`}
                    onChange={(e) =>
                      setExcluded((xs) =>
                        e.target.checked
                          ? xs.filter((x) => x !== a.id)
                          : [...xs, a.id],
                      )
                    }
                  />
                  <span className="flex-1">
                    <b className="block font-medium">{a.primary}</b>
                    <small className="ws-meta block mt-1">{a.secondary}</small>
                  </span>
                  <span className="ws-meta shrink-0">{a.meta}</span>
                </label>
              ))}
            </div>
            {selected.excludedNote && (
              <p className="text-xs text-sage-ink leading-relaxed mt-3">
                {selected.excludedNote}
              </p>
            )}
            {selected.editable?.kind === "text" && (
              <label className="block mt-6 text-sm font-medium">
                {selected.editable.label}
                <textarea
                  className={textareaCls + " mt-2"}
                  value={edited}
                  onChange={(e) => setEdited(e.target.value)}
                  disabled={selected.status !== "pending"}
                />
              </label>
            )}
            <details className="mt-6 text-xs">
              <summary className="cursor-pointer text-ink-2 py-3">
                Inspect exact parameters
              </summary>
              <pre className="ws-code">{selected.params}</pre>
            </details>
            <div className="mt-5">
              <SafeNote>
                This decision changes demo data only. No real email, file,
                account or external service is affected.
              </SafeNote>
            </div>
            {selected.status === "pending" ? (
              <>
                <div className="flex flex-wrap gap-3 mt-6">
                  <Button
                    variant="primary"
                    icon={<Check />}
                    disabled={
                      (selected.affected.length > 0 &&
                        excluded.length === selected.affected.length) ||
                      (selected.editable?.kind === "text" && !edited.trim())
                    }
                    onClick={() => {
                      const r = run.approve(selected.id, {
                        excludedIds: excluded,
                        text: edited || undefined,
                      });
                      if (r)
                        toast.success(
                          "Demo action approved. Receipt recorded.",
                        );
                    }}
                  >
                    Approve once · demo
                  </Button>
                  <Button icon={<X />} onClick={() => setDenying((o) => !o)}>
                    Deny action
                  </Button>
                  {selected.conversationId && (
                    <Button
                      variant="ghost"
                      onClick={() =>
                        app.navigate("chat", selected.conversationId!)
                      }
                    >
                      Open conversation
                    </Button>
                  )}
                </div>
                {denying && (
                  <div className="mt-5 rounded-xl bg-sunken p-4">
                    <label
                      htmlFor="deny-reason"
                      className="text-sm font-medium"
                    >
                      Why not?{" "}
                      <span className="ws-meta">Optional context for Blip</span>
                    </label>
                    <textarea
                      id="deny-reason"
                      value={reason}
                      onChange={(e) => setReason(e.target.value)}
                      className={textareaCls + " mt-2"}
                      placeholder="Ask me again with a narrower scope…"
                    />
                    <Button
                      className="mt-3"
                      onClick={() => {
                        run.deny(selected.id, reason || "Declined by user");
                        setDenying(false);
                        toast.info(
                          "Demo action denied. Nothing happened outside the browser.",
                        );
                      }}
                    >
                      Confirm denial
                    </Button>
                  </div>
                )}
              </>
            ) : (
              <div className="mt-6 rounded-xl border border-line bg-sunken p-4">
                <h3>
                  {selected.status === "approved"
                    ? "Decision recorded."
                    : "Action declined."}
                </h3>
                <p className="ws-meta mt-2">
                  {selected.receiptId
                    ? "Demo receipt " + selected.receiptId
                    : selected.denyReason}
                </p>
                <p className="ws-meta mt-1">{selected.resolvedAt}</p>
              </div>
            )}
          </Panel>
        )}
      </div>
    </Page>
  );
}
