import React, { useState, useRef, useEffect } from "react";
import {
  Upload,
  Download,
  FileText,
  Code2,
  Headphones,
  Image as ImageIcon,
  Grid2X2,
  List,
  Trash2,
  ChevronRight,
  Play,
  Search,
  ArrowUpRight,
} from "lucide-react";
import { useApp } from "../contexts/AppContext";
import { Page, PageHeader } from "../components/ui/Page";
import { Button } from "../components/ui/Button";
import { Badge } from "../components/ui/Badge";
import { Dialog } from "../components/ui/Dialog";
import { ConfirmDialog } from "../components/ui/ConfirmDialog";
import {
  Panel,
  Empty,
  SearchBox,
  RichText,
  SafeNote,
} from "../components/workspace/Shared";
import {
  downloadBlob,
  inferKind,
  isTextLike,
  readFileAsDataUrl,
  readFileAsText,
} from "../utils/files";
import { uid } from "../utils/format";
import type { LibraryItem } from "../types";
import { toast } from "sonner";
const wave = [
  11, 17, 25, 18, 33, 45, 28, 40, 57, 31, 48, 70, 42, 53, 36, 62, 43, 28, 40,
  22, 31, 46, 27, 20, 38, 22, 13, 18,
];
function Preview({ item }: { item: LibraryItem }) {
  if (item.kind === "audio")
    return (
      <div className="ws-preview audio">
        {wave.map((n, i) => (
          <span key={i} style={{ height: n + "%" }} />
        ))}
      </div>
    );
  if (item.kind === "image" && item.dataUrl)
    return (
      <div className="ws-preview !p-0">
        <img
          src={item.dataUrl}
          alt={item.name}
          className="h-full w-full object-cover"
        />
      </div>
    );
  if (item.kind === "image")
    return (
      <div className="ws-preview bg-accent-soft flex items-center justify-center">
        <div className="rounded-full bg-black w-20 h-20 relative">
          <span className="absolute top-8 left-7 w-2 h-5 rounded-full bg-white" />
          <span className="absolute top-8 right-7 w-2 h-5 rounded-full bg-white" />
        </div>
      </div>
    );
  if (item.kind === "code" || item.kind === "app")
    return (
      <div className="ws-preview code">
        <div className="flex gap-1 mb-4">
          {[1, 2, 3].map((n) => (
            <span key={n} className="w-1.5 h-1.5 rounded-full bg-accent/40" />
          ))}
        </div>
        <pre className="whitespace-pre-wrap">
          {(item.content ?? "").slice(0, 480)}
        </pre>
      </div>
    );
  return (
    <div className="ws-preview doc">
      <span className="ws-kicker">BLIP / WORKSPACE</span>
      <h4 className="mt-4">
        {item.name.replace(/\.[^.]+$/, "").replaceAll("-", " ")}
      </h4>
      {[90, 80, 95, 65, 88, 70].map((n, i) => (
        <p style={{ width: n + "%" }} key={i} />
      ))}
    </div>
  );
}
const safeHtml = (html: string) =>
  "<meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; connect-src 'none'; form-action 'none'\">" +
  html;
