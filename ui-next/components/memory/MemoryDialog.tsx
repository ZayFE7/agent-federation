import React, { useEffect, useState } from "react";
import type { Memory, MemoryCategory } from "../../types";
import { Dialog } from "../ui/Dialog";
import { Button } from "../ui/Button";
import { Field, textareaCls } from "../ui/Field";
import { Select } from "../ui/Select";
import { Segmented } from "../ui/Segmented";

export const CATEGORY_LABEL: Record<MemoryCategory, string> = {
  preference: "Preference",
  person: "Person",
  project: "Project",
  fact: "Fact",
};

interface MemoryDialogProps {
  open: boolean;
  initial?: Memory;
  onClose: () => void;
  onSave: (data: Pick<Memory, "text" | "category" | "importance">) => void;
}

export function MemoryDialog({
  open,
  initial,
  onClose,
  onSave,
}: MemoryDialogProps) {
  const [text, setText] = useState("");
  const [category, setCategory] = useState<MemoryCategory>("preference");
  const [importance, setImportance] = useState<"1" | "2" | "3">("2");

  useEffect(() => {
    if (open) {
      setText(initial?.text ?? "");
      setCategory(initial?.category ?? "preference");
      setImportance(String(initial?.importance ?? 2) as "1" | "2" | "3");
    }
  }, [open, initial]);

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={initial ? "Edit memory" : "Add a memory"}
      description="Write it the way you’d tell a colleague. Blip uses it in future tasks."
      size="sm"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={!text.trim()}
            onClick={() => {
              onSave({
                text: text.trim(),
                category,
                importance: Number(importance) as 1 | 2 | 3,
              });
              onClose();
            }}
          >
            {initial ? "Save changes" : "Add memory"}
          </Button>
        </>
      }
    >
      <div className="space-y-5">
        <Field label="Memory" htmlFor="mem-text">
          <textarea
            id="mem-text"
            data-autofocus
            className={textareaCls}
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="e.g. Prefers meetings after 10 AM on Mondays."
          />
        </Field>
        <Field label="Type" htmlFor="mem-cat">
          <Select
            id="mem-cat"
            value={category}
            onChange={(v) => setCategory(v as MemoryCategory)}
          >
            {Object.entries(CATEGORY_LABEL).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </Select>
        </Field>
        <div>
          <p className="mb-2 text-[13px] font-medium">Importance</p>
          <Segmented
            ariaLabel="Importance"
            value={importance}
            onChange={setImportance}
            options={[
              { value: "1", label: "Low" },
              { value: "2", label: "Medium" },
              { value: "3", label: "High" },
            ]}
          />
        </div>
        <p className="text-[12.5px] text-ink-3">
          Never store passwords, card numbers or other secrets as memories.
        </p>
      </div>
    </Dialog>
  );
}
