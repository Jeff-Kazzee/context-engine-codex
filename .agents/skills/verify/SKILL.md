---
name: verify
description: Verify Context Engine changes at an exact commit, including platform-specific evidence and the current CI result.
---

Read AGENTS.md and the current CI workflow. Record the exact tested commit and
actual runtime. Use setup/check-node.mjs before ordinary test/typecheck execution.
Run the maintained test and typecheck commands through the repository's approved
CI bootstrap. Keep its dependency audits, native checkout and runtime guards.

For shared core changes, verify SOURCE.json hashes in both distributions and
confirm their shared files are identical to the reviewed source commit.

For Windows native changes, read docs/platforms/windows-native-20261102.md.
Build the addon with existing supported tools, run all native/windows acceptance
scripts in disposable fixtures, and retain compiler/runtime/source identities.
Linux CI does not replace those native checks. Native core tests do not establish
plugin loading, next-request delivery, ordinary-profile or package acceptance.
Keep installer/hook holds until their specific lifecycle and preservation checks
pass. State unavailable checks explicitly, including capture and exact-head CI.

Keep real profiles, credentials and session history out of fixtures. A successful
verification does not authorize merge, release, deployment or a paid model trial.
