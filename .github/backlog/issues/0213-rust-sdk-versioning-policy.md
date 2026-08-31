---
title: "docs(rust-sdk): a versioning policy tied to the contract's VERSION constant"
labels: [rust-sdk, docs, good-first-issue]
epic: E13
wave: 3
depends_on: [0198]
---

## Summary

The contract exposes a VERSION constant (currently 3) specifically so off-chain clients can detect which ABI they are talking to, per its own doc comment. The Rust SDK needs a stated policy for how its own crate version relates to that constant, mirroring whatever policy issue 0192 established for the TypeScript SDK, so the two SDKs do not silently diverge on the same question.

## Expected behaviour

A short document stating: does a contract VERSION bump require a Rust SDK major version bump, minor, or neither; what the crate does if it detects a contract VERSION it was not built against (refuse to connect, warn, proceed); and how a consumer pins a Rust SDK version to a known-compatible contract VERSION.

## Suggested approach

Read issue 0192's resolution first rather than deciding this independently. The two SDKs should follow the same policy unless there is a concrete reason specific to Rust (there may not be); stating "this Rust SDK follows the same compatibility policy as the TypeScript SDK, see issue 0192" is an acceptable and preferable answer to inventing a second policy.

## Acceptance criteria

- [ ] The policy explicitly addresses what happens when the crate is used against a contract reporting an unexpected VERSION.
- [ ] Consistency with the TypeScript SDK's policy (issue 0192) is either confirmed or a difference is justified.
- [ ] The client exposes a way to read the connected contract's VERSION so a caller can implement their own check even without relying on the crate's internal one.

## Files

- rust-sdk/VERSIONING.md
