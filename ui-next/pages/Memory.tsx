import React, { useState } from "react";
import { Plus, Brain, BookOpen, Pencil, Trash2 } from "lucide-react";
import { toast } from "sonner";
import type { Memory as MemoryRecord } from "../types";
import { useApp } from "../contexts/AppContext";
import { Page, PageHeader } from "../components/ui/Page";
import { Button } from "../components/ui/Button";
import { Badge } from "../components/ui/Badge";
import { ConfirmDialog } from "../components/ui/ConfirmDialog";
import {
  MemoryDialog,
  CATEGORY_LABEL,
} from "../components/memory/MemoryDialog";
import { SkillsPanel } from "../components/memory/SkillsPanel";
import {
  Panel,
  SearchBox,
  Empty,
  SafeNote,
} from "../components/workspace/Shared";
import { uid, matches } from "../utils/format";
import { formatRelative, nowIso } from "../utils/time";
export function Memory() {
  const app = useApp();
  const [tab, setTab] = useState<"memory" | "skills">("memory"),
    [query, setQuery] = useState(""),
    [edit, setEdit] = useState<MemoryRecord | "new" | null>(null),
    [remove, setRemove] = useState<MemoryRecord | "all" | null>(null);
  const list = app.memories.filter((m) =>
    matches(query, m.text, m.category, m.origin),
  );
  return (
    <Page>
      <PageHeader
        index="09"
        eyebrow="THE LITTLE THINGS, REMEMBERED"
        title="Gets to know your way."
        description="Useful context, not a mystery box. See, edit, and remove what Blip remembers and the skills it can load."
        actions={
          tab === "memory" ? (
            <Button
              variant="primary"
              icon={<Plus />}
              onClick={() => setEdit("new")}
            >
              Add memory
            </Button>
          ) : undefined
        }
      />
      <div className="ws-toolbar">
        <Button
          icon={<Brain />}
          variant={tab === "memory" ? "primary" : "ghost"}
          onClick={() => setTab("memory")}
        >
          Memory · {app.memories.length}
        </Button>
        <Button
          icon={<BookOpen />}
          variant={tab === "skills" ? "primary" : "ghost"}
          onClick={() => setTab("skills")}
        >
          Skills · {app.skills.length}
        </Button>
        <div className="ml-auto">
          <SearchBox
            value={query}
            onChange={setQuery}
            placeholder={
              tab === "memory" ? "Search what Blip knows…" : "Find a skill…"
            }
          />
        </div>
      </div>
      {tab === "memory" ? (
        <>
          <div className="ws-between mb-5">
            <p className="ws-meta">
              {list.length} visible memories · explicitly saved, always editable
            </p>
            <Button
              size="sm"
              variant="ghost"
              className="!text-rose-ink"
              disabled={!app.memories.length}
              onClick={() => setRemove("all")}
            >
              Clear all
            </Button>
          </div>
          <div className="ws-stack">
            {list.map((m) => (
              <Panel key={m.id}>
                <div className="ws-between">
                  <Badge>{CATEGORY_LABEL[m.category]}</Badge>
                  <div className="ws-flex">
                    <span
                      className="ws-meta"
                      aria-label={"Importance " + m.importance + " of 3"}
                    >
                      {"●".repeat(m.importance)}
                      <span className="opacity-20">
                        {"●".repeat(3 - m.importance)}
                      </span>
                    </span>
                    <Button
                      size="icon"
                      variant="ghost"
                      aria-label="Edit memory"
                      onClick={() => setEdit(m)}
                    >
                      <Pencil />
                    </Button>
                    <Button
                      size="icon"
                      variant="ghost"
                      aria-label="Delete memory"
                      onClick={() => setRemove(m)}
                    >
                      <Trash2 />
                    </Button>
                  </div>
                </div>
                <p className="mt-5 text-[16px] leading-relaxed">{m.text}</p>
                <p className="ws-meta mt-5">
                  {m.origin} · {formatRelative(m.date)}
                </p>
              </Panel>
            ))}
          </div>
          {!list.length && (
            <Panel>
              <Empty
                title="A clear head."
                body="No memories match. Add a preference you want Blip to keep in mind."
                action={
                  <Button onClick={() => setEdit("new")}>Add a memory</Button>
                }
              />
            </Panel>
          )}
        </>
      ) : (
        <SkillsPanel query={query} />
      )}
      <div className="mt-7">
        <SafeNote>
          Memories are explicit local records. Skill instructions are inert text
          in this frontend. They are not executed and cannot bypass real
          tool-approval requirements.
        </SafeNote>
      </div>
      <MemoryDialog
        open={edit !== null}
        initial={edit && edit !== "new" ? edit : undefined}
        onClose={() => setEdit(null)}
        onSave={(data) => {
          const m: MemoryRecord = {
            ...data,
            id: edit && edit !== "new" ? edit.id : uid("memory"),
            origin:
              edit === "new"
                ? "Added explicitly in local demo"
                : "Edited in local demo",
            date: nowIso(),
          };
          app.setMemories((ms) =>
            edit === "new"
              ? [m, ...ms]
              : ms.map((x) => (x.id === m.id ? m : x)),
          );
          app.announce("Memory saved locally.");
          toast.success("Memory saved locally.");
        }}
      />
      <ConfirmDialog
        open={remove !== null}
        onClose={() => setRemove(null)}
        title={
          remove === "all"
            ? "Clear all local memories?"
            : "Remove this local memory?"
        }
        confirmLabel="Remove local data"
        confirmWord={remove === "all" ? "DELETE" : undefined}
        impact={[
          remove === "all"
            ? `${app.memories.length} local memories will be removed.`
            : (remove?.text ?? ""),
          "No data is deleted from a real agent or connected service.",
        ]}
        onConfirm={() => {
          app.setMemories((ms) =>
            remove === "all" ? [] : ms.filter((m) => m.id !== remove?.id),
          );
          toast.info("Local memory removed.");
        }}
      />
    </Page>
  );
}
