// Metrics collector (#24): calls and tokens per task from an agent transcript.
//
// Normalised transcript events (what every agent adapter produces):
//   { type: "tool_call",   name, id? }
//   { type: "tool_result", text, id? }            text a tool returned to the model (id links it to its call)
//   { type: "usage",       input, output }        model-reported tokens for one model turn
//   { type: "final",       text }                 the agent's last message
//
// Tokens are reported two ways (D23, #24):
//   modelTokens - what the model provider reported (input + output, including cache reads/writes)
//   charTokens  - ceil(chars / 4) of the text of every TabAgent tool result (the project-wide token)

export const charTokens = (text) => Math.ceil(String(text ?? "").length / 4);

/**
 * Only TabAgent tools count. Real agents see them as `mcp__tabagent__<wire name>`;
 * the scripted fake agent uses registry names (`act.click`, `tabs`).
 */
export function isTabAgentTool(name) {
  return /^mcp__tabagent__/.test(name) || /^[a-z]+([._][a-zA-Z]+)?$/.test(name);
}

export function collect(events) {
  let calls = 0;
  let modelTokens = 0;
  let sawUsage = false;
  let chars = 0;
  let final = null;
  const otherIds = new Set();
  for (const e of events) {
    if (e.type === "tool_call") {
      if (isTabAgentTool(e.name)) calls++;
      else if (e.id) otherIds.add(e.id);
    } else if (e.type === "tool_result") {
      if (!(e.id && otherIds.has(e.id))) chars += charTokens(e.text);
    } else if (e.type === "usage") {
      sawUsage = true;
      modelTokens += (e.input ?? 0) + (e.output ?? 0);
    } else if (e.type === "final") final = e.text;
  }
  return { calls, modelTokens: sawUsage ? modelTokens : null, charTokens: chars, final };
}

const blockText = (c) => {
  if (typeof c === "string") return c;
  if (Array.isArray(c)) return c.map((x) => (x?.type === "text" ? x.text : "")).join("");
  return "";
};

/**
 * Claude Code `--output-format stream-json --verbose` → normalised events.
 * One assistant message can span several lines that repeat its id and usage;
 * usage is counted once per message id. When the final `result` line carries
 * usage, it replaces the per-message sum.
 */
export function fromClaudeStreamJson(text) {
  const events = [];
  const seen = new Set();
  const perMessage = [];
  let total = null;
  let final = null;
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let j;
    try {
      j = JSON.parse(line);
    } catch {
      continue;
    }
    if (j.type === "assistant" && j.message) {
      for (const c of j.message.content ?? []) {
        if (c.type === "tool_use") events.push({ type: "tool_call", name: c.name, id: c.id });
        if (c.type === "text" && c.text) final = c.text;
      }
      const id = j.message.id;
      const u = j.message.usage;
      if (u && !(id && seen.has(id))) {
        if (id) seen.add(id);
        perMessage.push(usageOf(u));
      }
    } else if (j.type === "user" && j.message) {
      for (const c of j.message.content ?? []) {
        if (c.type === "tool_result") events.push({ type: "tool_result", text: blockText(c.content), id: c.tool_use_id });
      }
    } else if (j.type === "result") {
      if (j.usage) total = usageOf(j.usage);
      if (typeof j.result === "string") final = j.result;
    }
  }
  for (const u of total ? [total] : perMessage) events.push({ type: "usage", ...u });
  if (final !== null) events.push({ type: "final", text: final });
  return events;
}

function usageOf(u) {
  return {
    input: (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0),
    output: u.output_tokens ?? 0,
  };
}
