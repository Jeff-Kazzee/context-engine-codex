# Context Engine codex
Read README.md, adapters/codex/README.md, GLOSSARY.md, PROVENANCE.md and SOURCE.json before changes. Core files are a pinned vendor snapshot: update both distributions from one reviewed source commit and refresh hashes together. Never copy/read credentials, use a proxy, or change another runner's config. Default off; verify exact delivery mode. Regular PRs require tests, independent review and exact-head owner approval before merge. No costly model runs without explicit authorization.

Changes target `dev`. Promotion from `dev` to `main` requires separate approval after the applicable acceptance gates. Every changed PR head needs its own CI result and independent review. A development merge does not authorize deployment or package publication.
