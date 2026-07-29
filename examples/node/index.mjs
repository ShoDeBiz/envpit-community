// Node example — resolves config from a real EnvPit server through the PUBLISHED @envpit/sdk.
//
// Why this exists: every SDK test in this repo mocks the transport. That proves the client
// behaves as designed; it does not prove the design matches the server. Those can diverge —
// they did, when the resolve body changed from a bare map to { values, secretKeys }. This file
// is the smallest thing that would have caught it: a real dependency from a real registry
// making a real HTTP call.
//
//   ENVPIT_API_KEY=... node index.mjs
import { EnvpitClient } from '@envpit/sdk';

const host = process.env.ENVPIT_HOST ?? 'https://envpit.com';
const client = await EnvpitClient.load({ apiKey: process.env.ENVPIT_API_KEY, host });

// Key NAMES only, never values: an EnvPit API key resolves secrets in plaintext, and this
// output lands in terminals, CI logs and screenshots.
const secretKeys = client.secretKeys();
console.log('secret-flagged keys:', secretKeys.length ? secretKeys.join(', ') : '(none)');

// The whole point: ordinary config reaches process.env, secret-flagged config does not.
// mergeIntoProcessEnv() is also the only way to enumerate what was resolved — the client
// exposes no snapshot()/keys() accessor (see envpit-community issue on that gap).
const before = new Set(Object.keys(process.env));
const merged = client.mergeIntoProcessEnv();

console.log('merged into process.env:', merged.merged.join(', ') || '(none)');
console.log('withheld (secret)      :', merged.skippedSecrets.join(', ') || '(none)');
console.log('skipped (already set)  :', merged.skippedExisting.join(', ') || '(none)');

// A secret with NO value in this environment is absent, not withheld — the null check runs
// before the secret check, so it never reaches skippedSecrets. Report it separately, because
// "secret-flagged: X" followed by "withheld: (none)" otherwise reads like the filter failed.
const unsetSecrets = secretKeys.filter((k) => client.getOptional(k) === undefined);
if (unsetSecrets.length) {
  console.log('secret, but unset here :', unsetSecrets.join(', '));
  console.log('  \u2192 nothing to withhold for these; set a value to exercise the filter for real');
}

// Existing code keeps working untouched — that is the feature. Read one merged key the plain way.
const [sample] = merged.merged;
if (sample) console.log(`\nprocess.env.${sample} is now readable by code that never heard of EnvPit`);

// Assert, rather than trust the report: a summary object can be wrong, the environment cannot.
const leaked = secretKeys.filter((k) => !before.has(k) && process.env[k] !== undefined);
if (leaked.length) {
  console.error(`\nFAIL: secret-flagged keys reached process.env: ${leaked.join(', ')}`);
  process.exit(1);
}
console.log('OK — no secret-flagged key is present in process.env');
await client.close();
