---
title: "fix(rust-sdk): attach the failing method and arguments to every decoded error"
labels: [rust-sdk, enhancement, good-first-issue]
epic: E13
wave: 3
depends_on: [0200]
---

## Summary

Issue 0200 maps the contract's KeeperError variants onto typed Rust errors. As implemented there, an error by itself does not say which call produced it or with what arguments, which makes debugging a failing integration harder than it needs to be once an application is calling several registry methods from the same code path.

## Expected behaviour

Every error the client returns carries the method name and a debug representation of its arguments alongside the decoded KeeperError, so a caller's own error log is self-explanatory without needing to also log the call site separately.

## Suggested approach

This is a small, additive change to the error type from issue 0200, not a redesign. Confirm it does not leak a signing key or other secret into the debug representation — arguments like a Keypair should be redacted, not printed in full, matching the same secret-hygiene concern the keeper-bot's config validation already applies (its requireEnv helper's secret flag).

## Acceptance criteria

- [ ] Every client method's error includes its own name and non-secret arguments.
- [ ] No secret key, seed, or signature ever appears in an error's debug output.
- [ ] A test asserts the redaction specifically, by triggering an error from a method that takes a signing key and confirming the key's bytes do not appear anywhere in the formatted error.

## Files

- rust-sdk/src/error.rs
