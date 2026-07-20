#!/usr/bin/env node
// POC: a "dummy" app that pulls its configuration from EnvPit via the Node SDK.
//
// This is the client half of the end-to-end proof the owner asked for:
//   "create a project on EnvPit, put a config value in it, then have a local app
//    fetch that value through the SDK — proving the whole platform works live."
//
// It imports the SAME published SDK surface a real consumer uses (`EnvpitClient`),
// loads config once, and prints a value. No mocks — it makes a real HTTP call to
// whatever host you point ENVPIT_HOST at (default: production, https://envpit.com).
//
// ── How to run ────────────────────────────────────────────────────────────────
//   1. On EnvPit (prod https://envpit.com, or local http://localhost:8080):
//        - create a project + an environment (e.g. "dev")
//        - add a config variable, e.g. key GREETING = "Hello from EnvPit"
//        - create an API key scoped to that project/environment; copy the raw key
//   2. Run:
//        ENVPIT_API_KEY=<raw key> node index.mjs
//      (against local dev, also pass:  ENVPIT_HOST=http://localhost:8080 )
//      (to read a different key:        ENVPIT_KEY=SOME_OTHER_KEY )
//
// Exit code 0 = value fetched and printed; non-zero = it explains what went wrong.

// Import the built SDK directly so this runs with zero `npm install`. A real consumer
// would instead: `import { EnvpitClient } from '@envpit/sdk';`
import { EnvpitClient, EnvpitError } from '../../sdks/node/dist/index.js';

const apiKey = process.env.ENVPIT_API_KEY;
const host = process.env.ENVPIT_HOST; // undefined ⇒ SDK default (https://envpit.com)
const keyName = process.env.ENVPIT_KEY || 'GREETING';

if (!apiKey) {
  console.error('✗ Set ENVPIT_API_KEY to a real EnvPit API key first. See the header of this file.');
  process.exit(2);
}

const target = host || 'https://envpit.com (SDK default)';
console.log(`→ Loading config from EnvPit @ ${target} …`);

try {
  // load() = one authenticated fetch of the whole resolved config for this key's scope,
  // then every get() is a synchronous in-memory read (polling refresh runs in the background).
  const envpit = await EnvpitClient.load(host ? { apiKey, host } : { apiKey });

  const value = envpit.get(keyName);
  console.log('');
  console.log('  ┌─────────────────────────────────────────────');
  console.log(`  │  ${keyName} = ${JSON.stringify(value)}`);
  console.log('  └─────────────────────────────────────────────');
  console.log('');
  console.log('✓ Config fetched live through the EnvPit SDK. End-to-end proof complete.');

  // clean shutdown (stops the background poll/realtime connection)
  envpit.close();
  process.exit(0);
} catch (err) {
  if (err instanceof EnvpitError) {
    console.error(`✗ EnvPit SDK error [${err.constructor.name}]: ${err.message}`);
  } else {
    console.error('✗ Unexpected error:', err);
  }
  process.exit(1);
}
