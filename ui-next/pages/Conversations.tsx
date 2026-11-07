import React, { useEffect, useMemo, useState } from "react";
import { MessageSquareX } from "lucide-react";
import { toast } from "sonner";
import { useApp } from "../contexts/AppContext";
import { useRun } from "../contexts/RunContext";
import { useMediaQuery } from "../hooks/useMediaQuery";
import { ThreadList } from "../components/chat/ThreadList";
import { ThreadView } from "../components/chat/ThreadView";
import { ConfirmDialog } from "../components/ui/ConfirmDialog";
import { EmptyState } from "../components/ui/EmptyState";
import { Button } from "../components/ui/Button";
import { plural } from "../utils/format";

export function Conversations() {
  const {
    route,
    navigate,
    conversations,
    setConversations,
    goals,
    automations,
    setAutomations,
    approvals,
  } = useApp();
  const { createConversation, run, stopRun } = useRun();
  const desktop = useMediaQuery("(min-width: 768px)");
  const [pendingDelete, setPendingDelete] = useState<string[] | null>(null);

  const active = route.id
    ? conversations.find((c) => c.id === route.id)
    : undefined;

  useEffect(() => {
    if (
      route.screen === "chat" &&
      desktop &&
      !route.id &&
      conversations.length > 0
    ) {
      const first = [...conversations].sort(
        (a, b) =>
          Number(b.pinned) - Number(a.pinned) ||
          new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
      )[0];
      navigate("chat", first.id, { replace: true });
    }
  }, [desktop, route.screen, route.id, conversations, navigate]);

  const newChat = () => {
    const empty = conversations.find((c) => c.messages.length === 0);
    navigate("chat", empty?.id ?? createConversation());
  };

  const impact = useMemo(() => {
    if (!pendingDelete) return [];
    const targets = conversations.filter((c) => pendingDelete.includes(c.id));
    const msgCount = targets.reduce((n, c) => n + c.messages.length, 0);
    const lines = [
      `${plural(targets.length, "conversation")} and ${plural(msgCount, "message")} removed from this device`,
    ];
    goals
      .filter(
        (g) => g.conversationId && pendingDelete.includes(g.conversationId),
      )
      .forEach((g) =>
        lines.push(
          `Goal “${g.title}” is kept but will show “linked chat removed”`,
        ),
      );
    automations
      .filter((a) => a.targetChatId && pendingDelete.includes(a.targetChatId))
      .forEach((a) =>
        lines.push(
          `Routine “${a.name}” posts here and will auto-pause until you pick a new chat`,
        ),
      );
    const pend = approvals.filter(
      (a) =>
        a.status === "pending" &&
        a.conversationId &&
        pendingDelete.includes(a.conversationId),
    ).length;
    if (pend)
      lines.push(
        `${plural(pend, "pending approval")} from this chat stay in Approvals`,
      );
    lines.push("Files in your Library are kept");
    return lines;
  }, [pendingDelete, conversations, goals, automations, approvals]);

  const confirmDelete = () => {
    if (!pendingDelete) return;
    const ids = pendingDelete;
    if (run && ids.includes(run.conversationId)) stopRun();
    const titles = new Map(conversations.map((c) => [c.id, c.title]));
    setConversations((cs) => cs.filter((c) => !ids.includes(c.id)));
    setAutomations((list) =>
      list.map((a) =>
        a.targetChatId && ids.includes(a.targetChatId)
          ? {
              ...a,
              enabled: false,
              autoPausedReason: "Auto-paused: its target chat was deleted.",
              lastError: {
                message: `Target chat “${titles.get(a.targetChatId) ?? "Unknown"}” no longer exists, so results had nowhere to go.`,
                remedy: "choose-chat",
              },
            }
          : a,
      ),
    );
    toast.success(`Deleted ${plural(ids.length, "conversation")}`);
    if (route.id && ids.includes(route.id))
      navigate("chat", undefined, { replace: true });
  };

  const showList = desktop || !route.id;
  const showThread = desktop || Boolean(route.id);

  return (
    <div className="grid h-[calc(100dvh-56px-64px)] md:h-[calc(100dvh-64px)] md:grid-cols-[296px_minmax(0,1fr)]">
      {showList && (
        <div className="min-h-0 border-line md:border-r md:bg-sidebar/50">
          <ThreadList
            conversations={conversations}
            activeId={route.id}
            onSelect={(id) => navigate("chat", id)}
            onNew={newChat}
            onDelete={(ids) => setPendingDelete(ids)}
            onTogglePin={(id) =>
              setConversations((cs) =>
                cs.map((c) => (c.id === id ? { ...c, pinned: !c.pinned } : c)),
              )
            }
          />
        </div>
      )}
      {showThread && (
        <div className="min-h-0 min-w-0">
          {active ? (
            <ThreadView
              key={active.id}
              conversation={active}
              onBack={() => navigate("chat")}
              onDelete={() => setPendingDelete([active.id])}
            />
          ) : (
            <div className="grid h-full place-items-center">
              <EmptyState
                icon={<MessageSquareX />}
                title={
                  route.id
                    ? "This conversation was deleted"
                    : "No conversation selected"
                }
                body={
                  route.id
                    ? "Its files are still in your Library."
                    : "Start a new chat or pick one from the list."
                }
                action={
                  <Button variant="primary" onClick={newChat}>
                    New chat
                  </Button>
                }
              />
            </div>
          )}
        </div>
      )}
      <ConfirmDialog
        open={pendingDelete !== null}
        onClose={() => setPendingDelete(null)}
        onConfirm={confirmDelete}
        title={
          pendingDelete && pendingDelete.length > 1
            ? `Delete ${pendingDelete.length} conversations?`
            : "Delete this conversation?"
        }
        description="This can’t be undone."
        impact={impact}
        confirmWord="DELETE"
        confirmLabel="Delete permanently"
      />
    </div>
  );
}
