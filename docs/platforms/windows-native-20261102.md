# Windows core development milestone

The released v0.1.6 plugins remain Linux-only. This branch implements a native
Windows x64 core backend for local NTFS. Installer and live-hook entry points
remain explicitly held. macOS implementation follows working Windows integration.

The backend owns Windows HANDLEs behind opaque unsigned IDs outside Node's
signed 32-bit descriptor range. Direct Node file APIs therefore refuse those IDs.
Every child traversal uses an opened parent and rejects reparse points, device
names, alternate streams and ambiguous trailing characters. Canonical project
paths remain case-sensitive identities. Only credential-policy names are folded.

Creation supplies a protected DACL for the current SID, SYSTEM and local
administrators. Those privileged OS principals already control this user process.
Permission tightening requires verified ownership and a full identity match.
Persistent identities retain the complete volume and 128-bit file IDs.

Rename uses anchored FileRenameInformationEx with replace and POSIX semantics,
preserving existing open data handles. Hard-link creation refuses collisions.
Flush reopens by the separately queried NTFS 64-bit index using OpenFileById,
then verifies the complete volume/128-bit identity before flushing file metadata
and directory structure. No pathname or no-op durability fallback is used.

## Native verification

The measured host was Windows build 10.0.26300.9818 on NTFS, Node 24.22.1 x64,
MSVC 19.50.35725 and Windows SDK 10.0.26100.0. The addon uses Node-API version 8.
Cached 24.19.0 headers and import stubs supplied build declarations only. The
24.19.0 runtime was never executed. The loader checks the existing fixed Node
policy before loading the addon. Node 26 policy acceptance is not a native test.

Build native/windows/build-native.cmd with the existing Node-API header directory
and x64 node.lib as its two arguments. No package manager or tool installation is
part of this script. Run these scripts with the fixed Node and an existing owned
disposable path ending in windows-native-20261102\fixtures:

- native/windows/primitives.test.mjs
- native/windows/host-platform.test.ts
- native/windows/core-acceptance.ts
- native/windows/process-acceptance.ts

They create new synthetic fixtures and retain them for inspection. The process
suite kills only its owned child, including an abrupt exit after the durable
Event Log append and before operation indexing/HEAD. It checks live-owner refusal,
confirmed-exit takeover and idempotent replay. This is not a power-loss test.

The tool filesystem shim refused native rename/link operations. The measured
native checks ran outside that shim under the ordinary user, without elevation,
new access or global configuration changes. ReOpenFile/empty-name experiments
are not production mechanisms.

## Remaining product gates

Native setup still needs shell/runner discovery, ledger path handling, trusted
plugin-local backend loading, hook process ancestry and interruption recovery.
The release archive must then pass native install, enable, status, task, kill,
recover, persist, disable and uninstall checks with byte-preserved unrelated data.
Windows CI, full exact-head checks, independent review and required Entire capture
remain separate gates. Issue 4 live-hook recovery and ordinary-profile delivery
are not fixed or proved by these core tests. No release or product launch is
part of this branch.

## Primary API references

- https://nodejs.org/api/n-api.html
- https://learn.microsoft.com/en-us/windows/win32/api/winternl/nf-winternl-ntcreatefile
- https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-openfilebyid
- https://learn.microsoft.com/en-us/windows-hardware/drivers/ddi/ntifs/ns-ntifs-_file_rename_information
- https://learn.microsoft.com/en-us/windows-hardware/drivers/ddi/ntifs/nf-ntifs-ntflushbuffersfileex
- https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-fsa/0de7dc40-9627-437e-a4df-c4696cdc3d02
