import { writeSync } from 'node:fs';
import { openSession } from '../../core/index.ts';
import { processStartMarker } from '../../core/platform.ts';
import { setCrashPointHook } from '../../core/faults.ts';
const [mode, projectRoot, stateDir, sessionId] = process.argv.slice(2);
if (!mode || !projectRoot || !stateDir || !sessionId) throw new Error('missing owned-child arguments');
const opened = openSession({ projectRoot, stateDir, sessionId, runner: 'owned-windows-child', hardLimit: 100000 });
if (opened.status !== 'open') throw new Error('owned child session refused');
const session = opened.session;
if (mode === 'hold') {
  writeSync(1, JSON.stringify({ ready: 'holding', pid: process.pid, startMarker: processStartMarker(process.pid) }) + '\n');
  setInterval(() => {}, 1000);
} else if (mode === 'after-log') {
  const seed = session.record([{ role: 'user', text: 'Seed before abrupt process interruption.' }]);
  session.confirmReceiptReturn();
  setCrashPointHook(point => {
    if (point !== 'after-log') return;
    writeSync(1, JSON.stringify({ ready: 'after-log', revision: seed.revision }) + '\n');
    process.kill(process.pid, 'SIGKILL');
    throw new Error('self-kill unexpectedly returned');
  });
  session.record([{ role: 'user', text: 'Durable after-log sentinel.' }], { operationId: '42cf10c5-3af3-456b-a7ed-97725f24abae' });
  throw new Error('after-log hook did not terminate owned child');
} else throw new Error('unknown owned-child mode');
