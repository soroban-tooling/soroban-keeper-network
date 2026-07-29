---
title: "chore(ci): split a fast per-PR smoke fuzz pass from the deeper nightly run explicitly"
labels: [tooling, testing, intermediate]
epic: E03
wave: 2
depends_on: [0066]
---

## Summary

Issue 0066 already scopes a short per-PR fuzz run and a longer nightly one by wall-clock budget. Once epic E03's full target list exists (roughly a dozen targets by the end of this wave), running even a short budget per target on every PR could add up to a noticeable CI wait. This issue is a check-in on whether that budgeting still holds once the real target count is known, and whether a subset (only targets touching files the PR actually changed) is worth selecting instead of running everything every time.

## Expected behaviour

Once all of this wave's fuzz targets exist, measure actual per-PR fuzz job wall-clock time. If it has grown uncomfortably long, change the PR-triggered job to run only fuzz targets whose corresponding source file changed in the diff (a path-filter check against the PR's changed files), falling back to running everything for changes to widely-shared files like lib.rs itself.

## Acceptance criteria

- [ ] Actual measured PR-fuzz-job time is reported, not assumed.
- [ ] If a path-filter optimization is implemented, it correctly still runs all targets for a change to a shared file, and is tested to confirm it does not accidentally skip a relevant target.
- [ ] If the existing budget is still fine, no change is made and that's an acceptable, documented outcome.

## Files

- .github/workflows/ci.yml
