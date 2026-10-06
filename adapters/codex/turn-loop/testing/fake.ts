// Test support: where the scripted fake `codex app-server` lives.
import { fileURLToPath } from 'node:url';

export const FAKE_APP_SERVER = fileURLToPath(new URL('./fake-app-server.ts', import.meta.url));
