// Action guardrails for an agent that already has a disposable Linux VM.
//
// The sandbox is the blast radius for ordinary work. Installing packages,
// running a shell, a Python one-liner, a downloaded installer, reading a local
// file or deleting /tmp are all normal agent work and must run without asking
// the owner. The gate exists only for effects that outlive the VM or leave it:
//
//   - recursive deletion of the persistent workspace (/home/user), except known
//     build-output directories;
//   - outbound publishing/pushing, payments and wallet calls, email sends;
//   - outbound uploads of local files (curl/wget forms and body uploads);
//   - commands that destroy the VM or its disk before the workspace can be saved.
//
// Deliberately conservative on those four classes and deliberately permissive
// everywhere else. A false positive asks the owner about ordinary code, which is
// the failure this policy exists to remove. Keep the owner's words in mind:
// "it doesn't need my permission to run code on a temporary computer".

const BUILD_OUTPUT = new Set([
  "node_modules",
  ".cache",
  "dist",
  "build",
  ".next",
  ".nuxt",
  ".output",
  ".venv",
  "venv",
  "__pycache__",
  ".pytest_cache",
  ".turbo",
  ".parcel-cache",
  "coverage",
  ".nyc_output",
  "tmp",
  "temp",
]);

function stripQuotes(value: string): string {
  return value.replace(/^['"]|['"]$/g, "");
}

function baseName(value: string): string {
  const cleaned = stripQuotes(value).replace(/[\\/]+$/, "");
  const parts = cleaned.split(/[\\/]/);
  return parts[parts.length - 1] || cleaned;
}

/** True when a recursive delete target is workspace data rather than build output. */
function isWorkspaceTarget(target: string): boolean {
  const clean = stripQuotes(target);
  if (!clean) return false;
  const lower = clean.toLowerCase();
  // The workspace root itself, the cwd, a wildcard at any level, or home.
  if (/^(?:\*|\.\/\*|\.|\.\.|\/|~|\$home|\$\{home\})(?:\/|\/\*)?$/.test(lower)) return true;
  // Anything outside the persistent home is disposable.
  if (lower === "/tmp" || lower.startsWith("/tmp/")) return false;
  if (lower.startsWith("/") && !lower.startsWith("/home/user")) return false;
  const base = baseName(clean);
  if (!base || base === "." || base === "..") return true;
  if (/[*?[\]{}]/.test(base)) return true;
  return !BUILD_OUTPUT.has(base.toLowerCase());
}

/** `rm -r` and its friends, parsed per command so a comment or a flag cannot hide the target. */
function recursiveWorkspaceDelete(c: string): boolean {
  for (const match of c.matchAll(/\brm\b([^;&|\n]*)/gi)) {
    const args = match[1].replace(/\s+#.*$/, "").trim();
    if (!args) continue;
    const tokens = args.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? [];
    const recursive = tokens.some(
      (token) => /^--recursive$/i.test(token) || /^-[^-]*r/i.test(token)
    );
    if (!recursive) continue;
    const targets = tokens
      .filter((token) => !token.startsWith("-") && token !== "--")
      .map(stripQuotes);
    if (targets.some(isWorkspaceTarget)) return true;
  }
  return false;
}

/** `find . -delete` and `find . -exec rm` are recursive deletes too. */
function workspaceFindDelete(c: string): boolean {
  if (!/\bfind\b/.test(c)) return false;
  if (!/\s(?:-delete|-exec\s+(?:sudo\s+)?rm)\b/.test(c)) return false;
  const match = /\bfind\s+([^\s]+)/.exec(c);
  return match ? isWorkspaceTarget(match[1]) : false;
}

/** Interpreter calls that remove a directory tree by name. */
function interpreterWorkspaceDelete(c: string): boolean {
  for (const match of c.matchAll(/\bshutil\.rmtree\s*\(\s*['"]([^'"]+)['"]/gi)) {
    if (isWorkspaceTarget(match[1])) return true;
  }
  for (const match of c.matchAll(
    /\brmSync\s*\(\s*['"]([^'"]+)['"][^)]*\brecursive\s*:\s*true/gi
  )) {
    if (isWorkspaceTarget(match[1])) return true;
  }
  return false;
}

const OUTWARD: RegExp[] = [
  /\bgit\s+push\b/,
  /\bnpm\s+publish\b/,
  /\byarn\s+publish\b/,
  /\bpip\s+upload\b/,
  /\btwine\s+upload\b/,
  /\bgh\s+release\s+create\b/,
  /\bsendmail\b/,
  /\bmail\s+-s\b/,
  /\b(wallet|stripe|paypal)\b/,
  /\b(payment|payments|invoice|invoices|purchase)\b/,
  /\b(curl|wget)\b[^|;&]*\s(?:-d\b|--data[a-z_-]*\b)\s*\S*@/i,
  /\|\s*(curl|wget)\b/i,
];

/**
 * Upload flags are case sensitive. `curl -F` sends a file and `curl -T`
 * uploads one, while `curl -f` only asks curl to fail on HTTP errors. The
 * command is lowercased for the word patterns above, so this check runs on the
 * original text and normalizes only the tool name.
 */
function uploadCommand(raw: string): boolean {
  const command = raw.replace(/\bcurl\b/gi, "curl").replace(/\bwget\b/gi, "wget");
  return (
    /\bcurl\b[^|;&]*(?:--form[a-z_-]*\b|--data-binary\b|--upload-file\b|--post-file\b|(?:^|\s)-F\b|(?:^|\s)-T\b)/.test(
      command
    ) ||
    /\bwget\b[^|;&]*(?:--post-file\b|--body-file\b)/.test(command)
  );
}


const SYSTEM_DESTRUCTION: RegExp[] = [
  /\bmkfs\b/,
  /\bdd\b[^|;&]*\bof=\/dev\//,
  />\s*\/dev\/(?:sd|nvme|hd|disk)/,
  /:\(\)\s*\{[^}]*\|[^}]*\}\s*;\s*:/,
  /\b(shutdown|reboot|halt|poweroff)\b/,
  /\bchmod\s+-r\s+0?777\s+\//,
  /\bchown\s+-r\b[^|;&]*\s\/(?=\s|$)/,
  /\bwipefs\b/,
];

export function isRisky(cmd: string): boolean {
  const raw = cmd || "";
  const c = raw.toLowerCase();
  if (!c.trim()) return false;
  if (recursiveWorkspaceDelete(c)) return true;
  if (workspaceFindDelete(c)) return true;
  if (interpreterWorkspaceDelete(c)) return true;
  if (uploadCommand(raw)) return true;
  if (OUTWARD.some((re) => re.test(c))) return true;
  if (SYSTEM_DESTRUCTION.some((re) => re.test(c))) return true;
  return false;
}
