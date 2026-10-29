//! Local retrieval embeddings are independent from the chat model and its credentials.
pub mod llama;

use anyhow::{Result, ensure};
use async_trait::async_trait;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use ts_rs::TS;

pub const MAX_BATCH: usize = 16;
pub const MAX_TEXT_BYTES: usize = 8192;
pub const MODEL_DIGEST: &str = "06507c7b42688469c4e7298b0a1e16deff06caf291cf0a5b278c308249c3e439";
pub const MODEL_REVISION: &str = "370f27d7550e0def9b39c1f16d3fbaa13aa67728";

#[derive(Clone, Copy, Debug, Deserialize, Serialize, JsonSchema, TS)]
#[serde(rename_all = "snake_case")]
pub enum EmbeddingPurpose {
    Query,
    Document,
}

#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize, JsonSchema, TS)]
pub struct EmbeddingSpace {
    pub id: String,
    pub model_revision: String,
    pub model_digest: String,
    pub dimensions: u32,
    pub pooling: String,
    pub normalization: String,
    pub instruction_version: u32,
}

impl EmbeddingSpace {
    pub fn qwen3() -> Self {
        let descriptor =
            format!("qwen3-embedding-0.6b:{MODEL_REVISION}:{MODEL_DIGEST}:1024:last:l2:1");
        Self {
            id: format!(
                "sha256:{}",
                hex::encode(Sha256::digest(descriptor.as_bytes()))
            ),
            model_revision: MODEL_REVISION.into(),
            model_digest: MODEL_DIGEST.into(),
            dimensions: 1024,
            pooling: "last".into(),
            normalization: "l2".into(),
            instruction_version: 1,
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema, TS)]
pub struct EmbeddingBatch {
    pub space: EmbeddingSpace,
    pub vectors: Vec<Vec<f32>>,
}

impl EmbeddingBatch {
    pub fn validate(&self, expected: usize) -> Result<()> {
        ensure!(
            self.space == EmbeddingSpace::qwen3(),
            "Unknown embedding space"
        );
        ensure!(
            self.vectors.len() == expected,
            "Embedding count does not match input"
        );
        for vector in &self.vectors {
            ensure!(
                vector.len() == self.space.dimensions as usize,
                "Embedding dimensions do not match space"
            );
            ensure!(
                vector.iter().all(|value| value.is_finite()),
                "Embedding contains a non-finite value"
            );
            let norm = vector
                .iter()
                .map(|value| f64::from(*value).powi(2))
                .sum::<f64>()
                .sqrt();
            ensure!((norm - 1.0).abs() < 0.01, "Embedding is not L2 normalized");
        }
        Ok(())
    }
}

#[async_trait]
pub trait EmbeddingProvider: Send + Sync {
    async fn embed(&self, texts: &[String], purpose: EmbeddingPurpose) -> Result<EmbeddingBatch>;
}

#[cfg(test)]
mod tests {
    use crate::embeddings::{EmbeddingBatch, EmbeddingSpace};

    #[test]
    fn rejects_mixed_spaces_and_invalid_vectors() {
        let mut batch = EmbeddingBatch {
            space: EmbeddingSpace::qwen3(),
            vectors: vec![vec![0.0; 1024]],
        };
        assert!(batch.validate(1).is_err());
        batch.vectors[0][0] = 1.0;
        batch.validate(1).unwrap();
        assert!(batch.validate(2).is_err());
        batch.vectors[0][0] = f32::NAN;
        assert!(batch.validate(1).is_err());
        batch.vectors[0][0] = 1.0;
        batch.space.instruction_version += 1;
        assert!(batch.validate(1).is_err());
    }
}
