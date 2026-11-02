import { assertSupportedNode } from './node-runtime.mjs';

assertSupportedNode();
console.log(`Node.js ${process.versions.node}: supported security release.`);
