//! Admission belongs to its conversation, independently of the selected view.

use agent_cli::protocol::{InputMode, RuntimeEventKind};
use anyhow::Result;
use std::sync::Mutex;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Stage {
    Waiting,
    Sending,
    Accepted,
    Placed,
    Rejected,
    Canceled,
}
pub(crate) struct Admission {
    pub(crate) id: String,
    pub(crate) conversation_id: String,
    pub(crate) text: String,
    pub(crate) mode: InputMode,
    stage: Mutex<Stage>,
}
impl Admission {
    pub(crate) fn new(conversation_id: String, text: String, mode: InputMode) -> Self {
        Self {
            id: uuid::Uuid::new_v4().to_string(),
            conversation_id,
            text,
            mode,
            stage: Mutex::new(Stage::Waiting),
        }
    }
    pub(crate) fn stage(&self) -> Result<Stage> {
        Ok(*self
            .stage
            .lock()
            .map_err(|_| anyhow::anyhow!("Input admission state is unavailable"))?)
    }
    /// Claim the write before any bytes leave. A canceled waiting input can
    /// never wake later and execute after navigation or Esc.
    pub(crate) fn sending(&self) -> Result<bool> {
        let mut stage = self
            .stage
            .lock()
            .map_err(|_| anyhow::anyhow!("Input admission state is unavailable"))?;
        if *stage != Stage::Waiting {
            return Ok(false);
        }
        *stage = Stage::Sending;
        Ok(true)
    }
    pub(crate) fn cancel_waiting(&self) -> Result<bool> {
        let mut stage = self
            .stage
            .lock()
            .map_err(|_| anyhow::anyhow!("Input admission state is unavailable"))?;
        if *stage != Stage::Waiting {
            return Ok(false);
        }
        *stage = Stage::Canceled;
        Ok(true)
    }
    pub(crate) fn observe(&self, event: &RuntimeEventKind) -> Result<()> {
        let next = match event {
            RuntimeEventKind::InputAccepted { input_id } if input_id == &self.id => {
                Some(Stage::Accepted)
            }
            RuntimeEventKind::InputPlaced { input_id, .. } if input_id == &self.id => {
                Some(Stage::Placed)
            }
            RuntimeEventKind::InputRejected { input_id, .. } if input_id == &self.id => {
                Some(Stage::Rejected)
            }
            _ => None,
        };
        if let Some(next) = next {
            let mut stage = self
                .stage
                .lock()
                .map_err(|_| anyhow::anyhow!("Input admission state is unavailable"))?;
            if !matches!(*stage, Stage::Placed | Stage::Canceled | Stage::Rejected) {
                *stage = next;
            }
        }
        Ok(())
    }
    pub(crate) fn retained(&self) -> Result<bool> {
        Ok(matches!(
            self.stage()?,
            Stage::Waiting | Stage::Sending | Stage::Accepted
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn navigation_cancellation_and_a_concurrent_write_cannot_both_claim_the_input() {
        let input = std::sync::Arc::new(Admission::new(
            "saved".into(),
            "context".into(),
            InputMode::Steer,
        ));
        let gate = std::sync::Arc::new(std::sync::Barrier::new(3));
        let write = {
            let input = input.clone();
            let gate = gate.clone();
            std::thread::spawn(move || {
                gate.wait();
                input.sending().unwrap()
            })
        };
        let cancel = {
            let input = input.clone();
            let gate = gate.clone();
            std::thread::spawn(move || {
                gate.wait();
                input.cancel_waiting().unwrap()
            })
        };
        gate.wait();
        assert_ne!(write.join().unwrap(), cancel.join().unwrap());
        assert!(matches!(
            input.stage().unwrap(),
            Stage::Sending | Stage::Canceled
        ));
    }
    #[test]
    fn cancellation_and_write_admission_have_one_owner_and_receipts_never_restore_placed_input() {
        let waiting = Admission::new("first".into(), "context".into(), InputMode::Steer);
        assert!(waiting.cancel_waiting().unwrap());
        assert!(!waiting.sending().unwrap());
        let sending = Admission::new("second".into(), "correction".into(), InputMode::FollowUp);
        assert!(sending.sending().unwrap());
        assert!(!sending.cancel_waiting().unwrap());
        sending
            .observe(&RuntimeEventKind::InputPlaced {
                input_id: sending.id.clone(),
                entry_id: "native".into(),
            })
            .unwrap();
        sending
            .observe(&RuntimeEventKind::InputAccepted {
                input_id: sending.id.clone(),
            })
            .unwrap();
        assert_eq!(sending.stage().unwrap(), Stage::Placed);
        assert!(!sending.retained().unwrap());
    }
}
