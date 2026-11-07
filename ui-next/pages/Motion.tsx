import React, { useState, useEffect } from "react";
import { Play, Pause, RotateCcw, ArrowRight } from "lucide-react";
import { useApp } from "../contexts/AppContext";
import { Page, PageHeader } from "../components/ui/Page";
import { Button } from "../components/ui/Button";
import { Badge } from "../components/ui/Badge";
import { MascotStage } from "../components/mascot/MascotStage";
import { Mascot } from "../components/mascot/Mascot";
import { Panel, SafeNote } from "../components/workspace/Shared";
import { MASCOT_STATES, MOTION_SEQUENCE } from "../data/mascotStates";
import type { MascotStateId } from "../types";
export function Motion() {
  const app = useApp();
  const [state, setState] = useState<MascotStateId>("idle"),
    [paused, setPaused] = useState(false),
    [speed, setSpeed] = useState(1),
    [replay, setReplay] = useState(0),
    [cycle, setCycle] = useState(false),
    [reduce, setReduce] = useState(false);
  const info = MASCOT_STATES.find((s) => s.id === state)!;
  const reduced = app.reducedMotion || reduce || !app.settings.mascotAnimated;
  useEffect(() => {
    if (!cycle) return;
    let i = 0;
    setPaused(false);
    setState(MOTION_SEQUENCE[0]);
    setReplay((r) => r + 1);
    const timer = window.setInterval(() => {
      i++;
      if (i >= MOTION_SEQUENCE.length) {
        setCycle(false);
        return;
      }
      setState(MOTION_SEQUENCE[i]);
      setReplay((r) => r + 1);
    }, 3200);
    return () => window.clearInterval(timer);
  }, [cycle]);
  return (
    <Page>
      <PageHeader
        index="11"
        eyebrow="A FAMILIAR LITTLE FACE"
        title="Same Blip. More life."
        description="The original black disk, the original white eyes, all twenty expressions. Now with smoother transitions and a little more intention."
        actions={
          <Badge tone={reduced ? "neutral" : "healthy"} dot>
            {reduced ? "Reduced motion" : "Motion enabled"}
          </Badge>
        }
      />
      <div className="grid gap-7 lg:grid-cols-[minmax(0,1fr)_330px]">
        <div className="max-w-[650px] w-full mx-auto">
          <MascotStage
            state={state}
            size={420}
            paused={paused}
            speed={speed}
            reducedMotion={reduced}
            replayKey={replay}
            chip={
              <span className="rounded-full px-4 py-2 bg-surface border border-line shadow-soft text-sm font-medium">
                {info.label}
                {cycle ? " · work cycle" : ""}
              </span>
            }
          />
        </div>
        <div className="ws-stack">
          <Panel>
            <p className="ws-kicker">
              {info.group} /{" "}
              {String(MASCOT_STATES.indexOf(info) + 1).padStart(2, "0")}
            </p>
            <h2 className="!text-3xl mt-4">{info.label}</h2>
            <p className="ws-muted mt-4">{info.note}</p>
            <div className="ws-rule" />
            <div className="flex flex-wrap gap-2">
              <Button
                variant="primary"
                icon={paused ? <Play /> : <Pause />}
                onClick={() => {
                  setCycle(false);
                  setPaused((p) => !p);
                }}
                disabled={reduced}
              >
                {paused ? "Play" : "Pause"}
              </Button>
              <Button
                icon={<RotateCcw />}
                onClick={() => {
                  setReplay((r) => r + 1);
                  setPaused(false);
                }}
              >
                Replay
              </Button>
            </div>
            <label className="block mt-6">
              <span className="ws-between text-sm">
                <span>Playback speed</span>
                <span className="font-mono text-xs">{speed.toFixed(2)}×</span>
              </span>
              <input
                className="w-full mt-4 accent-[rgb(var(--accent))]"
                aria-label="Mascot playback speed"
                type="range"
                min="0.25"
                max="2"
                step="0.25"
                value={speed}
                onChange={(e) => setSpeed(Number(e.target.value))}
              />
            </label>
            <label className="ws-flex mt-6 text-sm">
              <input
                type="checkbox"
                checked={reduce}
                onChange={(e) => setReduce(e.target.checked)}
              />
              Preview reduced motion
            </label>
            <p className="ws-meta mt-3 leading-relaxed">
              System and app reduced-motion preferences always take priority
              here.
            </p>
          </Panel>
          <Panel>
            <h3>A little work cycle.</h3>
            <p className="ws-muted mt-3">
              Listen, think, search, write, ask, finish. One continuous
              character—not a swap between unrelated animations.
            </p>
            <Button
              className="mt-5"
              icon={cycle ? <Pause /> : <Play />}
              onClick={() => setCycle((c) => !c)}
            >
              {cycle ? "Stop cycle" : "Play a work cycle"}
            </Button>
          </Panel>
        </div>
      </div>
      <div className="mt-10">
        <h2 className="text-lg font-semibold mb-5">A state for the moment.</h2>
        <div className="grid grid-cols-2 sm:grid-cols-4 xl:grid-cols-5 gap-3">
          {MASCOT_STATES.map((s) => (
            <button
              key={s.id}
              onClick={() => {
                setCycle(false);
                setState(s.id);
                setReplay((r) => r + 1);
                setPaused(false);
              }}
              aria-pressed={state === s.id}
              className={`rounded-2xl border p-3 text-left transition-colors ${state === s.id ? "border-accent/50 bg-accent-soft" : "border-line bg-surface hover:border-line-strong"}`}
            >
              <div className="flex justify-center bg-stage rounded-xl mb-3">
                <Mascot
                  state={s.id}
                  size={110}
                  paused
                  reducedMotion
                  decorative
                />
              </div>
              <span className="text-sm font-medium block">{s.label}</span>
              <span className="ws-meta block mt-1">{s.group}</span>
            </button>
          ))}
        </div>
      </div>
      <div className="mt-7">
        <SafeNote>
          Uses the exact original 20 pose definitions. The new shared renderer
          blends geometric poses, plays one-shot reactions once, caps device
          pixels at 2×, and stops offscreen or hidden-page animation. Mascot
          state is visual feedback, never proof a real tool executed.
        </SafeNote>
      </div>
    </Page>
  );
}
