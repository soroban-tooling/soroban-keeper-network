//! Event coverage for distributions and recipient configuration changes.

use soroban_sdk::testutils::{Address as _, Events as _};
use soroban_sdk::{symbol_short, Address, Env, Symbol, TryIntoVal, Val, Vec};

use super::common::*;
use crate::{Recipient, TreasuryError};

/// The treasury's events from the most recent invocation, as
/// `(verb, noun, data)`.
fn treasury_events(s: &TestSetup) -> Vec<(Symbol, Symbol, Val)> {
    let mut out = Vec::new(&s.env);
    for (contract, topics, data) in s.env.events().all().iter() {
        if contract != s.treasury.address {
            continue;
        }
        let verb: Symbol = topics.get(0).unwrap().try_into_val(&s.env).unwrap();
        let noun: Symbol = topics.get(1).unwrap().try_into_val(&s.env).unwrap();
        out.push_back((verb, noun, data));
    }
    out
}

fn decode<T: soroban_sdk::TryFromVal<Env, Val>>(env: &Env, data: Val) -> T {
    T::try_from_val(env, &data).unwrap_or_else(|_| panic!("event data has an unexpected shape"))
}

// ─────────────────────────────────────────────────────────────────────────────
// Distribution
// ─────────────────────────────────────────────────────────────────────────────

#[test]
fn test_distribute_emits_total_with_per_recipient_breakdown() {
    let s = setup();
    let r1 = Address::generate(&s.env);
    let r2 = Address::generate(&s.env);
    s.treasury.add_recipient(&s.admin, &r1, &3_000u32);
    s.treasury.add_recipient(&s.admin, &r2, &7_000u32);

    s.treasury.distribute(&s.admin, &1_000_000i128);

    let events = treasury_events(&s);
    // One ("dist", "recip") per credited recipient, then the summary last.
    assert_eq!(events.len(), 3);
    let (verb, noun, data) = events.last().unwrap();
    assert_eq!(
        (verb, noun),
        (symbol_short!("dist"), symbol_short!("total"))
    );

    let (caller, requested, credited, breakdown): (Address, i128, i128, Vec<(Address, i128)>) =
        decode(&s.env, data);
    assert_eq!(caller, s.admin);
    assert_eq!(requested, 1_000_000i128);
    assert_eq!(credited, 1_000_000i128);
    assert_eq!(breakdown.len(), 2);
    assert_eq!(breakdown.get(0).unwrap(), (r1.clone(), 300_000i128));
    assert_eq!(breakdown.get(1).unwrap(), (r2.clone(), 700_000i128));

    // The breakdown agrees with the per-recipient events that precede it.
    for i in 0..2u32 {
        let (verb, noun, data) = events.get(i).unwrap();
        assert_eq!(
            (verb, noun),
            (symbol_short!("dist"), symbol_short!("recip"))
        );
        let (recipient, amount, _running_total): (Address, i128, i128) = decode(&s.env, data);
        assert_eq!(breakdown.get(i).unwrap(), (recipient, amount));
    }
}

#[test]
fn test_distribute_breakdown_includes_zero_rounded_recipient() {
    let s = setup();
    let small = Address::generate(&s.env);
    let large = Address::generate(&s.env);
    s.treasury.add_recipient(&s.admin, &small, &1u32);
    s.treasury.add_recipient(&s.admin, &large, &9_999u32);

    // 10 * 1 / 10_000 floors to 0; 10 * 9_999 / 10_000 floors to 9.
    s.treasury.distribute(&s.admin, &10i128);

    let events = treasury_events(&s);
    let (_verb, _noun, data) = events.last().unwrap();
    let (_caller, requested, credited, breakdown): (Address, i128, i128, Vec<(Address, i128)>) =
        decode(&s.env, data);
    assert_eq!(requested, 10i128);
    assert_eq!(credited, 9i128);
    assert_eq!(breakdown.get(0).unwrap(), (small, 0i128));
    assert_eq!(breakdown.get(1).unwrap(), (large, 9i128));
    let summed: i128 = breakdown.iter().map(|(_, amount)| amount).sum();
    assert_eq!(summed, credited);
}

#[test]
fn test_rejected_distribute_emits_no_summary() {
    let s = setup();
    let _ = s.treasury.try_distribute(&s.admin, &1_000i128); // no recipients
    assert_eq!(treasury_events(&s).len(), 0);
}

