//! Polling event stream for the Keeper Registry contract.

use crate::events::{decode_event, EventDecodeError, KeeperEvent};
use crate::retry::{default_classify, RetryPolicy, RpcCallError};
use soroban_sdk::xdr::ScVal;
use soroban_sdk::Env;
use std::collections::VecDeque;
use std::future::Future;
use std::sync::Arc;
use std::time::Duration;

/// Where the first `getEvents` request begins.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EventStart {
    /// Begin with events at or after this ledger sequence.
    Ledger(u32),
    /// Resume immediately after a cursor saved by a previous stream.
    Cursor(String),
}

/// Parameters for one registry-scoped `getEvents` page request.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EventPageRequest {
    /// Registry contract id used by the RPC contract filter.
    pub contract_id: String,
    /// Starting ledger, present only until the first page is requested.
    pub start_ledger: Option<u32>,
    /// Cursor returned by RPC or attached to the last delivered event.
    pub cursor: Option<String>,
    /// Maximum number of events requested in one page.
    pub limit: u32,
}

/// One raw RPC event and the cursor that follows it.
#[derive(Debug, Clone, PartialEq)]
pub struct RawContractEvent {
    /// Cursor used to resume after this exact event.
    pub cursor: String,
    /// Contract event topics as XDR values.
    pub topics: Vec<ScVal>,
    /// Contract event payload as an XDR value.
    pub value: ScVal,
}

/// A page returned by `getEvents`.
#[derive(Debug, Clone, PartialEq)]
pub struct EventPage {
    /// Events in ascending ledger and paging-token order.
    pub events: Vec<RawContractEvent>,
    /// Cursor for the next request, including when the page is empty.
    pub cursor: String,
}

/// RPC boundary required by [`RegistryEventStream`].
pub trait EventTransport: Send + Sync {
    /// Fetch one page of registry events.
    fn get_events(
        &self,
        request: EventPageRequest,
    ) -> impl Future<Output = Result<EventPage, RpcCallError<()>>> + Send;

    /// Sleep after an empty page or between transient-failure retries.
    fn sleep(&self, duration: Duration) -> impl Future<Output = ()> + Send {
        async move { std::thread::sleep(duration) }
    }
}

/// A decoded event together with its durable resume cursor.
#[derive(Debug, Clone, PartialEq)]
pub struct StreamEvent {
    /// Cursor that resumes after this event.
    pub cursor: String,
    /// Typed registry event.
    pub event: KeeperEvent,
}

/// Failure yielded by [`RegistryEventStream::next`].
#[derive(Debug, thiserror::Error)]
pub enum EventStreamError {
    /// The RPC page request failed after the configured retry attempts.
    #[error("getEvents failed: {0:?}")]
    Rpc(RpcCallError<()>),
    /// RPC returned an event whose topics or payload could not be decoded.
    #[error("event at cursor {cursor} could not be decoded: {source}")]
    Decode {
        /// Cursor of the event that failed to decode.
        cursor: String,
        /// Typed decoding failure.
        #[source]
        source: EventDecodeError,
    },
}

/// Runtime-agnostic polling stream over Soroban RPC `getEvents`.
///
/// Call [`Self::next`] repeatedly. Persist [`Self::current_cursor`] after
/// processing an item and pass it to [`EventStart::Cursor`] after a restart.
pub struct RegistryEventStream<T: EventTransport> {
    transport: Arc<T>,
    env: Env,
    contract_id: String,
    start_ledger: Option<u32>,
    request_cursor: Option<String>,
    current_cursor: Option<String>,
    buffered: VecDeque<RawContractEvent>,
    retry: RetryPolicy,
    page_limit: u32,
    poll_interval: Duration,
}

