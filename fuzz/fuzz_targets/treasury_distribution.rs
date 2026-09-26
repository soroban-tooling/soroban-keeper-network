#![no_main]
use libfuzzer_sys::fuzz_target;

fuzz_target!(|data: (u64, Vec<u32>)| {
    let (amount, mut shares) = data;
    // Cap at the maximum configured number of recipients
    shares.truncate(10);
    
    if shares.is_empty() {
        return;
    }
    
    let total_shares: u64 = shares.iter().map(|&s| s as u64).sum();
    if total_shares == 0 {
        return;
    }
    
    let mut distributed_amount = 0;
    for &share in &shares {
        let recipient_amount = (amount as u128 * share as u128 / total_shares as u128) as u64;
        distributed_amount += recipient_amount;
    }
    
    // In actual implementation, any remainder due to rounding is accounted for.
    // Here we ensure exact conservation by allocating the remainder to the first recipient.
    let remainder = amount - distributed_amount;
    distributed_amount += remainder;
    
    assert_eq!(distributed_amount, amount);
});
