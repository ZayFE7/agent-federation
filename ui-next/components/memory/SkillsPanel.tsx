import React, { useEffect, useState } from "react";
import { Download, Eye, Plus, ShieldCheck, Trash2 } from "lucide-react";
import { toast } from "sonner";
import type { Skill } from "../../types";
import { useApp } from "../../contexts/AppContext";
import { Button } from "../ui/Button";
import { Badge } from "../ui/Badge";
import { Dialog } from "../ui/Dialog";
import { ConfirmDialog } from "../ui/ConfirmDialog";
import { EmptyState } from "../ui/EmptyState";
import { Field, inputCls, textareaCls } from "../ui/Field";
import { downloadBlob } from "../../utils/files";
import { matches, uid } from "../../utils/format";
import { formatRelative, nowIso } from "../../utils/time";

export function SkillsPanel({ query }: { query: string }) {
  const { skills, setSkills, announce } = useApp();
  const [inspect, setInspect] = useState<Skill | null>(null);
  const [remove, setRemove] = useState<Skill | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [name, setName] = useState("");
  const [desc, setDesc] = useState("");
  const [body, setBody] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    if (addOpen) {
      setName("");
      setDesc("");
      setBody("");
      setError("");
    }
  }, [addOpen]);

  const list = skills.filter((s) =>
    matches(query, s.name, s.description, s.body),
  );

  const add = () => {
    const slug = name.trim();
    if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(slug))
      return setError(
        "Use lowercase letters, numbers and dashes — e.g. meeting-notes.",
      );
    if (skills.some((s) => s.name === slug))
      return setError("A skill with this name already exists.");
    if (!desc.trim() || !body.trim())
      return setError("Add a description and instructions.");
    const skill: Skill = {
      id: uid("sk"),
      name: slug,
      description: desc.trim(),
      loading: "on-demand",
      uses: 0,
      addedAt: nowIso(),
      body: `---\nname: ${slug}\ndescription: ${desc.trim()}\n---\n\n${body.trim()}`,
    };
    setSkills((l) => [...l, skill]);
    setAddOpen(false);
    announce(`Skill ${slug} added.`);
    toast.success(`Added ${slug}`, {
      description: "Loads on demand when a task needs it.",
    });
  };

  return (
    <div>
      <div className="mb-6 flex flex-col gap-3 rounded-2xl bg-sage-soft p-4 sm:flex-row sm:items-center">
        <ShieldCheck
          className="hidden h-5 w-5 shrink-0 text-sage-ink sm:block"
          aria-hidden
        />
        <p className="flex-1 text-[13.5px] text-ink">
          <span className="font-medium">
            Skills shape how Blip works — they never bypass tool approvals.
          </span>{" "}
          Only names and descriptions load up front; full instructions load when
          a task needs them.
        </p>
        <Button
          variant="primary"
          size="sm"
          icon={<Plus />}
          onClick={() => setAddOpen(true)}
        >
          Add skill
        </Button>
      </div>

      {list.length === 0 ? (
        <div className="rounded-[22px] border border-dashed border-line-strong">
          <EmptyState
            title={query ? `No skills match “${query}”` : "No skills yet"}
            body="Skills are short playbooks Blip follows for recurring work."
          />
        </div>
      ) : (
        <ul className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {list.map((s) => (
            <li
              key={s.id}
              className="flex flex-col rounded-[20px] border border-line bg-surface p-5 shadow-soft"
            >
              <div className="flex items-start justify-between gap-2">
                <p className="font-mono text-[14px] font-medium">{s.name}</p>
                {s.loading === "loaded" ? (
                  <Badge tone="healthy" dot>
                    Loaded
                  </Badge>
                ) : (
                  <Badge tone="neutral" dot>
                    Loads on demand
                  </Badge>
                )}
              </div>
              <p className="mt-2 text-[13.5px] leading-relaxed text-ink-2">
                {s.description}
              </p>
              <p className="mt-3 text-[12px] text-ink-3">
                Used {s.uses} time{s.uses === 1 ? "" : "s"} · added{" "}
                {formatRelative(s.addedAt)}
              </p>
              <div className="mt-auto flex gap-2 pt-4">
                <Button
                  variant="secondary"
                  size="sm"
                  icon={<Eye />}
                  onClick={() => setInspect(s)}
                >
                  Inspect
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  icon={<Trash2 />}
                  onClick={() => setRemove(s)}
                >
                  Remove
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}

      <Dialog
        open={Boolean(inspect)}
        onClose={() => setInspect(null)}
        variant="side"
        eyebrow="SKILL.md"
        title={inspect?.name ?? ""}
        description={inspect?.description}
        footer={
          inspect && (
            <Button
              variant="primary"
              icon={<Download />}
              onClick={() =>
                downloadBlob(
                  `${inspect.name}-SKILL.md`,
                  inspect.body,
                  "text/markdown",
                )
              }
            >
              Download SKILL.md
            </Button>
          )
        }
      >
        {inspect && (
          <pre className="whitespace-pre-wrap rounded-2xl border border-line bg-sunken p-4 font-mono text-[12.5px] leading-relaxed">
            {inspect.body}
          </pre>
        )}
      </Dialog>

      <Dialog
        open={addOpen}
        onClose={() => setAddOpen(false)}
        title="Add a skill"
        description="Stored on this device only. Approvals still apply to every action the skill describes."
        footer={
          <>
            <Button variant="secondary" onClick={() => setAddOpen(false)}>
              Cancel
            </Button>
            <Button variant="primary" onClick={add}>
              Add skill
            </Button>
          </>
        }
      >
        <div className="space-y-5">
          <Field
            label="Name"
            htmlFor="sk-name"
            hint="Lowercase with dashes, like meeting-notes."
          >
            <input
              id="sk-name"
              data-autofocus
              className={`${inputCls} font-mono`}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </Field>
          <Field
            label="Description"
            htmlFor="sk-desc"
            hint="One line. This is all Blip loads until the skill is needed."
          >
            <input
              id="sk-desc"
              className={inputCls}
              value={desc}
              onChange={(e) => setDesc(e.target.value)}
            />
          </Field>
          <Field label="Instructions" htmlFor="sk-body">
            <textarea
              id="sk-body"
              className={`${textareaCls} min-h-[160px] font-mono text-[13px]`}
              value={body}
              onChange={(e) => setBody(e.target.value)}
              placeholder={
                "# Meeting notes\n\n1. Summarize decisions first.\n2. List owners for each action."
              }
            />
          </Field>
          {error && (
            <p className="text-[13px] text-rose-ink" role="alert">
              {error}
            </p>
          )}
        </div>
      </Dialog>

      <ConfirmDialog
        open={Boolean(remove)}
        onClose={() => setRemove(null)}
        title={`Remove ${remove?.name}?`}
        impact={[
          "Blip stops loading this playbook",
          "Past chats and files are not changed",
        ]}
        confirmLabel="Remove skill"
        onConfirm={() => {
          if (!remove) return;
          setSkills((l) => l.filter((x) => x.id !== remove.id));
          toast(`${remove.name} removed`);
        }}
      />
    </div>
  );
}
