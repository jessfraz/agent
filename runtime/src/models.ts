import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { getSupportedThinkingLevels, type Api, type AuthResult, type Model, type MutableModels, type ProviderStreams } from "@earendil-works/pi-ai";
import { builtinModels, getBuiltinProviders } from "@earendil-works/pi-ai/providers/all";
import { MODEL_THINKING_LEVELS } from "@earendil-works/pi-ai/providers/model-schema";
import { AgentDoc, configure, defineDoc, ProviderDoc, type AgentChange, type Conversation, type Harness, type Tx } from "@earendil-works/pi-durable";
import { AuthError, type ChatGptAuth } from "./auth.js";
import type { ModelProvider } from "./generated/ModelProvider.js";
import type { ModelSelection } from "./generated/ModelSelection.js";
import type { Reasoning } from "./generated/Reasoning.js";
import type { WorkerHost } from "./generated/WorkerHost.js";
import type { ConversationChange } from "./generated/ConversationChange.js";
import type { ModelOption } from "./generated/ModelOption.js";
import { withWebSearch } from "./web-search.js";

/** Keep application provider IDs aligned with the pinned upstream registry. */
export const PROVIDERS: readonly ModelProvider[] = getBuiltinProviders();
export const DEFAULT_MODEL: ModelSelection = { provider: "openai", model_id: "gpt-6.1-sol", reasoning: null, fast: false };
export class ModelError extends Error {}

/** Classify known provider failures without exposing their raw responses. */
export async function modelFailureMessage(conversation: Conversation, fallback: string): Promise<string> {
  const page = await conversation.entries({ order: "descending" }, 5, undefined, BACKGROUND_CONTEXT);
  for (const entry of page.items) for (const message of entry.model ?? []) {
    if (message.role !== "assistant") continue;
    // Pi preserves this code in HTTP error bodies and failed response streams.
    // It can mean an app-specific limit, even when the account has credits.
    if (message.stopReason === "error" && message.provider === "openai" &&
        /\bsubscription_sharing_usage_limit_exceeded\b/u.test(message.errorMessage ?? "")) {
      return 'ChatGPT plan usage reached a limit for this app. In Settings → Usage → App limits (https://chatgpt.com/settings/usage), review the app limit and enable "Allow other apps to use credits after reaching your usage limit" to use available credits. Its conversation is retained.';
    }
    if (message.stopReason === "error" && message.errorMessage?.includes("web_search")) {
      return "The provider rejected hosted web search for this model or account. Its conversation is retained.";
    }
    return fallback;
  }
  return fallback;
}
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function provider(value: unknown): value is ModelProvider { return PROVIDERS.some((id) => id === value); }
function reasoning(value: unknown): value is Reasoning { return MODEL_THINKING_LEVELS.some((level) => level === value); }
function supportsFast(model: Model<Api>): boolean { return model.provider === "openai" && model.api === "openai-responses"; }

/** Request the complete exposed explanation once, before every client receives Pi's output. */
function withDetailedReasoning(native: ProviderStreams["streamSimple"]): ProviderStreams["streamSimple"] {
  return (model, context, options) => native(model, context, { ...options,
    onPayload: async (payload, actual) => {
      const previous = await options?.onPayload?.(payload, actual);
      const selected = previous === undefined ? payload : previous;
      if (!object(selected) || !object(selected.reasoning) || typeof selected.reasoning.summary !== "string") return selected;
      return { ...selected, reasoning: { ...selected.reasoning, summary: "detailed" } };
    },
  });
}

/** Old worker launch records held an OpenAI model ID. Configuration itself is strict. */
export function savedModel(value: unknown): ModelSelection | null {
  if (value === undefined || value === null) return null;
  if (typeof value === "string" && value.trim().length > 0) return { ...DEFAULT_MODEL, model_id: value };
  if (object(value) && provider(value.provider) && typeof value.model_id === "string" && value.model_id.trim().length > 0 &&
      (value.reasoning === null || reasoning(value.reasoning)) && typeof value.fast === "boolean") {
    return { provider: value.provider, model_id: value.model_id, reasoning: value.reasoning, fast: value.fast };
  }
  throw new ModelError("Saved model selection is invalid; its state was retained.");
}
export function savedHost(host: WorkerHost): WorkerHost {
  return host.launch === undefined || host.launch === null ? host : {
    ...host, launch: { ...host.launch, model: savedModel(host.launch.model) },
  };
}

const Policies = defineDoc<{ sessions: Record<string, ModelSelection> }>({
  kind: "agent.models", scope: "session", version: 1, initial: () => ({ sessions: {} }), checkpointWhen: () => true,
});

