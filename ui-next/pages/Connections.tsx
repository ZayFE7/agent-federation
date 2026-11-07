import React, { useState } from "react";
import { Activity, Info, Plus, RefreshCw, Server, Trash2 } from "lucide-react";
import { toast } from "sonner";
import type { AppConnection, McpServer } from "../types";
import { useApp } from "../contexts/AppContext";
import { Page, PageHeader, SectionTitle } from "../components/ui/Page";
import { Button } from "../components/ui/Button";
import { Badge } from "../components/ui/Badge";
import { ConfirmDialog } from "../components/ui/ConfirmDialog";
import { AppIcon } from "../components/connections/AppIcon";
import { AccountState } from "../components/connections/AccountState";
import { ConnectDialog } from "../components/connections/ConnectDialog";
import { ManageAppSheet } from "../components/connections/ManageAppSheet";
import { AddServerDialog } from "../components/connections/AddServerDialog";
import { formatRelative, nowIso } from "../utils/time";

const MCP_STATUS = {
  online: { tone: "healthy" as const, label: "Online" },
  degraded: { tone: "attention" as const, label: "Degraded" },
  offline: { tone: "neutral" as const, label: "Offline" },
};

export function Connections() {
  const { connections, setConnections, mcpServers, setMcpServers } = useApp();
  const [connectTarget, setConnectTarget] = useState<{
    app: AppConnection;
    mode: "connect" | "add-account";
  } | null>(null);
  const [manageId, setManageId] = useState<string | null>(null);
  const [addServer, setAddServer] = useState(false);
  const [removeServer, setRemoveServer] = useState<McpServer | null>(null);
  const [checking, setChecking] = useState<string | null>(null);
  const [reconnecting, setReconnecting] = useState<string | null>(null);

  const connected = connections.filter((c) => c.connected);
  const discover = connections.filter((c) => !c.connected);
  const manageApp = connections.find((c) => c.id === manageId);

  const quickReconnect = (app: AppConnection) => {
    setReconnecting(app.id);
    window.setTimeout(() => {
      setConnections((list) =>
        list.map((c) =>
          c.id === app.id
            ? {
                ...c,
                accounts: c.accounts.map((a) =>
                  a.state === "expired" || a.state === "error"
                    ? { ...a, state: "synced", lastSync: nowIso() }
                    : a,
                ),
              }
            : c,
        ),
      );
      setReconnecting(null);
      toast.success(`${app.name} reconnected (simulated)`, {
        description: "No real sign-in happened.",
      });
    }, 900);
  };

  const checkServer = (s: McpServer) => {
    setChecking(s.id);
    window.setTimeout(() => {
      setMcpServers((l) =>
        l.map((x) =>
          x.id === s.id
            ? {
                ...x,
                status: "online",
                note: "All tools passed the simulated schema check.",
                tools: x.status === "degraded" ? x.tools + 2 : x.tools,
              }
            : x,
        ),
      );
      setChecking(null);
      toast.success(`${s.name} looks healthy`, {
        description: "Simulated check — no request was made.",
      });
    }, 1100);
  };

  return (
    <Page>
      <PageHeader
        index="07"
        eyebrow="Connections"
        title="Your apps, on a short leash."
        description="Blip only uses the permissions you allow, per app and per account. Everything here is demo data — no real sign-in happens and no tokens are requested or stored."
      />

      <p className="mb-10 flex items-start gap-2.5 rounded-2xl border border-line bg-surface px-4 py-3 text-[13.5px] text-ink-2">
        <Info className="mt-0.5 h-4 w-4 shrink-0 text-ink-3" aria-hidden />
        One app needing attention only affects tasks that use it. It never
        changes Blip’s overall status.
      </p>

      <section aria-labelledby="connected" className="mb-12">
        <SectionTitle id="connected">
          Connected · {connected.length}
        </SectionTitle>
        <div className="grid gap-4 md:grid-cols-2">
          {connected.map((app) => {
            const needsAttention = app.accounts.some(
              (a) => a.state === "expired" || a.state === "error",
            );
            const on = app.scopes.filter((s) => s.enabled).length;
            return (
              <article
                key={app.id}
                className="flex flex-col rounded-[20px] border border-line bg-surface p-5 shadow-soft"
              >
                <div className="flex items-start gap-3">
                  <AppIcon icon={app.icon} />
                  <div className="min-w-0 flex-1">
                    <h3 className="text-[15.5px] font-semibold">{app.name}</h3>
                    <p className="text-[12.5px] text-ink-3">
                      {app.category} · {on} of {app.scopes.length} permissions
                      on
                    </p>
                  </div>
                  {app.accounts.length > 1 && (
                    <Badge tone="neutral">{app.accounts.length} accounts</Badge>
                  )}
                </div>
                <ul className="mt-4 space-y-2">
                  {app.accounts.map((acc) => (
                    <li
                      key={acc.id}
                      className="flex flex-wrap items-center justify-between gap-2 rounded-xl bg-ink/[0.03] px-3 py-2"
                    >
                      <span className="min-w-0 truncate text-[13px]">
                        {acc.email}
                        {acc.label && (
                          <span className="text-ink-3"> · {acc.label}</span>
                        )}
                      </span>
                      <span className="flex items-center gap-2">
                        <span className="hidden text-[11.5px] text-ink-3 sm:inline">
                          {formatRelative(acc.lastSync)}
                        </span>
                        <AccountState state={acc.state} />
                      </span>
                    </li>
                  ))}
                </ul>
                <div className="mt-auto flex flex-wrap gap-2 pt-4">
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => setManageId(app.id)}
                  >
                    Manage
                  </Button>
                  {needsAttention && (
                    <Button
                      variant="primary"
                      size="sm"
                      icon={<RefreshCw />}
                      loading={reconnecting === app.id}
                      onClick={() => quickReconnect(app)}
                    >
                      Reconnect
                    </Button>
                  )}
                </div>
              </article>
            );
          })}
        </div>
      </section>

      <section aria-labelledby="mcp" className="mb-12">
        <SectionTitle
          id="mcp"
          action={
            <Button
              variant="secondary"
              size="sm"
              icon={<Plus />}
              onClick={() => setAddServer(true)}
            >
              Add server
            </Button>
          }
        >
          MCP servers · {mcpServers.length}
        </SectionTitle>
        {mcpServers.length === 0 ? (
          <p className="rounded-[20px] border border-dashed border-line-strong px-4 py-8 text-center text-[13.5px] text-ink-3">
            No servers yet. Add one to give Blip extra tools.
          </p>
        ) : (
          <ul className="divide-y divide-line overflow-hidden rounded-[20px] border border-line bg-surface">
            {mcpServers.map((s) => (
              <li
                key={s.id}
                className="flex flex-col gap-3 px-5 py-4 sm:flex-row sm:items-center"
              >
                <span
                  className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-ink/[0.05] text-ink-2"
                  aria-hidden
                >
                  <Server className="h-[18px] w-[18px]" />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="flex flex-wrap items-center gap-2 text-[14.5px] font-medium">
                    {s.name}{" "}
                    <Badge tone={MCP_STATUS[s.status].tone} dot>
                      {MCP_STATUS[s.status].label}
                    </Badge>
                  </p>
                  <p className="truncate font-mono text-[12px] text-ink-3">
                    {s.url}
                  </p>
                  <p className="mt-0.5 text-[12.5px] text-ink-2">
                    {s.tools} tools · auth:{" "}
                    {s.auth === "none"
                      ? "none"
                      : s.auth === "oauth"
                        ? "OAuth (demo)"
                        : "header (not collected)"}
                    {s.note && <span className="text-ink-3"> · {s.note}</span>}
                  </p>
                </div>
                <div className="flex gap-2">
                  <Button
                    variant="ghost"
                    size="sm"
                    icon={<Activity />}
                    loading={checking === s.id}
                    onClick={() => checkServer(s)}
                  >
                    Check
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={`Remove ${s.name}`}
                    onClick={() => setRemoveServer(s)}
                  >
                    <Trash2 />
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="discover">
        <SectionTitle id="discover">Discover apps</SectionTitle>
        {discover.length === 0 ? (
          <p className="text-[13.5px] text-ink-3">
            Every available app is connected.
          </p>
        ) : (
          <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {discover.map((app) => (
              <li
                key={app.id}
                className="flex flex-col rounded-[20px] border border-line bg-surface p-4"
              >
                <AppIcon icon={app.icon} size="sm" />
                <p className="mt-3 text-[14.5px] font-medium">{app.name}</p>
                <p className="mt-1 text-[12.5px] leading-relaxed text-ink-3">
                  {app.description}
                </p>
                <Button
                  variant="secondary"
                  size="sm"
                  className="mt-auto self-start"
                  onClick={() => setConnectTarget({ app, mode: "connect" })}
                >
                  <span className="mt-3 sm:mt-0">Connect</span>
                </Button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <ConnectDialog
        app={connectTarget?.app ?? null}
        mode={connectTarget?.mode ?? "connect"}
        onClose={() => setConnectTarget(null)}
      />
      <ManageAppSheet
        app={manageApp}
        onClose={() => setManageId(null)}
        onAddAccount={(app) => {
          setConnectTarget({ app, mode: "add-account" });
        }}
      />
      <AddServerDialog open={addServer} onClose={() => setAddServer(false)} />
      <ConfirmDialog
        open={Boolean(removeServer)}
        onClose={() => setRemoveServer(null)}
        title={`Remove ${removeServer?.name}?`}
        impact={[
          `${removeServer?.tools ?? 0} tools become unavailable to Blip`,
          "Running tasks that use them will pause and ask you",
          "Nothing changes on the server itself",
        ]}
        confirmLabel="Remove server"
        onConfirm={() => {
          if (!removeServer) return;
          setMcpServers((l) => l.filter((x) => x.id !== removeServer.id));
          toast(`${removeServer.name} removed`);
        }}
      />
    </Page>
  );
}
