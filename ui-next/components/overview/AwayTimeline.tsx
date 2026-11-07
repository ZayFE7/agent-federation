import React from "react";
import { useApp } from "../../contexts/AppContext";
import { awayTimeline } from "../../data/overview";
import { SectionTitle } from "../ui/Page";
import { formatRelative } from "../../utils/time";

const DOT = {
  neutral: "bg-ink-3",
  accent: "bg-accent",
  healthy: "bg-sage",
  attention: "bg-amber",
  danger: "bg-rose",
  muted: "bg-line-strong",
};

export function AwayTimeline() {
  const { navigate } = useApp();
  return (
    <section aria-labelledby="away">
      <SectionTitle id="away">While you were away</SectionTitle>
      <ol className="relative">
        {awayTimeline.map((item, i) => (
          <li key={item.id} className="relative pl-7">
            {i < awayTimeline.length - 1 && (
              <span
                className="absolute left-[5px] top-4 h-full w-px bg-line"
                aria-hidden
              />
            )}
            <span
              className={`absolute left-0 top-[7px] h-[11px] w-[11px] rounded-full border-2 border-canvas ${DOT[item.tone]}`}
              aria-hidden
            />
            <button
              type="button"
              onClick={() => navigate(item.link.screen, item.link.id)}
              className="group block w-full pb-5 text-left"
            >
              <span className="flex items-baseline justify-between gap-3">
                <span className="text-[14px] font-medium group-hover:underline group-hover:decoration-line-strong group-hover:underline-offset-4">
                  {item.title}
                </span>
                <span className="tabular shrink-0 text-[12px] text-ink-3">
                  {formatRelative(item.time)}
                </span>
              </span>
              <span className="mt-0.5 block text-[13px] leading-relaxed text-ink-2">
                {item.detail}
              </span>
            </button>
          </li>
        ))}
      </ol>
    </section>
  );
}
