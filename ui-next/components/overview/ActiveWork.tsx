import React from "react";
import { ArrowRight, Clock, Target } from "lucide-react";
import { useApp } from "../../contexts/AppContext";
import { GoalStatusBadge, GOAL_STATUS } from "../goals/GoalStatusBadge";
import { ProgressBar } from "../ui/ProgressBar";
import { Button } from "../ui/Button";
import { SectionTitle } from "../ui/Page";
import { EmptyState } from "../ui/EmptyState";

export function ActiveWork() {
  const { goals, conversations, navigate } = useApp();
  const active = goals
    .filter((g) => g.status === "in-progress" || g.status === "needs-you")
    .slice(0, 4);

  return (
    <section aria-labelledby="active-work">
      <SectionTitle
        id="active-work"
        action={
          <Button
            variant="ghost"
            size="sm"
            onClick={() => navigate("goals")}
            iconRight={<ArrowRight />}
          >
            All goals
          </Button>
        }
      >
        Active work
      </SectionTitle>
      {active.length === 0 ? (
        <div className="rounded-[20px] border border-dashed border-line-strong">
          <EmptyState
            icon={<Target />}
            title="No goals in motion"
            body="Give Blip a longer task with success criteria, and it will show up here."
            action={
              <Button onClick={() => navigate("goals", "new")}>New goal</Button>
            }
          />
        </div>
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {active.map((g) => {
            const hasChat =
              g.conversationId &&
              conversations.some((c) => c.id === g.conversationId);
            return (
              <article
                key={g.id}
                className="flex flex-col rounded-[20px] border border-line bg-surface p-5 shadow-soft"
              >
                <div className="flex items-start justify-between gap-3">
                  <h3 className="text-[16px] font-semibold leading-snug tracking-[-0.01em]">
                    {g.title}
                  </h3>
                  <GoalStatusBadge status={g.status} />
                </div>
                <p className="mt-1.5 line-clamp-2 min-h-[40px] text-[13.5px] leading-relaxed text-ink-2">
                  {g.currentStep}
                </p>
                <div className="mt-5 flex items-center gap-3">
                  <ProgressBar
                    value={g.progress}
                    tone={
                      GOAL_STATUS[g.status].bar === "ink"
                        ? "ink"
                        : GOAL_STATUS[g.status].bar
                    }
                    label={`${g.title} progress`}
                  />
                  <span className="tabular w-9 text-right text-[12.5px] text-ink-2">
                    {g.progress}%
                  </span>
                </div>
                <div className="mt-auto flex items-center justify-between gap-2 pt-5">
                  <span className="flex min-w-0 items-center gap-1.5 text-[12.5px] text-ink-3">
                    <Clock className="h-3.5 w-3.5 shrink-0" aria-hidden />
                    <span className="truncate">{g.eta ?? "No estimate"}</span>
                  </span>
                  <div className="flex shrink-0 gap-1">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => navigate("goals", g.id)}
                    >
                      Details
                    </Button>
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() =>
                        hasChat
                          ? navigate("chat", g.conversationId ?? undefined)
                          : navigate("goals", g.id)
                      }
                      iconRight={<ArrowRight />}
                    >
                      View run
                    </Button>
                  </div>
                </div>
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}
