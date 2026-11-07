import React from "react";
import {
  ArrowRight,
  CircleAlert,
  Hand,
  RefreshCw,
  WifiOff,
} from "lucide-react";
import type { ChatScenario } from "../../types";
import { useApp } from "../../contexts/AppContext";
import { useRun } from "../../contexts/RunContext";
import { Button } from "../ui/Button";

/** Inline state banners for the demo scenario switcher. Each one offers a real remedy. */
export function ScenarioBanner({ scenario }: { scenario: ChatScenario }) {
  const { approvals, navigate, setChatScenario } = useApp();
  const { retryConnection, reconnecting, queue } = useRun();

  if (scenario === "error") {
    return (
      <div
        role="alert"
        className="flex flex-col gap-3 rounded-2xl border border-rose/25 bg-rose-soft px-4 py-3 sm:flex-row sm:items-center"
      >
        <CircleAlert
          className="hidden h-5 w-5 shrink-0 text-rose-ink sm:block"
          aria-hidden
        />
        <div className="min-w-0 flex-1 text-[13.5px]">
          <p className="font-medium text-ink">
            Couldn’t reach the model provider.
          </p>
          <p className="text-ink-2">
            Simulated error — your messages are safe. This is a runtime error,
            not something you need to fix.
          </p>
        </div>
        <div className="flex gap-2">
          <Button
            size="sm"
            variant="ghost"
            onClick={() => navigate("settings", "models")}
          >
            Switch model
          </Button>
          <Button
            size="sm"
            variant="secondary"
            icon={<RefreshCw />}
            loading={reconnecting}
            onClick={retryConnection}
          >
            Retry
          </Button>
        </div>
      </div>
    );
  }

  if (scenario === "offline") {
    return (
      <div
        role="status"
        className="flex flex-col gap-3 rounded-2xl border border-line bg-ink/[0.04] px-4 py-3 sm:flex-row sm:items-center"
      >
        <WifiOff
          className="hidden h-5 w-5 shrink-0 text-ink-2 sm:block"
          aria-hidden
        />
        <div className="min-w-0 flex-1 text-[13.5px]">
          <p className="font-medium text-ink">You’re offline (simulated).</p>
          <p className="text-ink-2">
            New messages queue and send when you reconnect
            {queue.length > 0 ? ` · ${queue.length} waiting` : ""}.
          </p>
        </div>
        <Button
          size="sm"
          variant="secondary"
          icon={<RefreshCw />}
          loading={reconnecting}
          onClick={retryConnection}
        >
          {reconnecting ? "Reconnecting…" : "Retry connection"}
        </Button>
      </div>
    );
  }

  if (scenario === "approval") {
    const pending = approvals.find((a) => a.status === "pending");
    return (
      <div className="flex flex-col gap-3 rounded-2xl border border-amber/30 bg-amber-soft px-4 py-3 sm:flex-row sm:items-center">
        <Hand
          className="hidden h-5 w-5 shrink-0 text-amber-ink sm:block"
          aria-hidden
        />
        <div className="min-w-0 flex-1 text-[13.5px]">
          {pending ? (
            <>
              <p className="font-medium text-ink">
                Blip is holding for your approval.
              </p>
              <p className="text-ink-2">
                {pending.title} ·{" "}
                {pending.reversible ? "reversible" : "irreversible"}
              </p>
            </>
          ) : (
            <>
              <p className="font-medium text-ink">No approvals are pending.</p>
              <p className="text-ink-2">
                Send a task containing “send”, “delete” or “trash” to see one
                created.
              </p>
            </>
          )}
        </div>
        {pending ? (
          <Button
            size="sm"
            variant="primary"
            iconRight={<ArrowRight />}
            onClick={() => navigate("approvals", pending.id)}
          >
            Review
          </Button>
        ) : (
          <Button
            size="sm"
            variant="secondary"
            onClick={() => setChatScenario("ready")}
          >
            Back to ready
          </Button>
        )}
      </div>
    );
  }

  return null;
}
