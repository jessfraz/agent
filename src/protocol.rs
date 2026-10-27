use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

pub const PROTOCOL_VERSION: u32 = 1;

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema, TS)]
pub struct AccountIdentity {
    pub issuer: String,
    pub subject: String,
    pub email: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema, TS)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum AuthStatus {
    SignedOut,
    Connected {
        account: AccountIdentity,
        #[ts(type = "number")]
        expires_at: u64,
    },
    NeedsSignIn {
        account: Option<AccountIdentity>,
    },
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema, TS)]
pub struct RuntimeRequest {
    pub version: u32,
    pub id: u32,
    pub command: RuntimeCommand,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema, TS)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum RuntimeCommand {
    Login,
    Status,
    Logout,
    Chat {
        input: String,
        instructions: String,
        model: String,
    },
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema, TS)]
pub struct RuntimeEvent {
    pub version: u32,
    pub id: u32,
    pub event: RuntimeEventKind,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema, TS)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum RuntimeEventKind {
    AuthorizationUrl {
        url: String,
    },
    AuthStatus {
        status: AuthStatus,
    },
    Answer {
        conversation_id: String,
        text: String,
    },
    Failure {
        code: ErrorCode,
        message: String,
    },
    Done,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema, TS)]
#[serde(rename_all = "snake_case")]
pub enum ErrorCode {
    InvalidRequest,
    AuthenticationRequired,
    AuthenticationFailed,
    ProviderUnavailable,
    StorageUnavailable,
    Internal,
}
