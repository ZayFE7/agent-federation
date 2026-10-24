// The compaction summarizer, in one function both agent classes share.
//
// It moved out of src/agent.ts with Task 31: a sub-agent's transcript compacts too,
// and a second copy of this prompt is a second definition of what BLIP keeps when a
// conversation gets long. The 30 s ceiling is the one the call site had before the
// move: a compaction summarize that has not answered by then is a stalled free
// tunnel, not a slow model, and the turn should not wait on it.

import { generateText, type LanguageModel } from "ai";
import { fetchRouter } from "./router";
import { DEFAULT_MODEL_CHEAP, type Env } from "./types";

const SYSTEM =
  "Summarize this conversation for an AI agent's own memory. Keep facts, decisions, file paths, commands that worked, and open tasks. Be compact and concrete.";

export async function summarizeConversation(
  env: Env,
  text: string,
  model?: LanguageModel
): Promise<string> {
  if (model) {
    const out = await generateText({
      model,
      system: SYSTEM,
      prompt: text,
      maxOutputTokens: 800,
      abortSignal: AbortSignal.timeout(30_000),
    });
    const summary = out.text.trim();
    if (!summary) throw new Error("empty compaction summary");
    return summary;
  }
  const res = await fetchRouter(
    env,
    "/v1/chat/completions",
    {
      // Compaction is not the answer the user is waiting for, so it takes the
      // cheap lane id: measured, the cheap lane cannot finish a tool round trip,
      // but a single-shot summarize does not need one.
      model: env.MODEL_CHEAP ?? DEFAULT_MODEL_CHEAP,
      messages: [
        { role: "system", content: SYSTEM },
        { role: "user", content: text },
      ],
      max_tokens: 800,
    },
    false,
    AbortSignal.timeout(30_000)
  );
  if (!res.ok) throw new Error(`router ${res.status}`);
  const data = (await res.json()) as {
    choices?: { message?: { content?: string } }[];
  };
  const summary = (data.choices?.[0]?.message?.content ?? "").trim();
  if (!summary) throw new Error("empty compaction summary");
  return summary;
}
