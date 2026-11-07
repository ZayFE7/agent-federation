import React from "react";
import { ArrowRight, CircleCheck, Hand } from "lucide-react";
import { useApp } from "../../contexts/AppContext";
import { Button } from "../ui/Button";

export function AttentionStrip() {
  const { approvals, navigate } = useApp();
  const pending = approvals.filter((a) => a.status === "pending");
  const primary = pending.find((a) => a.id === "a-promo") ?? pending[0];

  if (!primary) {
    return (
      <section
        aria-label="Attention"
        className="flex items-center gap-4 rounded-[20px] border border-sage/25 bg-sage-soft px-5 py-4"
      >
        <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-sage/15 text-sage-ink">
          <CircleCheck className="h-5 w-5" aria-hidden />
        </span>
        <div>
          <p className="text-[15px] font-semibold">
            Nothing needs you right now.
          </p>
          <p className="text-[13.5px] text-ink-2">
            Blip will ask before anything irreversible.
          </p>
        </div>
      </section>
    );
  }

  const others = pending.length - 1;
  const headline =
    primary.id === "a-promo"
      ? "41 emails. One quick decision."
      : `${primary.affectedLabel}. One quick decision.`;

  return (
    <section
      aria-label="Needs your attention"
      className="flex flex-col gap-4 rounded-[20px] border border-amber/30 bg-amber-soft px-5 py-4 sm:flex-row sm:items-center"
    >
      <span className="hidden h-10 w-10 shrink-0 place-items-center rounded-xl bg-amber/15 text-amber-ink sm:grid">
        <Hand className="h-5 w-5" aria-hidden />
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-[16px] font-semibold tracking-[-0.01em] text-ink">
          {headline}
        </p>
        <p className="mt-0.5 text-[13.5px] leading-relaxed text-ink-2">
          {primary.title} in {primary.app}.{" "}
          {primary.reversible ? "Reversible" : "Irreversible"} — nothing happens
          until you approve.
          {others > 0 && (
            <span className="text-ink-3"> · {others} more waiting</span>
          )}
        </p>
      </div>
      <Button
        variant="primary"
        onClick={() => navigate("approvals", primary.id)}
        iconRight={<ArrowRight />}
        className="sm:self-center"
      >
        Review
      </Button>
    </section>
  );
}
