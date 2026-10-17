// Action guardrails: classify a shell command by blast radius so the agent can
// auto-run low-risk work but must hold high-risk work for explicit human approval.
// Dependency-free and pure so it can be unit-tested directly (tests/guardrails.test.mjs).

/**
 * Classify a shell command by blast radius. High-risk = destructive, irreversible,
 * outward-facing, credential-touching, or money-spending. The MODEL must never
 * auto-run these; they are held for explicit human approval (see the exec tool in
 * agent.ts). Deliberately conservative: a false positive only asks the user, a
 * false negative lets a prompt-injected or confused model wreck something.
 *
 * Note: the deterministic "run:" prefix is the human typing the command themselves,
 * so it is already authorized and bypasses this gate.
 */
export function isRisky(cmd: string): boolean {
  const c = (cmd || "").toLowerCase();
  if (!c.trim()) return false;
  // NOTE: every literal below is lowercase because `c` is lowercased first.
  const patterns: RegExp[] = [
    // destructive filesystem / disk
    /\brm\s+-[a-z]*r/, /\brm\s+-[a-z]*f/, /\brm\s+.*--no-preserve-root/,
    /\bmkfs\b/, /\bdd\b[^|;&]*\bof=\/dev\//, />\s*\/dev\/(sd|nvme|hd|disk)/,
    /:\(\)\s*\{[^}]*\|[^}]*\}\s*;\s*:/, // fork bomb
    /\bshred\b/, /\bwipefs\b/,
    /\bchmod\s+-r\s+0?777\s+\//, /\bchown\s+-r\b[^|;&]*\s\/(\s|$)/,
    // privilege / package removal
    /\bsudo\b/, /\bdoas\b/,
    /\b(apt|apt-get|yum|dnf|pacman|zypper)\s+(remove|purge|autoremove|erase)\b/,
    // publish / push / hard VCS resets (outward-facing or history-destroying)
    /\bnpm\s+publish\b/, /\byarn\s+publish\b/, /\bpip\s+upload\b/, /\btwine\s+upload\b/,
    /\bgit\s+push\b/, /\bgit\s+reset\s+--hard\b/, /\bgit\s+clean\s+-[a-z]*f/,
    /\bgit\s+branch\s+-d\b/,
    // destructive SQL (DELETE FROM without any WHERE clause; DROP/TRUNCATE always)
    /\b(drop\s+(table|database|schema)|truncate\s+table)\b/,
    /\bdelete\s+from\b(?![\s\S]*\bwhere\b)/,
    // pipe-to-shell (remote code execution)
    /\b(curl|wget)\b[^|;&]*\|\s*(sudo\s+)?(ba|z|k)?sh\b/,
    // process / power control
    /\bkill\s+-9\b/, /\bpkill\b/, /\bkillall\b/,
    /\b(shutdown|reboot|halt|poweroff|init\s+0|init\s+6)\b/,
    // credential / secret access
    /\bcat\b[^|;&]*(\.env\b|\.aws\/|id_rsa|id_ed25519|\.netrc|credentials|secrets?\.(json|ya?ml)|\.pem\b)/,
    /(\/etc\/shadow|\/etc\/sudoers)/,
    // money / outward sends (bare "checkout" excluded: git checkout is not a payment)
    /\b(payment|payments|invoice|invoices|wallet|purchase|stripe|paypal)\b/,
    /\bsendmail\b/, /\bmail\s+-s\b/,
    /\bcurl\b[^|;&]*-x\s*post\b[^|;&]*(send|charge|pay|order|purchase)/,
    // system file writes
    />\s*\/etc\//, /\btee\s+\/etc\//,
  ];
  return patterns.some((re) => re.test(c));
}