export function Library() {
  const app = useApp();
  const [query, setQuery] = useState(""),
    [tab, setTab] = useState("all"),
    [grid, setGrid] = useState(true),
    [deleting, setDeleting] = useState(false),
    [busy, setBusy] = useState(false),
    [previewMode, setPreviewMode] = useState("preview");
  const upload = useRef<HTMLInputElement>(null);
  const selected = app.library.find((f) => f.id === app.route.id);
  useEffect(() => {
    if (app.route.id === "upload") {
      upload.current?.click();
      app.navigate("library", undefined, { replace: true });
    }
  }, [app.route.id]);
  const visible = app.library.filter(
    (f) =>
      (f.name + " " + (f.originTask ?? ""))
        .toLowerCase()
        .includes(query.toLowerCase()) &&
      (tab === "all" ||
        (tab === "blip" && f.origin === "blip") ||
        (tab === "uploaded" && f.origin === "uploaded") ||
        tab === f.kind),
  );
  const add = async (files: FileList | null) => {
    if (!files) return;
    setBusy(true);
    try {
      const ns: LibraryItem[] = [];
      for (const f of Array.from(files)) {
        if (f.size > 1024 * 1024) {
          toast.error(f.name + ": demo files must be 1 MB or smaller.");
          continue;
        }
        const kind = inferKind(f.name, f.type),
          text = isTextLike(f.name, f.type);
        const item: LibraryItem = {
          id: uid("file"),
          name: f.name,
          kind,
          origin: "uploaded",
          originTask: "Local upload · never sent to a server",
          version: 1,
          size: f.size,
          mime: f.type || "application/octet-stream",
          status: "ready",
          updatedAt: new Date().toISOString(),
        };
        if (text) item.content = await readFileAsText(f);
        else item.dataUrl = await readFileAsDataUrl(f);
        ns.push(item);
      }
      const total = JSON.stringify([...ns, ...app.library]).length;
      if (total > 3_500_000) {
        toast.error(
          "Local demo storage limit reached. Export files before adding more.",
        );
        return;
      }
      app.setLibrary((fs) => [...ns, ...fs]);
      if (ns.length)
        toast.success(
          `${ns.length} local file${ns.length === 1 ? "" : "s"} added. Nothing was uploaded to a server.`,
        );
    } catch {
      toast.error(
        "This file could not be read. Your existing files are unchanged.",
      );
    } finally {
      setBusy(false);
      if (upload.current) upload.current.value = "";
    }
  };
  const download = async (f: LibraryItem) => {
    if (f.kind === "audio" && !f.dataUrl) {
      downloadBlob(
        f.name.replace(/\.[^.]+$/, "") + "-transcript.txt",
        f.transcript ?? "No audio binary is included in this demo.",
      );
      return;
    }
    if (f.generated === "cover") {
      const c = document.createElement("canvas");
      c.width = c.height = 512;
      const x = c.getContext("2d")!;
      x.fillStyle = "#ededf8";
      x.fillRect(0, 0, 512, 512);
      x.fillStyle = "black";
      x.beginPath();
      x.arc(256, 245, 130, 0, Math.PI * 2);
      x.fill();
      x.strokeStyle = "white";
      x.lineCap = "round";
      x.lineWidth = 30;
      for (const p of [216, 296]) {
        x.beginPath();
        x.moveTo(p, 225);
        x.lineTo(p, 265);
        x.stroke();
      }
      c.toBlob((b) => {
        if (b) downloadBlob(f.name, b);
      }, "image/png");
      return;
    }
    if (f.dataUrl) {
      const r = await fetch(f.dataUrl);
      downloadBlob(f.name, await r.blob());
      return;
    }
    downloadBlob(f.name, f.content ?? "", f.mime);
  };
  return (
    <Page>
      <PageHeader
        index="06"
        eyebrow="THE THINGS YOU MAKE TOGETHER"
        title="Good work, kept close."
        description="Notes, apps, audio, and everything in between. Your files and Blip’s outputs, in one useful place."
        actions={
          <Button
            variant="primary"
            icon={<Upload />}
            loading={busy}
            onClick={() => upload.current?.click()}
          >
            Add local files
          </Button>
        }
      />
      <input
        ref={upload}
        type="file"
        multiple
        className="hidden"
        aria-label="Choose local files"
        onChange={(e) => add(e.target.files)}
      />
      <div className="ws-toolbar">
        <div className="flex gap-1 flex-wrap">
          {[
            ["all", "All files"],
            ["blip", "Made by Blip"],
            ["uploaded", "Uploaded"],
            ["document", "Documents"],
            ["code", "Code"],
            ["audio", "Audio"],
          ].map(([v, n]) => (
            <Button
              key={v}
              size="sm"
              variant={tab === v ? "primary" : "ghost"}
              onClick={() => setTab(v)}
            >
              {n}
            </Button>
          ))}
        </div>
        <div className="flex gap-2 ml-auto">
          <SearchBox
            value={query}
            onChange={setQuery}
            label="Search Library"
            placeholder="Find something…"
          />
          <Button
            size="icon"
            aria-label={grid ? "Switch to list view" : "Switch to grid view"}
            onClick={() => setGrid((x) => !x)}
          >
            {grid ? <List /> : <Grid2X2 />}
          </Button>
        </div>
      </div>
      {visible.length === 0 ? (
        <Panel>
          <Empty
            title="Nothing here. Yet."
            body="Try a different search, add a local file, or ask Blip to make something."
            action={
              <Button onClick={() => upload.current?.click()}>
                Add a file
              </Button>
            }
          />
        </Panel>
      ) : (
        <div className={grid ? "ws-grid three" : "ws-stack"}>
          {visible.map((f) => (
            <button
              key={f.id}
              className={grid ? "ws-file-card" : "ws-row-button"}
              onClick={() => {
                setPreviewMode("preview");
                app.navigate("library", f.id);
              }}
            >
              {grid ? (
                <Preview item={f} />
              ) : (
                <FileText size={21} className="text-accent-ink shrink-0" />
              )}
              <div className={grid ? "px-2 pb-2" : "flex-1"}>
                <div className="ws-between">
                  <h2 className="text-sm font-semibold truncate">{f.name}</h2>
                  {f.status === "needs-review" && (
                    <Badge tone="attention">Review</Badge>
                  )}
                </div>
                <p className="ws-meta mt-2 truncate">
                  {f.origin === "blip" ? "Made by Blip" : "Local upload"} ·{" "}
                  {Math.max(1, Math.round(f.size / 1024))} KB · v{f.version}
                </p>
                <p className="ws-meta mt-1 truncate">
                  {f.originTask ?? "Workspace"}
                </p>
              </div>
              {!grid && <ChevronRight size={15} />}
            </button>
          ))}
        </div>
      )}
      <p className="ws-meta mt-7">
        {visible.length} items · Demo fixtures and local uploads · 1 MB per file
        · No server upload
      </p>
      <Dialog
        open={!!selected}
        onClose={() => app.navigate("library")}
        title={selected?.name ?? "File preview"}
        eyebrow={selected?.origin === "blip" ? "MADE WITH BLIP" : "LOCAL FILE"}
        variant="side"
        size="lg"
        footer={
          selected && (
            <>
              <Button
                variant="ghost"
                className="!text-rose-ink"
                icon={<Trash2 />}
                onClick={() => setDeleting(true)}
              >
                Delete local file
              </Button>
              <Button
                variant="primary"
                icon={<Download />}
                onClick={() => download(selected)}
              >
                {selected.kind === "audio" && !selected.dataUrl
                  ? "Download transcript"
                  : "Download file"}
              </Button>
            </>
          )
        }
      >
        {selected && (
          <>
            <div className="ws-between mb-5">
              <span className="ws-meta">
                v{selected.version} · {selected.mime} ·{" "}
                {Math.round(selected.size / 1024)} KB
              </span>
              <Badge
                tone={selected.status === "ready" ? "healthy" : "attention"}
              >
                {selected.status}
              </Badge>
            </div>
            {selected.kind === "app" ? (
              <>
                <div className="flex gap-2 mb-4">
                  <Button
                    size="sm"
                    variant={previewMode === "preview" ? "primary" : "ghost"}
                    onClick={() => setPreviewMode("preview")}
                  >
                    Sandboxed preview
                  </Button>
                  <Button
                    size="sm"
                    variant={previewMode === "source" ? "primary" : "ghost"}
                    onClick={() => setPreviewMode("source")}
                  >
                    Source
                  </Button>
                </div>
                {previewMode === "preview" ? (
                  <iframe
                    title={selected.name + " sandboxed preview"}
                    sandbox="allow-scripts"
                    srcDoc={safeHtml(selected.content ?? "")}
                    className="w-full h-[460px] bg-white border border-line rounded-xl"
                  />
                ) : (
                  <pre className="ws-code">{selected.content}</pre>
                )}
                <p className="ws-meta mt-3">
                  Isolated origin. Network, forms, and parent-page access are
                  blocked.
                </p>
              </>
            ) : selected.kind === "image" ? (
              selected.dataUrl ? (
                <img
                  src={selected.dataUrl}
                  alt={selected.name}
                  className="w-full max-h-[460px] object-contain rounded-xl"
                />
              ) : (
                <Preview item={selected} />
              )
            ) : selected.kind === "audio" ? (
              <>
                {selected.dataUrl ? (
                  <audio
                    className="w-full my-5"
                    controls
                    src={selected.dataUrl}
                  />
                ) : (
                  <>
                    <Preview item={selected} />
                    <SafeNote>
                      This fixture includes a transcript, not a real MP3. The
                      download button exports the transcript honestly.
                    </SafeNote>
                  </>
                )}
                <h3 className="font-semibold mt-6 mb-4">Transcript</h3>
                <RichText
                  text={
                    selected.transcript ??
                    "Uploaded audio. A transcription service is not connected."
                  }
                />
              </>
            ) : selected.content ? (
              <>
                {selected.kind === "code" || selected.kind === "subtitle" ? (
                  <pre className="ws-code">{selected.content}</pre>
                ) : (
                  <RichText text={selected.content} />
                )}
              </>
            ) : (
              <Empty
                title="Download to inspect this file."
                body="This file type does not have a built-in preview. Its original bytes are kept locally."
              />
            )}
            <div className="ws-rule" />
            <p className="ws-kicker mb-3">PROVENANCE</p>
            <p className="ws-muted">
              {selected.originTask ?? "Added in this browser"}
            </p>
            {selected.conversationId && (
              <Button
                className="mt-4"
                icon={<ArrowUpRight />}
                onClick={() => app.navigate("chat", selected.conversationId)}
              >
                Open source conversation
              </Button>
            )}
          </>
        )}
      </Dialog>
      <ConfirmDialog
        open={deleting && !!selected}
        onClose={() => setDeleting(false)}
        title="Delete this local file?"
        confirmLabel="Delete local file"
        impact={[
          selected?.name ?? "",
          "Only the browser copy is removed. No repository or connected service is changed.",
        ]}
        onConfirm={() => {
          app.setLibrary((fs) => fs.filter((f) => f.id !== selected?.id));
          app.setConversations((cs) =>
            cs.map((c) => ({
              ...c,
              files: c.files.filter((id) => id !== selected?.id),
            })),
          );
          app.navigate("library");
          toast.success("Local file removed.");
        }}
      />
    </Page>
  );
}
