import React from "react";
import { CalendarClock, Eye, TriangleAlert, Webhook } from "lucide-react";
import { useApp } from "../../contexts/AppContext";
import { SectionTitle } from "../ui/Page";
import { Button } from "../ui/Button";
import { describeTrigger, nextRunDate } from "../../utils/schedule";
import { formatDay, formatTime, tzAbbrev } from "../../utils/time";

const ICONS = { schedule: CalendarClock, watch: Eye, webhook: Webhook };

export function NextUp() {
  const { automations, navigate } = useApp();
  const enabled = automations
    .filter((a) => a.enabled)
    .map((a) => ({ a, next: nextRunDate(a) }))
    .sort(
      (x, y) =>
        (x.next?.getTime() ?? Infinity) - (y.next?.getTime() ?? Infinity),
    );
  const paused = automations.filter((a) => !a.enabled && a.autoPausedReason);

  return (
    <section aria-labelledby="next-up">
      <SectionTitle
        id="next-up"
        action={
          <Button
            variant="ghost"
            size="sm"
            onClick={() => navigate("automations")}
          >
            Manage
          </Button>
        }
      >
        Next up
      </SectionTitle>
      <ul className="divide-y divide-line rounded-[20px] border border-line bg-surface">
        {enabled.map(({ a, next }) => {
          const Icon = ICONS[a.trigger.type];
          return (
            <li key={a.id}>
              <button
                type="button"
                onClick={() => navigate("automations", a.id)}
                className="flex w-full items-center gap-3 px-4 py-3.5 text-left transition-colors duration-150 hover:bg-ink/[0.02]"
              >
                <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-ink/[0.05] text-ink-2">
                  <Icon className="h-4 w-4" aria-hidden />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[14px] font-medium">
                    {a.name}
                  </span>
                  <span className="block truncate text-[12.5px] text-ink-3">
                    {describeTrigger(a.trigger)}
                  </span>
                </span>
                <span className="shrink-0 text-right">
                  {next ? (
                    <>
                      <span className="tabular block text-[13px] font-medium">
                        {formatTime(next, a.timezone)}
                      </span>
                      <span className="block text-[11.5px] text-ink-3">
                        {formatDay(next, a.timezone)} ·{" "}
                        {tzAbbrev(next, a.timezone)}
                      </span>
                    </>
                  ) : (
                    <span className="block text-[12.5px] text-ink-3">
                      On next event
                    </span>
                  )}
                </span>
              </button>
            </li>
          );
        })}
        {paused.map((a) => (
          <li key={a.id}>
            <button
              type="button"
              onClick={() => navigate("automations", a.id)}
              className="flex w-full items-center gap-3 px-4 py-3 text-left"
            >
              <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-amber-soft text-amber-ink">
                <TriangleAlert className="h-4 w-4" aria-hidden />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[14px] font-medium">
                  {a.name}
                </span>
                <span className="block truncate text-[12.5px] text-amber-ink">
                  Auto-paused · needs a target chat
                </span>
              </span>
              <span className="text-[12.5px] font-medium text-ink-2">Fix</span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
