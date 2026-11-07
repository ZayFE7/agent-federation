import React, { useEffect, useState } from "react";
import { ShieldCheck } from "lucide-react";
import { toast } from "sonner";
import type { AppConnection } from "../../types";
import { useApp } from "../../contexts/AppContext";
import { Dialog } from "../ui/Dialog";
import { Button } from "../ui/Button";
import { Field, inputCls } from "../ui/Field";
import { AppIcon } from "./AppIcon";
import { nowIso } from "../../utils/time";
import { uid } from "../../utils/format";

interface ConnectDialogProps {
  app: AppConnection | null;
  mode: "connect" | "add-account";
  onClose: () => void;
}

/** Demo-only connect flow. Never opens OAuth, never asks for or stores a token. */
export function ConnectDialog({ app, mode, onClose }: ConnectDialogProps) {
  const { setConnections, announce } = useApp();
  const [email, setEmail] = useState("");
  const [scopes, setScopes] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (app) {
      setEmail(
        mode === "add-account"
          ? "maya.chen@home.example"
          : "maya@northwind.example",
      );
      setScopes(
        app.scopes.filter((s) => s.enabled || s.required).map((s) => s.id),
      );
      setBusy(false);
    }
  }, [app, mode]);

  const connect = () => {
    if (!app || !email.trim()) return;
    setBusy(true);
    window.setTimeout(() => {
      setConnections((list) =>
        list.map((c) =>
          c.id === app.id
            ? {
                ...c,
                connected: true,
                accounts: [
                  ...c.accounts,
                  {
                    id: uid("acc"),
                    email: email.trim(),
                    label: mode === "add-account" ? "Added" : undefined,
                    state: "synced",
                    lastSync: nowIso(),
                  },
                ],
                scopes: c.scopes.map((s) => ({
                  ...s,
                  enabled: s.required || scopes.includes(s.id),
                })),
              }
            : c,
        ),
      );
      setBusy(false);
      announce(`${app.name} connected (simulated).`);
      toast.success(`${app.name} connected`, {
        description: "Simulated — no sign-in happened and no token was stored.",
      });
      onClose();
    }, 900);
  };

  return (
    <Dialog
      open={Boolean(app)}
      onClose={onClose}
      title={
        app
          ? mode === "add-account"
            ? `Add another ${app.name} account`
            : `Connect ${app.name}`
          : ""
      }
      size="sm"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            loading={busy}
            disabled={!email.trim()}
            onClick={connect}
          >
            {busy ? "Connecting…" : "Connect (simulated)"}
          </Button>
        </>
      }
    >
      {app && (
        <div className="space-y-5">
          <div className="flex items-center gap-3">
            <AppIcon icon={app.icon} size="lg" />
            <p className="text-[13.5px] leading-relaxed text-ink-2">
              {app.description}
            </p>
          </div>
          <div className="flex gap-3 rounded-2xl bg-accent-soft p-4 text-[13.5px]">
            <ShieldCheck
              className="mt-0.5 h-5 w-5 shrink-0 text-accent-ink"
              aria-hidden
            />
            <p className="text-ink">
              <span className="font-medium">This is a demo connection.</span> No
              real OAuth window opens, no password or token is requested, and
              nothing is stored except this mock account label on your device.
            </p>
          </div>
          <Field
            label="Account label"
            htmlFor="conn-email"
            hint="Shown on the account badge. Any text works."
          >
            <input
              id="conn-email"
              data-autofocus
              className={inputCls}
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </Field>
          <fieldset>
            <legend className="mb-2 text-[13px] font-medium">
              Permissions
            </legend>
            <ul className="space-y-2">
              {app.scopes.map((s) => (
                <li key={s.id}>
                  <label
                    className={`flex min-h-[44px] items-start gap-3 rounded-xl border border-line px-3.5 py-2.5 ${s.required ? "opacity-80" : "cursor-pointer"}`}
                  >
                    <input
                      type="checkbox"
                      className="mt-0.5 h-4 w-4 accent-[rgb(var(--accent))]"
                      checked={s.required || scopes.includes(s.id)}
                      disabled={s.required}
                      onChange={() =>
                        setScopes((l) =>
                          l.includes(s.id)
                            ? l.filter((x) => x !== s.id)
                            : [...l, s.id],
                        )
                      }
                    />
                    <span className="text-[13.5px]">
                      <span className="font-medium">{s.label}</span>
                      {s.required && (
                        <span className="text-ink-3"> · required</span>
                      )}
                      {s.sensitive && (
                        <span className="text-amber-ink">
                          {" "}
                          · always asks first
                        </span>
                      )}
                      <span className="block text-[12.5px] text-ink-3">
                        {s.description}
                      </span>
                    </span>
                  </label>
                </li>
              ))}
            </ul>
          </fieldset>
        </div>
      )}
    </Dialog>
  );
}
