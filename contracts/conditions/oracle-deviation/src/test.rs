use keeper_oracle_client::{
    mock::{MockReflector, MockReflectorClient},
    Asset,
};
use soroban_sdk::{testutils::Ledger, Address, Env, Symbol};

use crate::{DeviationError, OracleDeviationCondition, OracleDeviationConditionClient};

const NOW: u64 = 10_000;
const ONE_HUNDRED: i128 = 1_000_000_000;

struct Setup {
    env: Env,
    feed_id: Address,
    condition_id: Address,
    asset: Asset,
}

impl Setup {
    fn feed(&self) -> MockReflectorClient<'_> {
        MockReflectorClient::new(&self.env, &self.feed_id)
    }

    fn condition(&self) -> OracleDeviationConditionClient<'_> {
        OracleDeviationConditionClient::new(&self.env, &self.condition_id)
    }
}

fn setup(basis_points: u32) -> Setup {
    let env = Env::default();
    env.ledger().with_mut(|ledger| ledger.timestamp = NOW);
    let asset = Asset::Other(Symbol::new(&env, "BTC"));

    let feed_id = env.register(MockReflector, ());
    let feed = MockReflectorClient::new(&env, &feed_id);
    feed.set_decimals(&7);
    feed.set_price(&asset, &ONE_HUNDRED, &NOW);

    let condition_id = env.register(OracleDeviationCondition, ());
    let condition = OracleDeviationConditionClient::new(&env, &condition_id);
    condition.initialize(&feed_id, &asset, &600, &basis_points);

    Setup {
        env,
        feed_id,
        condition_id,
        asset,
    }
}

#[test]
fn captures_reference_once_and_rejects_reinitialization() {
    let s = setup(100);
    let reference = s.condition().config().reference_price;
    s.feed().set_price(&s.asset, &(ONE_HUNDRED * 2), &NOW);

    assert_eq!(s.condition().config().reference_price, reference);
    assert_eq!(
        s.condition()
            .try_initialize(&s.feed_id, &s.asset, &600, &100),
        Err(Ok(DeviationError::AlreadyInitialized))
    );
    assert_eq!(s.condition().config().reference_price, reference);
}

#[test]
fn zero_basis_points_is_met_at_the_reference() {
    let s = setup(0);
    assert!(s.condition().is_met(&1));
}

#[test]
fn one_basis_point_has_an_exact_boundary_in_both_directions() {
    let s = setup(1);

    s.feed().set_price(&s.asset, &1_000_099_999, &NOW);
    assert!(!s.condition().is_met(&1));
    s.feed().set_price(&s.asset, &1_000_100_000, &NOW);
    assert!(s.condition().is_met(&1));

    s.feed().set_price(&s.asset, &999_900_001, &NOW);
    assert!(!s.condition().is_met(&1));
    s.feed().set_price(&s.asset, &999_900_000, &NOW);
    assert!(s.condition().is_met(&1));
}

#[test]
fn ten_thousand_basis_points_requires_a_full_upward_move() {
    let s = setup(10_000);
    s.feed().set_price(&s.asset, &(ONE_HUNDRED * 2 - 1), &NOW);
    assert!(!s.condition().is_met(&1));
    s.feed().set_price(&s.asset, &(ONE_HUNDRED * 2), &NOW);
    assert!(s.condition().is_met(&1));
}

#[test]
fn invalid_or_unavailable_prices_fail_closed() {
    let s = setup(1);
    s.feed().clear_price(&s.asset);
    assert!(!s.condition().is_met(&1));

    s.feed().set_price(&s.asset, &ONE_HUNDRED, &(NOW + 1));
    assert!(!s.condition().is_met(&1));

    s.feed().set_price(&s.asset, &ONE_HUNDRED, &(NOW - 601));
    assert!(!s.condition().is_met(&1));
}

#[test]
fn rejects_out_of_range_parameters() {
    let env = Env::default();
    env.ledger().with_mut(|ledger| ledger.timestamp = NOW);
    let asset = Asset::Other(Symbol::new(&env, "BTC"));
    let feed_id = env.register(MockReflector, ());
    let feed = MockReflectorClient::new(&env, &feed_id);
    feed.set_price(&asset, &ONE_HUNDRED, &NOW);

    let id = env.register(OracleDeviationCondition, ());
    let condition = OracleDeviationConditionClient::new(&env, &id);
    assert_eq!(
        condition.try_initialize(&feed_id, &asset, &600, &10_001),
        Err(Ok(DeviationError::InvalidBasisPoints))
    );
    assert_eq!(
        condition.try_initialize(&feed_id, &asset, &0, &1),
        Err(Ok(DeviationError::InvalidMaxAge))
    );
}
