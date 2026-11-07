import React, { ReactNode } from "react";
import type { Citation } from "../../types";

interface RichTextProps {
  text: string;
  citations?: Citation[];
  onCite?: (n: number) => void;
  className?: string;
}

/** Small, safe markdown subset: headings, lists, quotes, bold, italic, inline code and [n] citations. */
export function RichText({
  text,
  citations,
  onCite,
  className = "",
}: RichTextProps) {
  const blocks = text.split(/\n{2,}/);
  return (
    <div
      className={`space-y-3 text-[15px] leading-[1.65] text-ink ${className}`}
    >
      {blocks.map((block, bi) => {
        const lines = block.split("\n");
        if (/^#{1,3}\s/.test(block)) {
          const level = block.match(/^#+/)?.[0].length ?? 3;
          const content = block.replace(/^#+\s/, "");
          return level === 1 ? (
            <h3
              key={bi}
              className="pt-1 text-[22px] font-semibold tracking-[-0.02em]"
            >
              {inline(content, citations, onCite)}
            </h3>
          ) : (
            <h4
              key={bi}
              className="pt-1 text-[16px] font-semibold tracking-[-0.01em]"
            >
              {inline(content, citations, onCite)}
            </h4>
          );
        }
        if (lines.every((l) => /^[-•]\s/.test(l))) {
          return (
            <ul key={bi} className="space-y-1.5">
              {lines.map((l, li) => (
                <li key={li} className="flex gap-2.5">
                  <span
                    className="mt-[11px] h-1 w-1 shrink-0 rounded-full bg-ink-3"
                    aria-hidden
                  />
                  <span>
                    {inline(l.replace(/^[-•]\s/, ""), citations, onCite)}
                  </span>
                </li>
              ))}
            </ul>
          );
        }
        if (lines.every((l) => /^\d+\.\s/.test(l))) {
          return (
            <ol key={bi} className="space-y-1.5">
              {lines.map((l, li) => (
                <li key={li} className="flex gap-2.5">
                  <span className="tabular w-4 shrink-0 font-mono text-[12.5px] leading-[25px] text-ink-3">
                    {li + 1}
                  </span>
                  <span>
                    {inline(l.replace(/^\d+\.\s/, ""), citations, onCite)}
                  </span>
                </li>
              ))}
            </ol>
          );
        }
        if (lines.every((l) => l.startsWith(">"))) {
          return (
            <blockquote
              key={bi}
              className="border-l-2 border-line-strong pl-3 text-ink-2"
            >
              {inline(
                lines.map((l) => l.replace(/^>\s?/, "")).join(" "),
                citations,
                onCite,
              )}
            </blockquote>
          );
        }
        return (
          <p key={bi}>
            {lines.map((l, li) => (
              <React.Fragment key={li}>
                {li > 0 && <br />}
                {inline(l, citations, onCite)}
              </React.Fragment>
            ))}
          </p>
        );
      })}
    </div>
  );
}

function inline(
  text: string,
  citations?: Citation[],
  onCite?: (n: number) => void,
): ReactNode[] {
  const parts = text.split(/(\*\*[^*]+\*\*|`[^`]+`|\[\d+\]|\*[^*\s][^*]*\*)/g);
  return parts.map((part, i) => {
    if (!part) return null;
    if (part.startsWith("**") && part.endsWith("**"))
      return (
        <strong key={i} className="font-semibold">
          {part.slice(2, -2)}
        </strong>
      );
    if (part.startsWith("`") && part.endsWith("`"))
      return (
        <code
          key={i}
          className="rounded-md bg-ink/[0.06] px-1.5 py-0.5 font-mono text-[0.86em]"
        >
          {part.slice(1, -1)}
        </code>
      );
    const cite = part.match(/^\[(\d+)\]$/);
    if (cite) {
      const n = Number(cite[1]);
      const c = citations?.find((x) => x.n === n);
      if (!c) return <span key={i}>{part}</span>;
      return (
        <button
          key={i}
          type="button"
          onClick={() => onCite?.(n)}
          aria-label={`Source ${n}: ${c.label}`}
          title={`${c.label} — ${c.source}`}
          className="mx-0.5 inline-grid h-[18px] min-w-[18px] place-items-center rounded-md bg-accent-soft px-1 align-[2px] font-mono text-[10.5px] font-medium text-accent-ink transition-colors duration-150 hover:bg-accent/20"
        >
          {n}
        </button>
      );
    }
    if (part.startsWith("*") && part.endsWith("*") && part.length > 2)
      return (
        <em key={i} className="text-ink-2">
          {part.slice(1, -1)}
        </em>
      );
    return <React.Fragment key={i}>{part}</React.Fragment>;
  });
}