/** Pi owns model catalogs, auth and inference. This adapter owns saved application choices. */
export class ConversationModels {
  private readonly catalogRefreshes = new Map<ModelProvider, Promise<void>>();
  private bindSession: ((session: Harness) => void) | undefined;
  private readonly session = new Promise<Harness>((resolve) => { this.bindSession = resolve; });
  constructor(readonly models: MutableModels = builtinModels(), auth?: ChatGptAuth) {
    for (const id of ["openai", "openai-codex"]) {
      const provider = models.getProvider(id);
      if (provider !== undefined) models.setProvider({ ...provider, streamSimple: withDetailedReasoning(withWebSearch(provider.streamSimple)) });
    }
    const openai = models.getProvider("openai");
    if (openai !== undefined) {
      const nativeKey = openai.auth.apiKey;
      models.setProvider({ ...openai,
        auth: auth === undefined ? openai.auth : { ...openai.auth, apiKey: {
          name: "ChatGPT plan or OpenAI API key",
          async resolve(args) {
            const state = await auth.status();
            // A stored plan credential owns this provider, including its failures.
            if (state.state === "signed_out") {
              const native = await nativeKey?.resolve(args);
              if (native !== undefined) return native;
            }
            const credential = await auth.credential();
            return { auth: { apiKey: credential.access }, source: "ChatGPT plan" };
          },
        } },
        streamSimple: (model, context, options) => openai.streamSimple(model, context, { ...options,
          onPayload: async (payload, actual) => {
            const previous = await options?.onPayload?.(payload, actual);
            const session = await this.session;
            const policy = options?.sessionId === undefined ? undefined
              : (await session.snapshot(Policies, BACKGROUND_CONTEXT))?.sessions[options.sessionId];
            if (policy?.fast !== true) return previous;
            // A settings change can commit after this generation chose its model.
            // Its next request owns the new policy; do not alter this older one.
            if (policy.provider !== actual.provider || policy.model_id !== actual.id) return previous;
            const selected = previous ?? payload;
            if (!object(selected)) throw new ModelError("The provider returned an invalid request payload.");
            return { ...selected, service_tier: "priority" };
          },
        }),
      });
    }
  }
  bind(session: Harness): void { this.bindSession?.(session); this.bindSession = undefined; }
  validate(selection: ModelSelection): void {
    const model = this.models.getModel(selection.provider, selection.model_id);
    if (model === undefined) throw new ModelError(`Unknown model ${selection.provider}/${selection.model_id}.`);
    if (selection.reasoning !== null && !getSupportedThinkingLevels(model).includes(selection.reasoning)) {
      throw new ModelError(`Reasoning ${selection.reasoning} is unavailable for ${selection.provider}/${selection.model_id}.`);
    }
    if (selection.fast && !supportsFast(model)) {
      throw new ModelError(`Fast mode is unavailable for ${selection.provider}/${selection.model_id}.`);
    }
  }
  async preflight(selection: ModelSelection): Promise<void> {
    if (this.models.getModel(selection.provider, selection.model_id) === undefined &&
        this.models.getProvider(selection.provider)?.refreshModels !== undefined) {
      let refresh = this.catalogRefreshes.get(selection.provider);
      if (refresh === undefined) {
        refresh = (async () => {
          const refreshed = await this.models.refresh({ providers: [selection.provider], signal: AbortSignal.timeout(15_000) });
          if (refreshed.errors.has(selection.provider)) throw new ModelError(`Could not refresh the model catalog for ${selection.provider}.`);
        })().finally(() => { this.catalogRefreshes.delete(selection.provider); });
        this.catalogRefreshes.set(selection.provider, refresh);
      }
      await refresh;
    }
    this.validate(selection);
    let credential: AuthResult | undefined;
    try { credential = await this.models.getAuth(selection.provider); }
    catch (error) {
      // Models wraps provider-auth errors; preserve the application's safe,
      // actionable failure without exposing native token/transport diagnostics.
      if (error instanceof Error && error.cause instanceof AuthError) throw error.cause;
      throw new AuthError("refresh", `Could not resolve authentication for ${selection.provider}; saved credentials were retained.`);
    }
    if (credential === undefined) {
      throw new AuthError("needs_sign_in", `No authentication configured for ${selection.provider}. Configure its Pi authentication in the coordinator environment.`);
    }
  }
  async configure(conversation: Conversation, selection: ModelSelection, change: AgentChange): Promise<void> {
    this.validate(selection);
    const session = await this.session;
    await session.commit((tx) => this.configureIn(tx, conversation, selection, change), BACKGROUND_CONTEXT);
  }
  private async configureIn(tx: Tx, conversation: Conversation, selection: ModelSelection, change: AgentChange): Promise<void> {
    const native = await tx.doc(ProviderDoc, conversation.id);
    const policies = await tx.doc(Policies);
    policies.sessions[native.sessionId] = { ...selection };
    await configure(tx, conversation.id, { ...change, model: { provider: selection.provider, modelId: selection.model_id },
      thinkingLevel: selection.reasoning });
  }
  private async currentIn(tx: Tx, conversation: Conversation, fallback: ModelSelection): Promise<ModelSelection> {
    const native = await tx.doc(AgentDoc, conversation.id);
    if (native.model === undefined) return { ...fallback };
    if (!provider(native.model.provider)) throw new ModelError("The saved provider is unavailable; its conversation was retained.");
    const connection = await tx.doc(ProviderDoc, conversation.id);
    const saved = (await tx.doc(Policies)).sessions[connection.sessionId];
    return { provider: native.model.provider, model_id: native.model.modelId, reasoning: native.thinkingLevel ?? null,
      fast: saved?.provider === native.model.provider && saved.model_id === native.model.modelId && saved.fast };
  }
  /** Startup context must not overwrite a setting changed while it was loading. */
  async configureCurrent(conversation: Conversation, fallback: ModelSelection, change: AgentChange): Promise<ModelSelection> {
    const session = await this.session;
    return session.commit(async (tx) => {
      const selected = await this.currentIn(tx, conversation, fallback); this.validate(selected);
      await this.configureIn(tx, conversation, selected, change); return selected;
    }, BACKGROUND_CONTEXT);
  }
  catalog(): ModelOption[] {
    return this.models.getModels().flatMap((model) => provider(model.provider) ? [{ provider: model.provider, model_id: model.id,
      name: model.name, reasoning: [...getSupportedThinkingLevels(model)], fast: supportsFast(model) }] : [])
      .sort((left, right) => left.provider.localeCompare(right.provider) || left.model_id.localeCompare(right.model_id));
  }
  private changed(current: ModelSelection, change: ConversationChange): ModelSelection {
    if (change.type === "set_selection") return { ...change.model };
    if (change.type === "set_fast") return { ...current, fast: change.mode === "toggle" ? !current.fast : change.mode === "on" };
    if (change.type === "set_reasoning") return { ...current, reasoning: change.reasoning };
    const provider = change.provider ?? current.provider;
    const model = this.models.getModel(provider, change.model_id);
    return { provider, model_id: change.model_id,
      reasoning: model !== undefined && current.reasoning !== null && getSupportedThinkingLevels(model).includes(current.reasoning) ? current.reasoning : null,
      fast: model !== undefined && supportsFast(model) && current.fast };
  }
  /** Native configuration and application actor metadata share the Pi commit. */
  async edit(conversation: Conversation, fallback: ModelSelection, change: ConversationChange | null,
    save?: (tx: Tx, selected: ModelSelection) => Promise<void>): Promise<ModelSelection> {
    const session = await this.session;
    const current = await this.legacy(conversation, fallback);
    if (change === null) return current;
    const resolved = change.type === "set_model" ? { ...change, provider: change.provider ?? current.provider } : change;
    if (resolved.type === "set_model" || resolved.type === "set_selection") await this.preflight(this.changed(current, resolved));
    return session.commit(async (tx) => {
      const current = await this.currentIn(tx, conversation, fallback);
      const selected = this.changed(current, resolved); this.validate(selected);
      await this.configureIn(tx, conversation, selected, {});
      await save?.(tx, selected); return selected;
    }, BACKGROUND_CONTEXT);
  }
  async legacy(conversation: Conversation, fallback: ModelSelection): Promise<ModelSelection> {
    const session = await this.session;
    return session.commit((tx) => this.currentIn(tx, conversation, fallback), BACKGROUND_CONTEXT);
  }
  /** Presentation must not create native provider or configuration documents. */
  async peek(conversation: Conversation, fallback: ModelSelection): Promise<ModelSelection> {
    const session = await this.session;
    const native = await session.snapshot(AgentDoc, conversation.id, BACKGROUND_CONTEXT);
    if (native?.model === undefined) return { ...fallback };
    if (!provider(native.model.provider)) throw new ModelError("The saved provider is unavailable; its conversation was retained.");
    const connection = await session.snapshot(ProviderDoc, conversation.id, BACKGROUND_CONTEXT);
    const policy = connection === undefined ? undefined
      : (await session.snapshot(Policies, BACKGROUND_CONTEXT))?.sessions[connection.sessionId];
    return { provider: native.model.provider, model_id: native.model.modelId, reasoning: native.thinkingLevel ?? null,
      fast: policy?.provider === native.model.provider && policy.model_id === native.model.modelId && policy.fast };
  }
}
