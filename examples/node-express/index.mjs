// Express example — resolves config from a real EnvPit server through the PUBLISHED
// @envpit/sdk, merges it into process.env BEFORE the Express app is built, and then never
// touches @envpit/sdk again. That ordering is the entire selling point of the native merge:
// route handlers, middleware, whatever — anything reading `process.env.X` the ordinary way
// just works, with zero EnvPit-specific code in the app itself.
//
// Why this exists: every SDK test in this repo mocks the transport. That proves the client
// behaves as designed; it does not prove the design matches the server. Those diverged once
// already (resolve body changed from a bare map to `{ values, secretKeys }`). A framework
// example making a real HTTP call through a real registry dependency is the smallest thing
// that catches that class of bug. See ../node/index.mjs for the fuller story and the plain
// (no-framework) version of this same proof.
//
//   ENVPIT_API_KEY=... node index.mjs
import { EnvpitClient } from '@envpit/sdk';
import express from 'express';

const host = process.env.ENVPIT_HOST ?? 'https://envpit.com';

// --- Step 1: resolve + merge BEFORE building the app. -----------------------------------
const client = await EnvpitClient.load({ apiKey: process.env.ENVPIT_API_KEY, host });

// Key NAMES only, never values: an EnvPit API key resolves secrets in plaintext, and this
// output lands in terminals, CI logs and screenshots.
const secretKeys = client.secretKeys();
const before = new Set(Object.keys(process.env));

// mergeIntoProcessEnv() is also the only way to enumerate what was resolved — EnvpitClient
// exposes no snapshot()/keys() accessor.
const merged = client.mergeIntoProcessEnv();

console.log('[envpit] secret-flagged keys :', secretKeys.length ? secretKeys.join(', ') : '(none)');
console.log('[envpit] merged into env     :', merged.merged.join(', ') || '(none)');
console.log('[envpit] withheld (secret)   :', merged.skippedSecrets.join(', ') || '(none)');
console.log('[envpit] skipped (existing)  :', merged.skippedExisting.join(', ') || '(none)');

// A secret with NO value in this environment is "absent", not "withheld" — the SDK's null
// check runs before its secret check, so an unset secret never reaches skippedSecrets. Call
// that out explicitly so "withheld: (none)" doesn't read like the filter is broken.
const unsetSecrets = secretKeys.filter((k) => client.getOptional(k) === undefined);
if (unsetSecrets.length) {
  console.log(
    '[envpit] secret, but unset here:',
    unsetSecrets.join(', '),
    '(nothing to withhold for these — set a value to exercise the filter for real)',
  );
}

// --- Step 2: assert against the real environment, not the summary object. ---------------
// A returned object can be wrong; process.env cannot. This is the guarantee this example
// exists to prove, and it must hold whether a key was withheld-as-secret or simply unset.
const leaked = secretKeys.filter((k) => process.env[k] !== undefined && !before.has(k));
if (leaked.length) {
  console.error(`[envpit] FAIL: secret-flagged keys reached process.env: ${leaked.join(', ')}`);
  process.exit(1);
}
console.log('[envpit] OK — no secret-flagged key is present in process.env\n');

// --- Step 3: build the app. Nothing below has ever heard of @envpit/sdk. ----------------
const app = express();
const port = process.env.PORT ?? 3000;

app.get('/', (req, res) => {
  // Ordinary code reading ordinary process.env — this IS the integration, not a special API.
  const sampleKey = merged.merged[0];
  res.json({
    mergedKeys: merged.merged,
    sampleRead: sampleKey
      ? { key: sampleKey, presentInProcessEnv: process.env[sampleKey] !== undefined }
      : null,
    secretFlaggedKeys: secretKeys,
    // Asserted live against process.env on every request, not cached from boot — must
    // always be an empty array.
    secretKeysLeakedIntoProcessEnv: secretKeys.filter((k) => process.env[k] !== undefined),
  });
});

app.get('/healthz', (_req, res) => res.json({ ok: true }));

const server = app.listen(port, () => {
  console.log(`[envpit-express] listening on http://localhost:${port}`);
});

// Don't leave the SDK's background poll/SSE connection open after the server stops.
const shutdown = async () => {
  server.close();
  await client.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
