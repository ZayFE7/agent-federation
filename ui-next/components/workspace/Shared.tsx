import React, { ReactNode } from "react";
import {
  ArrowLeft,
  Check,
  ChevronRight,
  Search as SearchIcon,
  Circle,
  LoaderCircle,
  ShieldCheck,
  FileText,
} from "lucide-react";
import { useApp } from "../../contexts/AppContext";
import type { PlanStep, GoalStatus } from "../../types";
import { Button } from "../ui/Button";
import { Badge } from "../ui/Badge";
export function Panel({
  children,
  className = "",
}: {
  children: ReactNode;
  className?: string;
}) {
  return <div className={`ws-card ${className}`}>{children}</div>;
}
export function SearchBox({
  value,
  onChange,
  label = "Search",
  placeholder = "Search…",
}: {
  value: string;
  onChange: (v: string) => void;
  label?: string;
  placeholder?: string;
}) {
  return (
    <label className="ws-search">
      <SearchIcon size={16} />
      <span className="sr-only">{label}</span>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
      />
    </label>
  );
}
export function Back({
  screen,
  label = "Back to list",
}: {
  screen: Parameters<ReturnType<typeof useApp>["navigate"]>[0];
  label?: string;
}) {
  const { navigate } = useApp();
  return (
    <Button
      variant="ghost"
      size="sm"
      icon={<ArrowLeft />}
      onClick={() => navigate(screen)}
      className="mb-5 -ml-3"
    >
      {label}
    </Button>
  );
}
export function Empty({
  title,
  body,
  action,
}: {
  title: string;
  body: string;
  action?: ReactNode;
}) {
  return (
    <div className="ws-empty">
      <span className="ws-empty-icon">
        <Circle size={24} />
      </span>
      <h3>{title}</h3>
      <p>{body}</p>
      {action}
    </div>
  );
}
export function Steps({ steps }: { steps: PlanStep[] }) {
  return (
    <ol className="ws-steps">
      {steps.map((s, i) => (
        <li key={s.id} className={s.status === "done" ? "complete" : ""}>
          <span className={`ws-step-dot ${s.status}`}>
            {s.status === "done" ? (
              <Check size={13} />
            ) : s.status === "active" ? (
              <LoaderCircle size={13} className="motion-safe:animate-spin" />
            ) : (
              <span>{i + 1}</span>
            )}
          </span>
          <span>{s.label}</span>
          <small>
            {s.status === "active"
              ? "In progress"
              : s.status === "waiting"
                ? "Needs you"
                : s.status === "blocked"
                  ? "Blocked"
                  : ""}
          </small>
        </li>
      ))}
    </ol>
  );
}
export function GoalTag({ status }: { status: GoalStatus }) {
  const tone =
    status === "complete"
      ? "healthy"
      : status === "needs-you"
        ? "attention"
        : status === "in-progress"
          ? "accent"
          : "neutral";
  return (
    <Badge tone={tone} dot>
      {
        {
          complete: "Complete",
          "needs-you": "Needs you",
          "in-progress": "In progress",
          paused: "Paused",
          cancelled: "Cancelled",
        }[status]
      }
    </Badge>
  );
}
export function RichText({ text }: { text: string }) {
  return (
    <div className="ws-rich">
      {text.split("\n\n").map((b, i) =>
        b.startsWith("#") ? (
          <h3 key={i}>{b.replace(/^#+\s*/, "")}</h3>
        ) : b.split("\n").every((l) => /^[-*] /.test(l)) ? (
          <ul key={i}>
            {b.split("\n").map((l, j) => (
              <li key={j}>{l.slice(2)}</li>
            ))}
          </ul>
        ) : (
          <p key={i}>{b}</p>
        ),
      )}
    </div>
  );
}
export function SafeNote({ children }: { children: ReactNode }) {
  return (
    <div className="ws-safe-note">
      <ShieldCheck size={16} />
      <p>{children}</p>
    </div>
  );
}
export function FilePill({
  name,
  onClick,
}: {
  name: string;
  onClick?: () => void;
}) {
  return (
    <button className="ws-file-pill" onClick={onClick}>
      <FileText size={15} />
      <span>{name}</span>
      {onClick && <ChevronRight size={13} />}
    </button>
  );
}
