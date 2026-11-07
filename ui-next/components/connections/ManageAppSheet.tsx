import React, { useState } from "react";
import { Plus, RefreshCw, Unplug, X } from "lucide-react";
import { toast } from "sonner";
import type { AppConnection } from "../../types";
import { useApp } from "../../contexts/AppContext";
import { Dialog } from "../ui/Dialog";
import { Button } from "../ui/Button";
import { Switch } from "../ui/Switch";
import { ConfirmDialog } from "../ui/ConfirmDialog";
import { AccountState } from "./AccountState";
import { formatRelative, nowIso } from "../../utils/time";

interface ManageAppSheetProps {
  app: AppConnection | undefined;
  onClose: () => void;
  onAddAccount: (app: AppConnection) => void;
}

export function ManageAppSheet({
  app,
  onClose,
  onAddAccount,
}: ManageAppSheetProps) {
  const { setConnections, automations } = useApp();
  const [disconnectOpen, setDisconnectOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  const patch = (fn: (c: AppConnection) => AppConnection) =>
    app &&
    setConnections((list) => list.map((c) => (c.id === app.id ? fn(c) : c)));

  const reconnect = (accId: string) => {
    setBusy(accId);
    window.setTimeout(() => {
      patch((c) => ({
        ...c,
        accounts: c.accounts.map((a) =>
          a.id === accId ? { ...a, state: "synced", lastSync: nowIso() } : a,
        ),
      }));
      setBusy(null);
      toast.success("Reconnected (simulated)", {
        description: "No real sign-in happened.",
      });
    }, 900);
  };

  const affectedRoutines = app
    ? automations.filter(
        (a) =>
          a.trigger.type === "webhook" &&
          a.trigger.source.toLowerCase().startsWith(app.name.toLowerCase()),
      )
    : [];

  return (
    <>
      <Dialog
        open={Boolean(app)}
        onClose={onClose}
        variant="side"
        title={app ? `Manage ${app.name}` : ""}
        description={app?.description}
      >
        {app && (
          <div className="space-y-8">
            <section aria-labelledby="accts">
              <div className="mb-3 flex items-center justify-between">
                <h3 id="accts" className="text-[14px] font-semibold">
                  Accounts
                </h3>
                <Button
                  variant="ghost"
                  size="sm"
                  icon={<Plus />}
                  onClick={() => onAddAccount(app)}
                >
                  Add account
                </Button>
              </div>
              <ul className="divide-y divide-line rounded-2xl border border-line">
                {app.accounts.map((acc) => (
                  <li
                    key={acc.id}
                    className="flex flex-wrap items-center gap-3 px-4 py-3"
                  >
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-[14px] font-medium">
                        {acc.email}{" "}
                        {acc.label && (
                          <span className="font-normal text-ink-3">
                            · {acc.label}
                          </span>
                        )}
                      </p>
                      <p className="text-[12.5px] text-ink-3">
                        Last sync {formatRelative(acc.lastSync)}
                      </p>
                    </div>
                    <AccountState state={acc.state} />
                    {(acc.state === "expired" || acc.state === "error") && (
                      <Button
                        size="sm"
                        variant="secondary"
                        icon={<RefreshCw />}
                        loading={busy === acc.id}
                        onClick={() => reconnect(acc.id)}
                      >
                        Reconnect
                      </Button>
                    )}
                    {app.accounts.length > 1 && (
                      <Button
                        size="icon-sm"
                        variant="ghost"
                        aria-label={`Remove account ${acc.email}`}
                        onClick={() =>
                          patch((c) => ({
                            ...c,
                            accounts: c.accounts.filter((a) => a.id !== acc.id),
                          }))
                        }
                      >
                        <X />
                      </Button>
                    )}
                  </li>
                ))}
              </ul>
            </section>

            <section aria-labelledby="scopes">
              <h3 id="scopes" className="mb-1 text-[14px] font-semibold">
                Permissions
              </h3>
              <p className="mb-3 text-[12.5px] text-ink-3">
                Turning a scope off takes effect immediately. Sensitive scopes
                always ask before each use.
              </p>
              <ul className="divide-y divide-line rounded-2xl border border-line">
                {app.scopes.map((s) => (
                  <li key={s.id} className="flex items-start gap-4 px-4 py-3.5">
                    <div className="min-w-0 flex-1">
                      <p className="text-[14px] font-medium">
                        {s.label}
                        {s.required && (
                          <span className="font-normal text-ink-3">
                            {" "}
                            · required
                          </span>
                        )}
                      </p>
                      <p className="text-[12.5px] text-ink-3">
                        {s.description}
                      </p>
                      {s.sensitive && (
                        <p className="mt-1 text-[12px] font-medium text-amber-ink">
                          Always asks first
                        </p>
                      )}
                    </div>
                    <Switch
                      checked={s.enabled}
                      disabled={s.required}
                      label={`${s.label} permission`}
                      onChange={(on) =>
                        patch((c) => ({
                          ...c,
                          scopes: c.scopes.map((x) =>
                            x.id === s.id ? { ...x, enabled: on } : x,
                          ),
                        }))
                      }
                    />
                  </li>
                ))}
              </ul>
            </section>

            <section className="rounded-2xl border border-line p-4">
              <p className="text-[14px] font-semibold">Disconnect {app.name}</p>
              <p className="mt-1 text-[13px] text-ink-2">
                Removes every account and permission for this app from Blip.
              </p>
              <Button
                variant="secondary"
                icon={<Unplug />}
                className="mt-3"
                onClick={() => setDisconnectOpen(true)}
              >
                Disconnect…
              </Button>
            </section>
          </div>
        )}
      </Dialog>
      <ConfirmDialog
        open={disconnectOpen}
        onClose={() => setDisconnectOpen(false)}
        title={`Disconnect ${app?.name}?`}
        impact={[
          `${app?.accounts.length ?? 0} account${app?.accounts.length === 1 ? "" : "s"} removed from Blip`,
          "Capabilities that need this app will show “setup required”",
          ...affectedRoutines.map(
            (r) => `Routine “${r.name}” will stop receiving events`,
          ),
          "Blip’s overall status is not affected",
        ]}
        confirmLabel="Disconnect"
        onConfirm={() => {
          patch((c) => ({ ...c, connected: false, accounts: [] }));
          toast(`${app?.name} disconnected`);
          onClose();
        }}
      />
    </>
  );
}
