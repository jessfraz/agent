//! Notification credentials stay local; devices use the existing trusted transport.

use std::path::PathBuf;

use anyhow::{Result, ensure};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, JsonSchema, TS)]
#[serde(rename_all = "snake_case")]
pub enum ApnsEnvironment {
    Sandbox,
    #[default]
    Production,
}

/// Coordinator-local configuration, never included in announced settings.
#[derive(Clone, Deserialize, Serialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct ApnsConfig {
    pub team_id: String,
    pub key_id: String,
    pub topic: String,
    pub key_file: PathBuf,
    #[serde(default)]
    pub environment: ApnsEnvironment,
}

impl ApnsConfig {
    pub fn validate(&self) -> Result<()> {
        ensure!(
            [&self.team_id, &self.key_id].iter().all(|value| {
                value.len() == 10
                    && value
                        .bytes()
                        .all(|byte| byte.is_ascii_uppercase() || byte.is_ascii_digit())
            }),
            "APNs team_id and key_id must be ten uppercase letters or digits"
        );
        ensure!(
            !self.topic.is_empty()
                && self.topic.len() <= 255
                && self
                    .topic
                    .bytes()
                    .all(|byte| { byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-') }),
            "APNs topic must be the app's bundle identifier"
        );
        ensure!(
            self.key_file.is_absolute() && !self.key_file.starts_with("/nix/store"),
            "APNs key_file must be an absolute private file outside the Nix store"
        );
        Ok(())
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema, TS)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
pub enum NotificationRequest {
    Status {
        installation_id: String,
    },
    Register {
        installation_id: String,
        token: String,
    },
    Unregister {
        installation_id: String,
    },
}

impl NotificationRequest {
    pub fn validate(&self) -> Result<()> {
        let installation_id = match self {
            Self::Status { installation_id }
            | Self::Register {
                installation_id, ..
            }
            | Self::Unregister { installation_id } => installation_id,
        };
        ensure!(
            uuid::Uuid::parse_str(installation_id).is_ok(),
            "Notification installation_id must be a UUID"
        );
        if let Self::Register { token, .. } = self {
            // Apple deliberately leaves device-token length variable.
            ensure!(
                !token.is_empty()
                    && token.len() <= 1_024
                    && token.len().is_multiple_of(2)
                    && token.bytes().all(|byte| byte.is_ascii_hexdigit()),
                "Notification token must contain at most 1024 hexadecimal characters"
            );
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema, TS)]
pub struct NotificationStatus {
    pub configured: bool,
    pub registered: bool,
}

/// Public identity only. Notification payloads never include transcript text.
#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema, TS)]
pub struct NotificationTarget {
    pub conversation_id: String,
    pub entry_id: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn registration_uses_native_identity_and_accepts_variable_length_tokens() {
        let installation_id = uuid::Uuid::new_v4().to_string();
        let request = NotificationRequest::Register {
            installation_id,
            token: "01ab".repeat(24),
        };
        request.validate().unwrap();
        let decoded: NotificationRequest =
            serde_json::from_slice(&serde_json::to_vec(&request).unwrap()).unwrap();
        decoded.validate().unwrap();
        assert!(
            NotificationRequest::Register {
                installation_id: uuid::Uuid::new_v4().to_string(),
                token: "invalid token".into(),
            }
            .validate()
            .is_err()
        );
        assert!(
            NotificationRequest::Status {
                installation_id: "unknown".into()
            }
            .validate()
            .is_err()
        );
    }

    #[test]
    fn credential_config_is_private_and_never_a_nix_store_secret() {
        let mut config = ApnsConfig {
            team_id: "TEAM000001".into(),
            key_id: "KEY0000001".into(),
            topic: "dev.example.Agent".into(),
            key_file: "/private/example/AuthKey.p8".into(),
            environment: ApnsEnvironment::Production,
        };
        config.validate().unwrap();
        config.key_file = "/nix/store/example-credential.p8".into();
        assert!(config.validate().is_err());
    }

    #[test]
    fn native_registration_is_a_control_request_with_a_typed_receipt() {
        let operation = crate::native::prepare(crate::native::NativeRequest::Notifications {
            request: NotificationRequest::Status {
                installation_id: uuid::Uuid::new_v4().to_string(),
            },
        })
        .unwrap();
        assert!(
            matches!(operation, crate::native::Operation::Runtime(command)
            if matches!(*command, crate::protocol::RuntimeCommand::Notifications { .. }))
        );
        let event = crate::native::project(&crate::protocol::RuntimeEventKind::Notifications {
            status: NotificationStatus {
                configured: true,
                registered: false,
            },
        });
        assert!(
            matches!(event, Some(crate::native::NativeEvent::Notifications { status })
            if status.configured && !status.registered)
        );
        assert!(
            crate::native::prepare(crate::native::NativeRequest::Notifications {
                request: NotificationRequest::Status {
                    installation_id: "invalid".into()
                },
            })
            .is_err()
        );
    }
}