// ─────────────────────────────────────────────────────────────────────────────
// Configuration changes
// ─────────────────────────────────────────────────────────────────────────────

#[test]
fn test_each_configuration_change_emits_one_event() {
    let s = setup();
    let r = Address::generate(&s.env);

    s.treasury.add_recipient(&s.admin, &r, &1_000u32);
    let events = treasury_events(&s);
    assert_eq!(events.len(), 1);
    let (verb, noun, data) = events.get(0).unwrap();
    assert_eq!(
        (verb, noun),
        (symbol_short!("radd"), symbol_short!("recip"))
    );
    assert_eq!(
        decode::<(Address, u32)>(&s.env, data),
        (r.clone(), 1_000u32)
    );

    s.treasury.update_recipient_shares(&s.admin, &r, &2_500u32);
    let events = treasury_events(&s);
    assert_eq!(events.len(), 1);
    let (verb, noun, data) = events.get(0).unwrap();
    assert_eq!(
        (verb, noun),
        (symbol_short!("rshr"), symbol_short!("recip"))
    );
    assert_eq!(
        decode::<(Address, u32, u32)>(&s.env, data),
        (r.clone(), 1_000u32, 2_500u32)
    );

    s.treasury.remove_recipient(&s.admin, &r);
    let events = treasury_events(&s);
    assert_eq!(events.len(), 1);
    let (verb, noun, data) = events.get(0).unwrap();
    assert_eq!((verb, noun), (symbol_short!("rrm"), symbol_short!("recip")));
    assert_eq!(decode::<(Address,)>(&s.env, data), (r,));
}

#[test]
fn test_rejected_configuration_change_emits_nothing() {
    let s = setup();
    let r = Address::generate(&s.env);
    s.treasury.add_recipient(&s.admin, &r, &1_000u32);

    assert_eq!(
        s.treasury.try_update_recipient_shares(&s.admin, &r, &0u32),
        Err(Ok(TreasuryError::InvalidShares))
    );
    assert_eq!(treasury_events(&s).len(), 0);
}

/// Folds one configuration event into a model of the recipient list.
fn apply_config_event(env: &Env, model: &mut Vec<Recipient>, event: (Symbol, Symbol, Val)) {
    let (verb, _noun, data) = event;
    if verb == symbol_short!("radd") {
        let (address, shares_bps): (Address, u32) = decode(env, data);
        model.push_back(Recipient {
            address,
            shares_bps,
        });
    } else if verb == symbol_short!("rshr") {
        let (address, old, new): (Address, u32, u32) = decode(env, data);
        let idx = model.iter().position(|r| r.address == address).unwrap() as u32;
        assert_eq!(
            model.get(idx).unwrap().shares_bps,
            old,
            "old share must match history"
        );
        model.set(
            idx,
            Recipient {
                address,
                shares_bps: new,
            },
        );
    } else if verb == symbol_short!("rrm") {
        let (address,): (Address,) = decode(env, data);
        let idx = model.iter().position(|r| r.address == address).unwrap() as u32;
        model.remove(idx);
    }
}

#[test]
fn test_configuration_history_is_reconstructable_from_events() {
    let s = setup();
    let a = Address::generate(&s.env);
    let b = Address::generate(&s.env);
    let c = Address::generate(&s.env);
    let mut model: Vec<Recipient> = Vec::new(&s.env);

    let mut step = |f: &dyn Fn()| {
        f();
        for event in treasury_events(&s).iter() {
            apply_config_event(&s.env, &mut model, event);
        }
        assert_eq!(
            model,
            s.treasury.recipients(),
            "event replay diverged from state"
        );
    };

    step(&|| s.treasury.add_recipient(&s.admin, &a, &2_000u32));
    step(&|| s.treasury.add_recipient(&s.admin, &b, &3_000u32));
    step(&|| s.treasury.update_recipient_shares(&s.admin, &a, &4_000u32));
    step(&|| s.treasury.add_recipient(&s.admin, &c, &1_000u32));
    step(&|| s.treasury.remove_recipient(&s.admin, &a));
    step(&|| s.treasury.distribute(&s.admin, &1_000i128));
    step(&|| s.treasury.add_recipient(&s.admin, &a, &500u32));
    step(&|| s.treasury.update_recipient_shares(&s.admin, &c, &10_000u32));
    step(&|| s.treasury.remove_recipient(&s.admin, &b));
}
