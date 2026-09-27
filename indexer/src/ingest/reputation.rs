
use tokio_postgres::Client;
use crate::event::{Event, EventPayload};
use crate::numeric::i128_to_sql;
use crate::IndexerError;

pub async fn ingest_event(client: &Client, event: &Event) -> Result<(), IndexerError> {
    let c = &event.cursor;
    if let EventPayload::ReputationUpdated { keeper, action, score } = &event.payload {
        client
            .execute(
                "INSERT INTO reputation_events
                   (ledger, tx_index, event_index, keeper, action, score)
                 VALUES (, , , , , ::text::numeric)
                 ON CONFLICT (ledger, tx_index, event_index) DO NOTHING",
                &[
                    &(c.ledger as i64),
                    &(c.tx_index as i64),
                    &(c.event_index as i64),
                    keeper,
                    action,
                    &i128_to_sql(*score),
                ],
            )
            .await?;
    }
    Ok(())
}
