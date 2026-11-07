import React, { useState, useEffect } from "react";
import {
  Moon,
  Sun,
  Monitor,
  ShieldCheck,
  Download,
  Plus,
  Keyboard,
  Trash2,
  Check,
  Brain,
  Database,
  SlidersHorizontal,
} from "lucide-react";
import { useApp } from "../contexts/AppContext";
import { useRun } from "../contexts/RunContext";
import { Page, PageHeader } from "../components/ui/Page";
import { Button } from "../components/ui/Button";
import { Dialog } from "../components/ui/Dialog";
import { ConfirmDialog } from "../components/ui/ConfirmDialog";
import {
  Field,
  inputCls,
  textareaCls,
  selectCls,
} from "../components/ui/Field";
import { Panel, SafeNote } from "../components/workspace/Shared";
import { TIMEZONES } from "../utils/time";
import { MODELS } from "../data/settings";
import { uid } from "../utils/format";
import { downloadBlob } from "../utils/files";
import type { ThemePref, Provider } from "../types";
import { toast } from "sonner";
export function Settings() {
  const app = useApp(),
    run = useRun();
  const sections = ["general", "appearance", "models", "safety", "data"];
  const [tab, setTab] = useState(
      sections.includes(app.route.id ?? "") ? app.route.id! : "general",
    ),
    [adding, setAdding] = useState(false),
    [name, setName] = useState(""),
    [url, setUrl] = useState(""),
    [models, setModels] = useState(""),
    [reset, setReset] = useState(false),
    [remove, setRemove] = useState<Provider | null>(null),
    [err, setErr] = useState("");
  useEffect(() => {
    if (sections.includes(app.route.id ?? "")) setTab(app.route.id!);
  }, [app.route.id]);
  return (
    <Page>
      <PageHeader
        index="10"
        eyebrow="MAKE ROOM FOR YOUR WAY"
        title="A few personal touches."
        description="Your defaults, your boundaries, your data. Nothing hidden behind a magic switch."
      />
      <div className="ws-toolbar">
        {sections.map((s) => (
          <Button
            key={s}
            size="sm"
            variant={tab === s ? "primary" : "ghost"}
            onClick={() => {
              setTab(s);
              app.navigate("settings", s);
            }}
          >
            {s[0].toUpperCase() + s.slice(1)}
          </Button>
        ))}
      </div>
      <div className="max-w-3xl">
        {tab === "general" && (
          <div className="ws-stack">
            <Panel>
              <h2>Your workspace</h2>
              <div className="ws-grid two mt-6">
                <Field
                  label="What should Blip call you?"
                  htmlFor="settings-name"
                >
                  <input
                    id="settings-name"
                    className={inputCls}
                    maxLength={40}
                    value={app.settings.name}
                    onChange={(e) =>
                      app.updateSettings({ name: e.target.value })
                    }
                    onBlur={() => {
                      if (!app.settings.name.trim())
                        app.updateSettings({ name: "You" });
                    }}
                  />
                </Field>
                <Field label="Timezone" htmlFor="settings-timezone">
                  <select
                    id="settings-timezone"
                    className={selectCls}
                    value={app.settings.timezone}
                    onChange={(e) =>
                      app.updateSettings({ timezone: e.target.value })
                    }
                  >
                    {TIMEZONES.map((z) => (
                      <option key={z.id} value={z.id}>
                        {z.label}
                      </option>
                    ))}
                  </select>
                </Field>
              </div>
              <p className="ws-meta mt-5">
                Dates and schedules use this IANA timezone, including daylight
                saving changes.
              </p>
            </Panel>
            <Panel>
              <div className="ws-between">
                <div>
                  <h3>Keyboard-first, if you like.</h3>
                  <p className="ws-meta mt-2">
                    Jump, search, and keep your hands on the keys.
                  </p>
                </div>
                <Button
                  icon={<Keyboard />}
                  onClick={() => app.setShortcutsOpen(true)}
                >
                  Shortcuts
                </Button>
              </div>
            </Panel>
          </div>
        )}
        {tab === "appearance" && (
          <div className="ws-stack">
            <Panel>
              <h2>Set the mood.</h2>
              <p className="ws-muted mt-2">
                Quiet surfaces, clear contrast, and a little personality.
              </p>
              <div
                className="grid grid-cols-3 gap-3 mt-6"
                role="radiogroup"
                aria-label="Color theme"
              >
                {[
                  { id: "light", label: "Light", icon: Sun },
                  { id: "dark", label: "Dark", icon: Moon },
                  { id: "system", label: "System", icon: Monitor },
                ].map((t) => (
                  <button
                    key={t.id}
                    role="radio"
                    aria-checked={app.settings.theme === t.id}
                    onClick={() =>
                      app.updateSettings({ theme: t.id as ThemePref })
                    }
                    className={`border rounded-2xl p-4 text-center ${app.settings.theme === t.id ? "border-accent bg-accent-soft" : "border-line bg-surface"}`}
                  >
                    <div
                      className={`h-20 rounded-xl border border-line mb-4 flex gap-2 p-2 ${t.id === "dark" ? "bg-[#212228]" : "bg-[#f8f7f4]"}`}
                    >
                      <span
                        className={`w-1/4 rounded ${t.id === "dark" ? "bg-[#35363e]" : "bg-[#e7e5df]"}`}
                      />
                      <span className="flex-1">
                        <span className="h-2 w-2/3 block rounded bg-[#7278dc]/40 mt-2" />
                        <span className="h-9 block rounded border border-[#7278dc]/20 mt-2" />
                      </span>
                    </div>
                    <span className="flex items-center justify-center gap-2 text-sm font-medium">
                      <t.icon size={15} />
                      {t.label}
                    </span>
                  </button>
                ))}
              </div>
            </Panel>
            <Panel>
              <h2>A little motion. On your terms.</h2>
              <div className="mt-6">
                <Field
                  label="Reduced motion"
                  htmlFor="settings-motion"
                  hint="OS preference is respected by default. Reduced motion uses intentional still poses, not empty canvases."
                >
                  <select
                    id="settings-motion"
                    className={selectCls}
                    value={app.settings.reduceMotion}
                    onChange={(e) =>
                      app.updateSettings({
                        reduceMotion: e.target.value as "system" | "on" | "off",
                      })
                    }
                  >
                    <option value="system">Follow system preference</option>
                    <option value="on">Always reduce motion</option>
                    <option value="off">Allow animation</option>
                  </select>
                </Field>
              </div>
              <div className="ws-rule" />
              <label className="ws-between">
                <span>
                  <b className="text-sm block font-medium">Animate Blip</b>
                  <span className="ws-meta block mt-1">
                    The same character, with subtle state-aware expressions.
                  </span>
                </span>
                <button
                  type="button"
                  role="switch"
                  aria-checked={app.settings.mascotAnimated}
                  aria-label="Animate the mascot"
                  className={`ws-toggle ${app.settings.mascotAnimated ? "on" : ""}`}
                  onClick={() =>
                    app.updateSettings({
                      mascotAnimated: !app.settings.mascotAnimated,
                    })
                  }
                />
              </label>
              <Button
                variant="ghost"
                size="sm"
                className="mt-5 -ml-3"
                onClick={() => app.navigate("motion")}
              >
                Explore the 20-state motion lab →
              </Button>
            </Panel>
          </div>
        )}
        {tab === "models" && (
          <div className="ws-stack">
            <Panel>
              <h2>The right pace for the work.</h2>
              <p className="ws-muted mt-2 mb-6">
                A default preference for new conversations. No real model is
                connected in this demo.
              </p>
              <div className="ws-stack">
                {MODELS.map((m) => (
                  <label
                    className="flex items-start gap-3 rounded-xl border border-line p-4 cursor-pointer"
                    key={m.id}
                  >
                    <input
                      className="mt-1 accent-[rgb(var(--accent))]"
                      type="radio"
                      name="default-model"
                      checked={app.settings.model === m.id}
                      onChange={() => app.updateSettings({ model: m.id })}
                    />
                    <span>
                      <b className="text-sm block">{m.label}</b>
                      <span className="ws-meta block mt-1">{m.note}</span>
                    </span>
                  </label>
                ))}
              </div>
            </Panel>
            <Panel>
              <div className="ws-between">
                <h2>Provider metadata</h2>
                <Button
                  size="sm"
                  icon={<Plus />}
                  onClick={() => setAdding(true)}
                >
                  Add provider
                </Button>
              </div>
              <p className="ws-meta mt-3">
                Local configuration only. Never paste an API key here.
              </p>
              {app.settings.providers.map((p) => (
                <div
                  key={p.id}
                  className="border-b border-line last:border-0 py-5"
                >
                  <div className="ws-between">
                    <h3>{p.name}</h3>
                    <Button
                      size="icon"
                      variant="ghost"
                      aria-label={"Remove " + p.name}
                      onClick={() => setRemove(p)}
                    >
                      <Trash2 />
                    </Button>
                  </div>
                  <p className="ws-meta mt-1 break-all">{p.baseUrl}</p>
                  <p className="font-mono text-xs mt-3 text-accent-ink">
                    {p.models.join(" · ")}
                  </p>
                </div>
              ))}
            </Panel>
            <SafeNote>
              Production provider secrets belong in an encrypted backend vault.
              This frontend neither accepts nor stores them.
            </SafeNote>
          </div>
        )}
        {tab === "safety" && (
          <div className="ws-stack">
            <Panel>
              <div className="ws-flex">
                <ShieldCheck className="text-sage-ink" size={24} />
                <h2>Autonomy, with a clear boundary.</h2>
              </div>
              <p className="ws-muted mt-4">
                Blip can plan and prepare. Actions that reach people, change
                accounts, or remove data need an exact, scoped decision.
              </p>
              <div className="ws-rule" />
              {[
                "Sending emails or messages requires a preview of the recipient and content.",
                "Removing or modifying data requires an affected-item list and impact description.",
                "Approvals apply once to one exact action, not to an open-ended request.",
                "Skills and memory do not override approval requirements.",
                "A lost connection does not prove a real run has stopped.",
              ].map((t) => (
                <div
                  className="flex gap-3 text-sm leading-relaxed my-4"
                  key={t}
                >
                  <Check size={17} className="text-sage-ink shrink-0 mt-0.5" />
                  {t}
                </div>
              ))}
            </Panel>
            <SafeNote>
              This is the intended production safety model. UI controls are not
              security enforcement; the real agent backend must validate
              permissions, exact action hashes, expiry and idempotency.
            </SafeNote>
          </div>
        )}
        {tab === "data" && (
          <div className="ws-stack">
            <Panel>
              <h2>Your browser. Your demo data.</h2>
              <p className="ws-muted mt-3">
                Conversations, goals, local files, memories and settings live in
                this browser only. Export a copy before resetting or clearing
                site data.
              </p>
              <div className="ws-grid three mt-6">
                {[
                  ["Conversations", app.conversations.length],
                  ["Local files", app.library.length],
                  ["Memories", app.memories.length],
                ].map(([n, c]) => (
                  <div key={n} className="rounded-xl bg-sunken p-4">
                    <span className="text-2xl font-semibold">{c}</span>
                    <p className="ws-meta mt-1">{n}</p>
                  </div>
                ))}
              </div>
              <Button
                className="mt-6"
                icon={<Download />}
                onClick={() =>
                  downloadBlob(
                    "blip-local-export.json",
                    JSON.stringify(
                      {
                        format: "blip-frontend-demo-v1",
                        exportedAt: new Date().toISOString(),
                        settings: app.settings,
                        conversations: app.conversations,
                        approvals: app.approvals,
                        goals: app.goals,
                        automations: app.automations,
                        library: app.library,
                        connections: app.connections,
                        mcpServers: app.mcpServers,
                        memories: app.memories,
                        skills: app.skills,
                      },
                      null,
                      2,
                    ),
                    "application/json",
                  )
                }
              >
                Export local demo data
              </Button>
            </Panel>
            <Panel>
              <h2>Start fresh.</h2>
              <p className="ws-muted mt-3">
                Restore the initial sample workspace. This removes local uploads
                and edits. It does not touch any real repository, agent or
                connected app.
              </p>
              <Button
                variant="ghost"
                className="!text-rose-ink mt-5 -ml-3"
                icon={<Trash2 />}
                onClick={() => setReset(true)}
              >
                Reset this browser’s demo
              </Button>
            </Panel>
          </div>
        )}
      </div>
      <Dialog
        open={adding}
        onClose={() => setAdding(false)}
        title="Add a provider configuration"
        description="Metadata only. No API keys, authentication, or model requests."
        footer={
          <Button type="submit" form="provider-form" variant="primary">
            Save metadata
          </Button>
        }
      >
        <form
          className="ws-stack"
          id="provider-form"
          onSubmit={(e) => {
            e.preventDefault();
            try {
              const u = new URL(url);
              if (
                !["https:", "http:"].includes(u.protocol) ||
                u.username ||
                u.password ||
                u.search ||
                u.hash
              )
                throw new Error(
                  "Use an HTTP(S) URL without credentials, query, or fragment.",
                );
              if (
                u.protocol === "http:" &&
                !["localhost", "127.0.0.1", "[::1]"].includes(u.hostname)
              )
                throw new Error("Use HTTPS unless the endpoint is local.");
              u.pathname =
                u.pathname.replace(/\/+$/, "").replace(/\/v1$/, "") + "/v1";
              const p: Provider = {
                id: uid("provider"),
                name: name.trim(),
                baseUrl: u.toString().replace(/\/$/, ""),
                models: models
                  .split("\n")
                  .map((s) => s.trim())
                  .filter(Boolean),
              };
              if (!p.name || !p.models.length)
                throw new Error("Add a name and at least one model ID.");
              app.updateSettings({ providers: [...app.settings.providers, p] });
              setAdding(false);
              setName("");
              setUrl("");
              setModels("");
              setErr("");
              toast.success("Provider metadata saved locally.");
            } catch (e) {
              setErr(e instanceof Error ? e.message : "Invalid configuration.");
            }
          }}
        >
          <Field label="Provider name" htmlFor="provider-name">
            <input
              id="provider-name"
              required
              className={inputCls}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </Field>
          <Field label="Base URL" htmlFor="provider-url">
            <input
              id="provider-url"
              required
              type="url"
              className={inputCls}
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://api.example.com/v1"
            />
          </Field>
          <Field label="Model IDs · one per line" htmlFor="provider-models">
            <textarea
              id="provider-models"
              required
              className={textareaCls}
              value={models}
              onChange={(e) => setModels(e.target.value)}
            />
          </Field>
          {err && (
            <p role="alert" className="text-sm text-rose-ink">
              {err}
            </p>
          )}
          <SafeNote>
            Credentials are intentionally not collected. A production backend
            handles secret storage and real model validation.
          </SafeNote>
        </form>
      </Dialog>
      <ConfirmDialog
        open={reset}
        onClose={() => setReset(false)}
        title="Restore the sample workspace?"
        confirmWord="RESET"
        confirmLabel="Reset local demo"
        impact={[
          "Local uploads, edited conversations, goals, memories, connections and settings are replaced by sample data.",
          "Nothing changes in any real service. Export a copy first if you want to keep your local work.",
        ]}
        onConfirm={() => {
          run.stopRun();
          app.resetDemo();
          app.navigate("overview");
          toast.success("The sample workspace is back.");
        }}
      />
      <ConfirmDialog
        open={!!remove}
        onClose={() => setRemove(null)}
        title="Remove this provider metadata?"
        confirmLabel="Remove local provider"
        impact={[
          remove?.name ?? "",
          "No real API credentials or deployment configuration are modified.",
        ]}
        onConfirm={() =>
          app.updateSettings({
            providers: app.settings.providers.filter(
              (p) => p.id !== remove?.id,
            ),
          })
        }
      />
    </Page>
  );
}
