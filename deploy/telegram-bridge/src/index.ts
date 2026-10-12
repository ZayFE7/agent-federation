// Telegram bridge: cron-polls getUpdates, forwards messages to the agent brain,
// replies back into Telegram with the envelope state as a status suffix.
// Env: TELEGRAM_BOT_TOKEN (secret), AGENT_API_KEY (secret), AGENT_URL (var).

interface Env {
  TELEGRAM_BOT_TOKEN: string;
  AGENT_API_KEY: string;
  AGENT_URL: string;
  BRIDGE: KVNamespace;
}

const TG = "https://api.telegram.org";

async function tg(method: string, body: unknown, token: string): Promise<unknown> {
  const res = await fetch(`${TG}/bot${token}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return res.json();
}

async function handleUpdate(u: Record<string, unknown>, env: Env): Promise<void> {
  const msg = (u.message ?? u.edited_message) as
    | { chat?: { id?: number }; text?: string; from?: { first_name?: string } }
    | undefined;
  if (!msg?.chat?.id || !msg.text) return;

  // Commands
  if (msg.text.startsWith("/start")) {
    await tg(
      "sendMessage",
      { chat_id: msg.chat.id, text: "Blip online. Send me anything: questions, jobs (\"every morning at 8 ...\"), or \"what can you do\"." },
      env.TELEGRAM_BOT_TOKEN
    );
    return;
  }
  if (msg.text.startsWith("/state")) {
    await tg(
      "sendMessage",
      { chat_id: msg.chat.id, text: "state: " + ((await env.BRIDGE.get("lastState")) || "idle") },
      env.TELEGRAM_BOT_TOKEN
    );
    return;
  }

  // Forward to brain
  let reply = "(agent unreachable)";
  let state = "";
  let verb = "";
  try {
    const res = await fetch(`${env.AGENT_URL}/api/message`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${env.AGENT_API_KEY}`,
      },
      body: JSON.stringify({ content: msg.text, tier: "primary" }),
    });
    const j = (await res.json()) as { reply?: string; state?: string; verb?: string; error?: string };
    reply = j.reply || j.error || JSON.stringify(j);
    state = j.state || "";
    verb = j.verb || "";
  } catch (e) {
    reply = "network error: " + String(e);
  }

  await env.BRIDGE.put("lastState", state || "idle");

  const suffix = verb ? `  [${verb}]` : "";
  // Telegram max ~4096 chars per message
  const text = reply.length > 3900 ? reply.slice(0, 3900) + "\n..." : reply;
  await tg("sendMessage", { chat_id: msg.chat.id, text: text + suffix }, env.TELEGRAM_BOT_TOKEN);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/health") {
      return Response.json({ ok: true, service: "telegram-bridge" });
    }
    // Manual trigger for instant delivery between cron ticks
    if (url.pathname === "/poll" && request.method === "POST") {
      await pollOnce(env);
      return Response.json({ ok: true });
    }
    return Response.json({ error: "not found" }, { status: 404 });
  },

  // Every minute: drain the Telegram queue and process updates in order.
  async scheduled(_event: ScheduledController, env: Env): Promise<void> {
    await pollOnce(env);
  },
} satisfies ExportedHandler<Env>;

async function pollOnce(env: Env): Promise<void> {
  const raw = await env.BRIDGE.get("offset");
  const offset = raw ? Number(raw) : 0;
  const data = (await tg("getUpdates", { offset, timeout: 0, allowed_updates: ["message"] }, env.TELEGRAM_BOT_TOKEN)) as {
    ok?: boolean;
    result?: Array<{ update_id: number; message?: unknown; edited_message?: unknown }>;
  };
  if (!data.ok || !data.result?.length) return;
  let maxId = offset;
  for (const u of data.result) {
    try {
      await handleUpdate(u as Record<string, unknown>, env);
    } catch (e) {
      console.log("update error", String(e));
    }
    if (u.update_id > maxId) maxId = u.update_id;
  }
  await env.BRIDGE.put("offset", String(maxId + 1));
}
