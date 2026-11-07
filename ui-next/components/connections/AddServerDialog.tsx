import React, { useEffect, useState } from "react";
import { toast } from "sonner";
import type { McpServer } from "../../types";
import { useApp } from "../../contexts/AppContext";
import { Dialog } from "../ui/Dialog";
import { Button } from "../ui/Button";
import { Field, inputCls } from "../ui/Field";
import { Segmented } from "../ui/Segmented";
import { nowIso } from "../../utils/time";
import { uid } from "../../utils/format";

export function AddServerDialog({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const { setMcpServers, announce } = useApp();
  const [name, setName] = useState("");
  const [url, setUrl] = useState("https://");
  const [auth, setAuth] = useState<McpServer["auth"]>("none");
  const [errors, setErrors] = useState<{ name?: string; url?: string }>({});
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (open) {
      setName("");
      setUrl("https://");
      setAuth("none");
      setErrors({});
      setBusy(false);
    }
  }, [open]);

  const add = () => {
    const errs: typeof errors = {};
    if (!name.trim()) errs.name = "Give the server a name.";
    if (!/^https?:\/\/[^\s.]+\.[^\s]+/.test(url.trim()))
      errs.url = "Enter a full URL, e.g. https://mcp.example.com/sse";
    setErrors(errs);
    if (Object.keys(errs).length) return;
    setBusy(true);
    window.setTimeout(() => {
      const server: McpServer = {
        id: uid("mcp"),
        name: name.trim(),
        url: url.trim(),
        auth,
        tools: 4 + (name.trim().length % 9),
        status: "online",
        addedAt: nowIso(),
        note: "Simulated check — no request was made to this URL.",
      };
      setMcpServers((l) => [...l, server]);
      setBusy(false);
      announce(`${server.name} added.`);
      toast.success(`${server.name} added`, {
        description: `${server.tools} tools found (simulated)`,
      });
      onClose();
    }, 900);
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Add an MCP server"
      description="Blip lists the server’s tools and hides any that fail review. In this demo the check is simulated — no request leaves your browser."
      size="sm"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" loading={busy} onClick={add}>
            {busy ? "Checking server…" : "Add server"}
          </Button>
        </>
      }
    >
      <div className="space-y-5">
        <Field label="Name" htmlFor="mcp-name" error={errors.name}>
          <input
            id="mcp-name"
            data-autofocus
            className={inputCls}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Figma"
          />
        </Field>
        <Field label="Server URL" htmlFor="mcp-url" error={errors.url}>
          <input
            id="mcp-url"
            type="url"
            className={`${inputCls} font-mono text-[13px]`}
            value={url}
            onChange={(e) => setUrl(e.target.value)}
          />
        </Field>
        <div>
          <p className="mb-2 text-[13px] font-medium">Authentication</p>
          <Segmented
            ariaLabel="Authentication type"
            value={auth}
            onChange={setAuth}
            options={[
              { value: "none", label: "None" },
              { value: "oauth", label: "OAuth (demo)" },
              { value: "header", label: "Header" },
            ]}
          />
          <p className="mt-2 text-[12.5px] text-ink-3">
            {auth === "none"
              ? "For local or public servers."
              : auth === "oauth"
                ? "A real build would open a sign-in window. This demo skips it entirely."
                : "Header values aren’t collected in this demo — no secrets are requested or stored."}
          </p>
        </div>
      </div>
    </Dialog>
  );
}
