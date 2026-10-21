# Release acceptance checklist

Promotion from `dev` to `main`, installation acceptance, and publication are separate decisions. Do not merge or publish based only on a green test run. Record the full source SHA, independent review, three platform CI jobs, artifact SHA-256, and the owner's exact approval before promoting a candidate.

## Supported installation

Follow the root README from a retained checkout at the approved commit. Linux with `/proc`, stable Node 24.22.1+ in 24.x or 26.12.1+ in 26.x, and the documented Codex 0.161.0 compatibility baseline are required for the stateful path. Check actual runner help first. Windows and macOS CI cover pure operations and refusal; they do not establish stateful support.

A source archive must retain `package-lock.json` to reproduce `npm ci`. Extract it outside `node_modules`, keep the directory at its installed path, and use the README's chained `node setup/check-node.mjs && npm ci && npm link` command before runtime-specific setup commands. The explicit runtime guard must pass before either package command starts; a root `preinstall` hook alone does not gate npm's dependency writes. An npm package tarball is a separate inspection artifact; do not assume it includes the lockfile or provides a supported `npm install <tarball>` path. The CLI runs TypeScript source from its retained checkout.

In a disposable project and isolated state root, exercise install, enable, status, disable and uninstall. Preserve unrelated configuration and session evidence. Scratch-home tests with stand-in runners verify setup behavior only. They do not prove persistent native loading or delivery.

## Owner-present acceptance

1. Record the approved source SHA, the SHA-256 of the exact source archive extracted for installation (label any npm inspection tarball hash separately), host, Node and Codex versions. Keep the checkout and Node executable in place.
2. Install only the authorized plugin, review hook trust, and enable only the disposable project. Record status and its exact delivery mode.
3. With harmless sentinels, verify complete digest-bound read-back in the later native request, then test the documented agent reset and compaction boundaries separately. Preserve the current human request and native permissions.
4. Disable and uninstall; verify configuration restoration and retained session data. Do not delete data or intent markers to force recovery.

One scripted interactive TUI session on 2026-10-15, on an earlier source version, reached a functional pass with installed hooks. Its live request proof was unverified, and its request-boundary check passed only in a later offline re-evaluation. That historical result is not acceptance of any later source head. Current-head installed loading, request delivery and bounded long-session behavior require their own evidence. Do not perform a live trial while the owner is absent.

## Limitations and open decisions

- [Codex #4](https://github.com/Jeff-Kazzee/context-engine-codex/issues/4): killed or refused completions can leave durable refusal. See the README for the distinct tool and Stop cases and the disable workaround. Re-enabling is not established as recovery.
- CDX-002: when participation becomes unverifiable while project guidance stays installed, the hook stands aside. It records no turns and does not gate `new_context`, so turns from that period are missing from the Event Log and cannot be recovered into it. The owner chose on 2026-10-18 to keep this behavior for the release and document it in the README. `adapters/codex/hook-processes.test.ts` asserts it.
- Stateful Windows and macOS backends are unsupported.
- Active same-user substitution of core-owned private paths, writes after the final validation sample, end-to-end numeric exhaustion, and real power-loss durability remain outside demonstrated guarantees.
- Keep existing core hardening follow-ups and their evidence; a completed source fix does not close the owner's acceptance issue automatically. The owner closes core #26.
- The owner approved releasing with the Codex #4 and CDX-002 limitations documented on 2026-10-18. The owner authorized dev-to-main promotion and publication for this release on 2026-10-18, conditional on this checklist's requirements passing. Any later release needs its own approval.

## Security gate for source publication

Before approving a release, require all three CI jobs to pass at the exact candidate SHA, including the actual Node runtime guard and both dependency audit steps. Node must be a supported stable security release. Audits include development tools and the temporary native-test package, fail on every reported advisory severity, and fail when the registry cannot be checked. Preserve independent review, artifact hashes and owner approval. Do not publish a candidate whose required guard or audit failed.

These distributions ship source, not Node, PHP, a container or a served application. The runtime guard covers CI, package commands and setup installation. The pinned core/session and adapter entry points remain unchanged, so operators must select a supported Node executable for them. Registry audits do not establish the vulnerability status of native test binaries or hosted action runtimes.

This repository has no automated publisher. CI failure blocks subsequent steps in the maintained job, but repository files cannot prevent an authorized account from manually creating a GitHub release or bypassing repository rules. Verify required checks and bypass policy separately before source publication. No publication is authorized by a passing check. Verified 2026-10-21.
