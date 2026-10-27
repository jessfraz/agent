import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { getSupportedThinkingLevels, type AuthResult, type MutableModels } from "@earendil-works/pi-ai";
import { builtinModels, getBuiltinProviders } from "@earendil-works/pi-ai/providers/all";
import { MODEL_THINKING_LEVELS } from "@earendil-works/pi-ai/providers/model-schema";
import { AgentDoc, configure, defineDoc, ProviderDoc, type AgentChange, type Conversation, type Harness } from "@earendil-works/pi-durable";
import { AuthError, type ChatGptAuth } from "./auth.js";
import type { ModelProvider } from "./generated/ModelProvider.js";
import type { ModelSelection } from "./generated/ModelSelection.js";
import type { Reasoning } from "./generated/Reasoning.js";
import type { WorkerHost } from "./generated/WorkerHost.js";

/** Keep application provider IDs aligned with the pinned upstream registry. */
export const PROVIDERS: readonly ModelProvider[] = getBuiltinProviders();
export const DEFAULT_MODEL: ModelSelection = { provider: "openai", model_id: "gpt-6.1-sol", reasoning: null, fast: false };
export class ModelError extends Error {}
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function provider(value: unknown): value is ModelProvider { return PROVIDERS.some((id) => id === value); }
function reasoning(value: unknown): value is Reasoning { return MODEL_THINKING_LEVELS.some((level) => level === value); }

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
            if (policy.provider !== actual.provider || policy.model_id !== actual.id) {
              throw new ModelError("Saved request model differs from its conversation policy.");
            }
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
    if (selection.fast && (model.provider !== "openai" || model.api !== "openai-responses")) {
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
    await session.commit(async (tx) => {
      const native = await tx.doc(ProviderDoc, conversation.id);
      const policies = await tx.doc(Policies);
      policies.sessions[native.sessionId] = { ...selection };
      await configure(tx, conversation.id, { ...change, model: { provider: selection.provider, modelId: selection.model_id },
        thinkingLevel: selection.reasoning });
    }, BACKGROUND_CONTEXT);
  }
  async legacy(conversation: Conversation, fallback: ModelSelection): Promise<ModelSelection> {
    const session = await this.session;
    const native = await session.snapshot(AgentDoc, conversation.id, BACKGROUND_CONTEXT);
    if (native?.model === undefined) return fallback;
    if (!provider(native.model.provider)) throw new ModelError("The saved provider is unavailable; its conversation was retained.");
    return { provider: native.model.provider, model_id: native.model.modelId, reasoning: native.thinkingLevel ?? null, fast: false };
  }
}
