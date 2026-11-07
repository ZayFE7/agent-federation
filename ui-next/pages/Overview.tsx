import React, { useEffect, useState } from "react";
import type { MascotStateId } from "../types";
import { useApp } from "../contexts/AppContext";
import { useRun } from "../contexts/RunContext";
import { useMediaQuery } from "../hooks/useMediaQuery";
import { Page } from "../components/ui/Page";
import { MascotStage } from "../components/mascot/MascotStage";
import { HeroComposer } from "../components/overview/HeroComposer";
import { AttentionStrip } from "../components/overview/AttentionStrip";
import { ActiveWork } from "../components/overview/ActiveWork";
import { NextUp } from "../components/overview/NextUp";
import { AwayTimeline } from "../components/overview/AwayTimeline";
import { StatsBand } from "../components/overview/StatsBand";
import { FirstRunNote } from "../components/overview/FirstRunNote";
import { formatLongDate, greeting } from "../utils/time";

const CHIP: Partial<Record<MascotStateId, string>> = {
  waking: "Waking up…",
  idle: "Ready when you are",
  listening: "Listening…",
  curious: "Sounds interesting",
  offline: "Offline · simulated",
};

export function Overview() {
  const { settings, navigate } = useApp();
  const { startTask, agentStatus } = useRun();
  const wide = useMediaQuery("(min-width: 1024px)");
  const [focused, setFocused] = useState(false);
  const [typing, setTyping] = useState(false);
  const [awake, setAwake] = useState(false);

  useEffect(() => {
    const t = window.setTimeout(() => setAwake(true), 1900);
    return () => window.clearTimeout(t);
  }, []);

  const heroState: MascotStateId =
    agentStatus === "offline"
      ? "offline"
      : !awake
        ? "waking"
        : typing
          ? "curious"
          : focused
            ? "listening"
            : "idle";

  return (
    <Page className="space-y-10 md:space-y-14">
      <section className="grid items-center gap-10 pt-2 lg:grid-cols-[1.12fr_1fr] lg:gap-14 lg:pt-6">
        <div>
          <p className="font-mono text-[11.5px] tracking-[0.04em] text-ink-3">
            {formatLongDate(new Date(), settings.timezone)} ·{" "}
            {greeting(new Date(), settings.timezone)}, {settings.name}
          </p>
          <h1 className="mt-5 text-[46px] font-semibold leading-[0.95] tracking-[-0.045em] sm:text-[60px] xl:text-[76px]">
            Your day,
            <br />a little lighter.
          </h1>
          <p className="mt-6 max-w-[520px] text-[16px] leading-relaxed text-ink-2 md:text-[17px]">
            Blip handles the busywork in the background — sorting, researching,
            drafting — and checks with you before anything you can’t undo.
          </p>
          <div className="mt-8 max-w-[600px]">
            <HeroComposer
              onFocusChange={setFocused}
              onTypingChange={setTyping}
              onSubmit={(text, attachments) => {
                const id = startTask(text, attachments);
                navigate("chat", id);
              }}
            />
          </div>
        </div>
        <div className="mx-auto w-full max-w-[460px] lg:max-w-none">
          <MascotStage
            state={heroState}
            size={wide ? 340 : 280}
            chip={
              <span
                className="inline-flex h-9 items-center gap-2 whitespace-nowrap rounded-full border border-line bg-surface px-3.5 text-[13px] font-medium shadow-soft"
                aria-live="polite"
              >
                <span
                  className={`h-2 w-2 rounded-full ${heroState === "offline" ? "bg-ink-3" : "bg-sage"}`}
                  aria-hidden
                />
                {CHIP[heroState] ?? "Ready when you are"}
              </span>
            }
          />
        </div>
      </section>

      <div className="space-y-4">
        <FirstRunNote />
        <AttentionStrip />
      </div>

      <div className="grid gap-10 lg:grid-cols-[minmax(0,1fr)_360px] lg:gap-12">
        <ActiveWork />
        <div className="space-y-10">
          <NextUp />
          <AwayTimeline />
        </div>
      </div>

      <StatsBand />
    </Page>
  );
}
