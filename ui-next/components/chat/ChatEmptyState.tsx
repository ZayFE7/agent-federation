import React from "react";
import { ArrowUpRight } from "lucide-react";
import type { MascotStateId } from "../../types";
import { Mascot } from "../mascot/Mascot";
import { chatStarters } from "../../data/overview";

interface ChatEmptyStateProps {
  mascotState: MascotStateId;
  onPick: (prompt: string) => void;
}

export function ChatEmptyState({ mascotState, onPick }: ChatEmptyStateProps) {
  return (
    <div className="mx-auto flex w-full max-w-[680px] flex-col items-center px-5 py-10 text-center md:py-16">
      <Mascot state={mascotState} size={132} />
      <h2 className="mt-4 text-[28px] font-semibold leading-tight tracking-[-0.03em] md:text-[34px]">
        What should we take off your plate?
      </h2>
      <p className="mt-2 max-w-md text-[15px] text-ink-2">
        Pick a starter or type your own. Blip shows its plan, and asks before
        anything you can’t undo.
      </p>
      <ul className="mt-8 grid w-full gap-3 text-left sm:grid-cols-2">
        {chatStarters.map((s) => (
          <li key={s.id}>
            <button
              type="button"
              onClick={() => onPick(s.prompt)}
              className="group flex h-full w-full flex-col rounded-2xl border border-line bg-surface p-4 shadow-soft transition-[transform,box-shadow,border-color] duration-150 ease-out hover:-translate-y-px hover:border-line-strong hover:shadow-lift"
            >
              <span className="flex w-full items-start justify-between gap-2">
                <span className="text-[14.5px] font-medium">{s.title}</span>
                <ArrowUpRight
                  className="h-4 w-4 shrink-0 text-ink-3 transition-colors group-hover:text-ink"
                  aria-hidden
                />
              </span>
              <span className="mt-1 text-[13px] leading-relaxed text-ink-2">
                {s.body}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