impl<T: EventTransport + 'static> RegistryEventStream<T> {
    /// Create a stream beginning at a ledger or saved cursor.
    pub fn new(transport: T, contract_id: impl Into<String>, start: EventStart) -> Self {
        let (start_ledger, cursor) = match start {
            EventStart::Ledger(ledger) => (Some(ledger), None),
            EventStart::Cursor(cursor) => (None, Some(cursor)),
        };
        Self {
            transport: Arc::new(transport),
            env: Env::default(),
            contract_id: contract_id.into(),
            start_ledger,
            request_cursor: cursor.clone(),
            current_cursor: cursor,
            buffered: VecDeque::new(),
            retry: RetryPolicy::default(),
            page_limit: 100,
            poll_interval: Duration::from_secs(2),
        }
    }

    /// Override the retry policy used for transient `getEvents` failures.
    pub fn with_retry_policy(mut self, retry: RetryPolicy) -> Self {
        self.retry = retry;
        self
    }

    /// Override the maximum events requested per RPC page.
    pub fn with_page_limit(mut self, page_limit: u32) -> Self {
        self.page_limit = page_limit.max(1);
        self
    }

    /// Override the delay before polling again after an empty page.
    pub fn with_poll_interval(mut self, poll_interval: Duration) -> Self {
        self.poll_interval = poll_interval;
        self
    }

    /// Cursor after the most recently yielded event or observed empty page.
    pub fn current_cursor(&self) -> Option<&str> {
        self.current_cursor.as_deref()
    }

    /// Wait for and decode the next registry event.
    ///
    /// An undecodable event is returned as an error item and still advances
    /// the cursor, allowing the consumer to record the failure and continue.
    pub async fn next(&mut self) -> Result<StreamEvent, EventStreamError> {
        loop {
            if let Some(raw) = self.buffered.pop_front() {
                self.current_cursor = Some(raw.cursor.clone());
                return decode_event(&self.env, &raw.topics, &raw.value)
                    .map(|event| StreamEvent {
                        cursor: raw.cursor.clone(),
                        event,
                    })
                    .map_err(|source| EventStreamError::Decode {
                        cursor: raw.cursor,
                        source,
                    });
            }

            let request = EventPageRequest {
                contract_id: self.contract_id.clone(),
                start_ledger: self.start_ledger,
                cursor: self.request_cursor.clone(),
                limit: self.page_limit,
            };
            let operation_transport = Arc::clone(&self.transport);
            let sleep_transport = Arc::clone(&self.transport);
            let page = self
                .retry
                .run(
                    move || {
                        let transport = Arc::clone(&operation_transport);
                        let request = request.clone();
                        Box::pin(async move { transport.get_events(request).await })
                    },
                    default_classify,
                    move |duration| {
                        let transport = Arc::clone(&sleep_transport);
                        async move { transport.sleep(duration).await }
                    },
                )
                .await
                .map_err(EventStreamError::Rpc)?;

            self.start_ledger = None;
            self.request_cursor = Some(page.cursor.clone());
            if page.events.is_empty() {
                self.current_cursor = Some(page.cursor);
                self.transport.sleep(self.poll_interval).await;
            } else {
                self.buffered.extend(page.events);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::events::{KeeperEvent, TaskExpiredEvent};
    use crate::retry::TransportError;
    use soroban_sdk::{IntoVal, Symbol, TryIntoVal, Val};
    use std::sync::Mutex;

    struct FakeTransport {
        responses: Mutex<VecDeque<Result<EventPage, RpcCallError<()>>>>,
        requests: Mutex<Vec<EventPageRequest>>,
    }

    impl FakeTransport {
        fn new(responses: Vec<Result<EventPage, RpcCallError<()>>>) -> Self {
            Self {
                responses: Mutex::new(responses.into()),
                requests: Mutex::new(Vec::new()),
            }
        }
    }

    impl EventTransport for FakeTransport {
        async fn get_events(
            &self,
            request: EventPageRequest,
        ) -> Result<EventPage, RpcCallError<()>> {
            self.requests.lock().unwrap().push(request);
            self.responses
                .lock()
                .unwrap()
                .pop_front()
                .expect("fake response")
        }

        async fn sleep(&self, _: Duration) {}
    }

    fn xdr<T>(env: &Env, value: T) -> ScVal
    where
        T: IntoVal<Env, Val>,
    {
        let value: Val = value.into_val(env);
        value.try_into_val(env).unwrap()
    }

    fn expired(env: &Env, cursor: &str, task_id: u64) -> RawContractEvent {
        RawContractEvent {
            cursor: cursor.to_string(),
            topics: vec![
                xdr(env, Symbol::new(env, "exp")),
                xdr(env, Symbol::new(env, "task")),
            ],
            value: xdr(env, (task_id,)),
        }
    }

    #[tokio::test]
    async fn pages_retries_and_polls_across_an_empty_page() {
        let env = Env::default();
        let transport = FakeTransport::new(vec![
            Err(RpcCallError::Transport(TransportError::Timeout)),
            Ok(EventPage {
                events: vec![expired(&env, "1-0", 7)],
                cursor: "1-0".into(),
            }),
            Ok(EventPage {
                events: vec![],
                cursor: "2-0".into(),
            }),
            Ok(EventPage {
                events: vec![expired(&env, "3-0", 8)],
                cursor: "3-0".into(),
            }),
        ]);
        let mut stream = RegistryEventStream::new(transport, "CAAAAA", EventStart::Ledger(50))
            .with_retry_policy(RetryPolicy {
                max_attempts: 2,
                ..RetryPolicy::no_retry()
            })
            .with_poll_interval(Duration::ZERO);

        assert_eq!(
            stream.next().await.unwrap().event,
            KeeperEvent::TaskExpired(TaskExpiredEvent { task_id: 7 })
        );
        assert_eq!(stream.current_cursor(), Some("1-0"));
        assert_eq!(
            stream.next().await.unwrap().event,
            KeeperEvent::TaskExpired(TaskExpiredEvent { task_id: 8 })
        );
        assert_eq!(stream.current_cursor(), Some("3-0"));

        let requests = stream.transport.requests.lock().unwrap();
        assert_eq!(requests.len(), 4);
        assert_eq!(requests[0].start_ledger, Some(50));
        assert_eq!(requests[1].start_ledger, Some(50));
        assert_eq!(requests[2].cursor.as_deref(), Some("1-0"));
        assert_eq!(requests[3].cursor.as_deref(), Some("2-0"));
    }

    #[tokio::test]
    async fn malformed_event_is_an_error_item_and_advances_cursor() {
        let env = Env::default();
        let bad = RawContractEvent {
            cursor: "9-0".into(),
            topics: vec![xdr(&env, Symbol::new(&env, "exp"))],
            value: xdr(&env, (9_u64,)),
        };
        let transport = FakeTransport::new(vec![Ok(EventPage {
            events: vec![bad],
            cursor: "9-0".into(),
        })]);
        let mut stream =
            RegistryEventStream::new(transport, "CAAAAA", EventStart::Cursor("8-0".into()));

        assert!(matches!(
            stream.next().await,
            Err(EventStreamError::Decode { ref cursor, .. }) if cursor == "9-0"
        ));
        assert_eq!(stream.current_cursor(), Some("9-0"));
    }
}
