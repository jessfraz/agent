//! Application selection; Pi owns model catalogs, capabilities and inference.

use anyhow::{Result, ensure};
use clap::ValueEnum;
use schemars::JsonSchema;
use serde::{Deserialize, Deserializer, Serialize};
use ts_rs::TS;

macro_rules! model_providers {
    ($($(#[$attribute:meta])* $variant:ident => $id:literal),+ $(,)?) => {
        #[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, JsonSchema, TS, ValueEnum, PartialEq, Eq)]
        pub enum ModelProvider {
            $($(#[$attribute])* #[serde(rename = $id)] #[value(name = $id)] $variant,)+
        }
        impl ModelProvider {
            pub fn as_str(self) -> &'static str {
                match self { $(Self::$variant => $id,)+ }
            }
        }
    };
}

model_providers! {
    AmazonBedrock => "amazon-bedrock",
    AntLing => "ant-ling",
    Anthropic => "anthropic",
    Google => "google",
    GoogleVertex => "google-vertex",
    #[default] OpenAi => "openai",
    Azure => "azure",
    OpenAiCodex => "openai-codex",
    Radius => "radius",
    Typesafe => "typesafe",
    Nvidia => "nvidia",
    Deepseek => "deepseek",
    GithubCopilot => "github-copilot",
    Xai => "xai",
    Groq => "groq",
    Cerebras => "cerebras",
    Openrouter => "openrouter",
    VercelAiGateway => "vercel-ai-gateway",
    Zai => "zai",
    ZaiCodingCn => "zai-coding-cn",
    Mistral => "mistral",
    Minimax => "minimax",
    MinimaxCn => "minimax-cn",
    Moonshotai => "moonshotai",
    MoonshotaiCn => "moonshotai-cn",
    Huggingface => "huggingface",
    Fireworks => "fireworks",
    Together => "together",
    Baseten => "baseten",
    Opencode => "opencode",
    OpencodeGo => "opencode-go",
    KimiCoding => "kimi-coding",
    Meta => "meta",
    CloudflareWorkersAi => "cloudflare-workers-ai",
    CloudflareAiGateway => "cloudflare-ai-gateway",
    QwenTokenPlan => "qwen-token-plan",
    QwenTokenPlanCn => "qwen-token-plan-cn",
    QwenTokenPlanIndividual => "qwen-token-plan-individual",
    Xiaomi => "xiaomi",
    XiaomiTokenPlanCn => "xiaomi-token-plan-cn",
    XiaomiTokenPlanAms => "xiaomi-token-plan-ams",
    XiaomiTokenPlanSgp => "xiaomi-token-plan-sgp",
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, JsonSchema, TS, ValueEnum, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Reasoning {
    Off,
    Minimal,
    Low,
    Medium,
    High,
    Xhigh,
    Max,
}

impl Reasoning {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Off => "off",
            Self::Minimal => "minimal",
            Self::Low => "low",
            Self::Medium => "medium",
            Self::High => "high",
            Self::Xhigh => "xhigh",
            Self::Max => "max",
        }
    }
}

#[derive(Clone, Debug, Serialize, JsonSchema, TS, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ModelSelection {
    pub provider: ModelProvider,
    #[schemars(length(min = 1), pattern(r"\S"))]
    pub model_id: String,
    pub reasoning: Option<Reasoning>,
    pub fast: bool,
}

impl Default for ModelSelection {
    fn default() -> Self {
        Self {
            provider: ModelProvider::OpenAi,
            model_id: "gpt-6.1-sol".into(),
            reasoning: None,
            fast: false,
        }
    }
}

impl ModelSelection {
    pub fn validate(&self) -> Result<()> {
        ensure!(
            !self.model_id.trim().is_empty() && !self.model_id.chars().any(char::is_control),
            "Model ID must be nonempty and contain no control characters"
        );
        Ok(())
    }

    pub fn cli_args(&self) -> Vec<String> {
        let mut args = vec![
            "--provider".into(),
            self.provider.as_str().into(),
            "--model".into(),
            self.model_id.clone(),
        ];
        if let Some(reasoning) = self.reasoning {
            args.extend(["--reasoning".into(), reasoning.as_str().into()]);
        } else {
            args.push("--default-reasoning".into());
        }
        args.push(if self.fast { "--fast" } else { "--no-fast" }.into());
        args
    }
}

impl<'de> Deserialize<'de> for ModelSelection {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> std::result::Result<Self, D::Error> {
        #[derive(Deserialize)]
        #[serde(deny_unknown_fields)]
        struct Input {
            #[serde(default)]
            provider: ModelProvider,
            #[serde(default = "default_model_id")]
            model_id: String,
            reasoning: Option<Reasoning>,
            #[serde(default)]
            fast: bool,
        }
        fn default_model_id() -> String {
            ModelSelection::default().model_id
        }
        let input = Input::deserialize(deserializer)?;
        let selection = Self {
            provider: input.provider,
            model_id: input.model_id,
            reasoning: input.reasoning,
            fast: input.fast,
        };
        selection.validate().map_err(serde::de::Error::custom)?;
        Ok(selection)
    }
}

#[cfg(test)]
mod tests {
    use crate::models::{ModelProvider, ModelSelection, Reasoning};
    use clap::ValueEnum;

    #[test]
    fn provider_cli_and_wire_names_roundtrip_the_same_exact_values() {
        assert_eq!(ModelProvider::value_variants().len(), 42);
        for provider in ModelProvider::value_variants() {
            let encoded = serde_json::to_string(provider).unwrap();
            assert_eq!(
                serde_json::from_str::<String>(&encoded).unwrap(),
                provider.as_str()
            );
            assert_eq!(
                ModelProvider::from_str(provider.as_str(), false).unwrap(),
                *provider
            );
            assert_eq!(
                serde_json::from_str::<ModelProvider>(&encoded).unwrap(),
                *provider
            );
        }
        assert!(ModelProvider::from_str("made-up-provider", false).is_err());
    }

    #[test]
    fn model_selection_defaults_and_validation_keep_dynamic_ids_typed() {
        let default: ModelSelection = serde_json::from_str("{}").unwrap();
        assert_eq!(default, ModelSelection::default());
        let selected: ModelSelection = serde_json::from_str(r#"{"provider":"anthropic","model_id":"future-model-version","reasoning":"high","fast":true}"#).unwrap();
        assert_eq!(selected.provider, ModelProvider::Anthropic);
        assert_eq!(selected.model_id, "future-model-version");
        assert_eq!(selected.reasoning, Some(Reasoning::High));
        assert!(selected.fast);
        assert_eq!(
            serde_json::from_str::<ModelSelection>(&serde_json::to_string(&selected).unwrap())
                .unwrap(),
            selected
        );
        for invalid in [
            r#"{"model_id":""}"#,
            r#"{"model_id":"   "}"#,
            r#"{"model_id":"bad\u0000model"}"#,
            r#"{"reasoning":"extreme"}"#,
            r#"{"provider":"made-up"}"#,
            r#"{"fast":true,"unknown":false}"#,
        ] {
            assert!(serde_json::from_str::<ModelSelection>(invalid).is_err());
        }
    }
}
