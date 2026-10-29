import { createAssistantMessageEventStream, type Api, type AssistantMessage, type AssistantMessageEvent,
  type Model, type ProviderStreams } from "@earendil-works/pi-ai";

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Hosted tools belong to the provider; they are not application function calls. */
export function supportsWebSearch(model: Model<Api>): boolean {
  return (model.provider === "openai" && model.api === "openai-responses")
    || (model.provider === "openai-codex" && model.api === "openai-codex-responses");
}

interface Citation { start: number; end: number; url: string }
function citation(value: unknown): Citation | undefined {
  if (!object(value) || value.type !== "url_citation" || typeof value.url !== "string"
    || typeof value.start_index !== "number" || typeof value.end_index !== "number"
    || !Number.isSafeInteger(value.start_index) || !Number.isSafeInteger(value.end_index)) return undefined;
  try {
    const url = new URL(value.url);
    if (url.protocol !== "https:" && url.protocol !== "http:") return undefined;
    return { start: value.start_index, end: value.end_index, url: url.href };
  } catch { return undefined; }
}
function boundary(text: string, index: number): boolean {
  return index >= 0 && index <= text.length
    && !(index > 0 && index < text.length && text.charCodeAt(index - 1) >= 0xd800
      && text.charCodeAt(index - 1) <= 0xdbff && text.charCodeAt(index) >= 0xdc00 && text.charCodeAt(index) <= 0xdfff);
}

/** Preserve the answer and turn provider-owned citation spans into portable links. */
function citedText(text: string, annotations: unknown, sources: string[]): string {
  if (!Array.isArray(annotations)) return text;
  const citations = annotations.flatMap((value) => { const found = citation(value); return found === undefined ? [] : [found]; });
  for (const item of citations) if (!sources.includes(item.url)) sources.push(item.url);
  const links = (item: Citation) => `[${sources.indexOf(item.url) + 1}](<${item.url.replaceAll(">", "%3E").replaceAll("<", "%3C")}>)`;
  let offset = 0, result = "";
  const appended = new Set<string>();
  for (const item of citations.sort((left, right) => left.start - right.start || left.end - right.end)) {
    if (item.start < offset || item.end < item.start || !boundary(text, item.start) || !boundary(text, item.end)) {
      appended.add(links(item)); continue;
    }
    const span = text.slice(item.start, item.end);
    // This exact provider citation token is presentation metadata. Ordinary
    // annotated words remain intact, including an unexpected future format.
    const marker = /^\uE200cite\uE202[^\uE201]*\uE201$/u.test(span);
    result += text.slice(offset, item.start) + (marker ? "" : span) + (span.includes(item.url) ? "" : links(item));
    offset = item.end;
  }
  return result + text.slice(offset) + (appended.size === 0 ? "" : " " + [...appended].join(" "));
}

/** Correlate public provider message IDs with Pi's public text-start sequence. */
class Citations {
  private readonly starts: string[] = [];
  private readonly seen = new Set<string>();
  private readonly completed = new Map<string, string>();
  private readonly blocks = new Map<number, string>();
  private completedMessage(item: Record<string, unknown>): void {
    if (item.type !== "message" || typeof item.id !== "string" || !Array.isArray(item.content)) return;
    let text = ""; const sources: string[] = [];
    for (const part of item.content) {
      if (!object(part)) continue;
      if (part.type === "output_text" && typeof part.text === "string") text += citedText(part.text, part.annotations, sources);
      else if (part.type === "refusal" && typeof part.refusal === "string") text += part.refusal;
    }
    this.completed.set(item.id, text);
  }
  observe(value: unknown): void {
    if (!object(value)) return;
    if ((value.type === "response.completed" || value.type === "response.incomplete") && object(value.response) && Array.isArray(value.response.output)) {
      for (const item of value.response.output) if (object(item)) this.completedMessage(item);
      return;
    }
    if (value.type !== "response.output_item.added" && value.type !== "response.output_item.done") return;
    const item = value.item;
    if (!object(item) || item.type !== "message" || typeof item.id !== "string") return;
    if (!this.seen.has(item.id)) { this.starts.push(item.id); this.seen.add(item.id); }
    if (value.type === "response.output_item.done") this.completedMessage(item);
  }
  private message(message: AssistantMessage): AssistantMessage {
    return { ...message, content: message.content.map((part, index) => {
      const id = this.blocks.get(index), text = id === undefined ? undefined : this.completed.get(id);
      return part.type === "text" && text !== undefined ? { ...part, text } : part;
    }) };
  }
  event(event: AssistantMessageEvent): AssistantMessageEvent {
    if (event.type === "text_start") {
      const id = this.starts.shift();
      if (id !== undefined) this.blocks.set(event.contentIndex, id);
    }
    if (event.type === "done") return { ...event, message: this.message(event.message) };
    if (event.type === "error") return { ...event, error: this.message(event.error) };
    const partial = this.message(event.partial);
    if (event.type === "text_end") {
      const block = partial.content[event.contentIndex];
      return { ...event, partial, content: block?.type === "text" ? block.text : event.content };
    }
    return { ...event, partial };
  }
}

/** Pi still owns transport, auth, retry, reasoning, replay signatures and usage. */
export function withWebSearch(native: ProviderStreams["streamSimple"]): ProviderStreams["streamSimple"] {
  return (model, context, options) => {
    if (!supportsWebSearch(model)) return native(model, context, options);
    const citations = new Citations();
    const source = native(model, context, { ...options,
      onPayload: async (payload, actual) => {
        const previous = await options?.onPayload?.(payload, actual);
        const selected = previous === undefined ? payload : previous;
        if (!object(selected) || (selected.tools !== undefined && !Array.isArray(selected.tools))) {
          throw new Error("The provider returned an invalid web search request payload.");
        }
        const tools: unknown[] = selected.tools ?? [];
        if (tools.some((tool) => object(tool) && (tool.type === "web_search" || tool.type === "web_search_2025_08_26"))) return selected;
        return { ...selected, tools: [...tools, { type: "web_search", external_web_access: true }] };
      },
      onProviderStreamEvent: async (event, actual) => {
        citations.observe(event);
        await options?.onProviderStreamEvent?.(event, actual);
      },
    });
    const output = createAssistantMessageEventStream();
    void (async () => {
      for await (const event of source) output.push(citations.event(event));
      output.end();
    })();
    return output;
  };
}
