# Release acceptance checklist

Promotion from `dev` to `main`, installation acceptance, and publication are separate decisions. Do not merge or publish based only on a green test run. Record the full source SHA, independent review, three platform CI jobs, artifact SHA-256, and the owner's exact approval before promoting a candidate.

## Supported installation

Follow the root README from a retained checkout at the approved commit. Linux with `/proc`, Node 24 or newer, and the documented Codex 0.161.0 compatibility baseline are required for the stateful path. Check actual runner help first. Windows and macOS CI cover pure operations and refusal; they do not establish stateful support.

A source archive must retain `package-lock.json` to reproduce `npm ci`. Extract it outside `node_modules`, keep the directory at its installed path, and use the README's `npm ci`, `npm link`, and runtime-specific setup commands. An npm package tarball is a separate inspection artifact; do not assume it includes the lockfile or provides a supported `npm install <tarball>` path. The CLI runs TypeScript source from its retained checkout.

In a disposable project and isolated state root, exercise install, enable, status, disable and uninstall. Preserve unrelated configuration and session evidence. Scratch-home tests with stand-in runners verify setup behavior only. They do not prove persistent native loading or delivery.

## Owner-present acceptance

1. Record the approved source SHA, artifact hash, host, Node and Codex versions. Keep the checkout and Node executable in place.
2. Install only the authorized plugin, review hook trust, and enable only the disposable project. Record status and its exact delivery mode.
3. With harmless sentinels, verify complete digest-bound read-back in the later native request, then test the documented agent reset and compaction boundaries separately. Preserve the current human request and native permissions.
4. Disable and uninstall; verify configuration restoration and retained session data. Do not delete data or intent markers to force recovery.

The handoff reports native request acceptance on 2026-10-15. That historical result is not acceptance of every later source head. Current-head installed loading, request delivery and bounded long-session behavior require their own evidence. Do not perform a live trial while the owner is absent.

## Limitations and open decisions

- [Codex #4](https://github.com/Jeff-Kazzee/context-engine-codex/issues/4): killed or refused completions can leave durable refusal. See the README for the distinct tool and Stop cases and the disable workaround. Re-enabling is not established as recovery.
- Stateful Windows and macOS backends are unsupported.
- Active same-user substitution of core-owned private paths, writes after the final validation sample, end-to-end numeric exhaustion, and real power-loss durability remain outside demonstrated guarantees.
- Keep existing core hardening follow-ups and their evidence; a completed source fix does not close the owner's acceptance issue automatically. The owner closes core #26.
- Owner approval is still required for the limitation wording, dev-to-main promotion, and any later publication. This checklist grants none of those approvals.
