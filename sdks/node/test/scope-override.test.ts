/**
 * `EnvpitClient`-level tests for bd:envpit-ed3h Part 2 (explicit project/environment scope
 * override) — path selection is already covered wire-level in `test/transport.test.ts`; this
 * file proves `EnvpitClient.load({ project, environment })` actually wires the override through,
 * that the default (key-scope-inferred) path is unchanged when omitted, and that malformed
 * overrides fail fast with a clear validation error (same "throw a plain Error synchronously"
 * precedent the constructor already uses for a missing apiKey — this is an options-shape bug,
 * not a runtime EnvpitError condition).
 */
import { describe, expect, it } from 'vitest';
import { EnvpitClient } from '../src/client.js';
import { jsonResponse } from './test-utils.js';

const PROJECT_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const ENV_ID = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

function urlCapturingFetch(): { fetchImpl: typeof fetch; seenUrl: () => string | undefined } {
  let seenUrl: string | undefined;
  const fetchImpl = (async (url: unknown) => {
    seenUrl = String(url);
    return jsonResponse({ K: 'v' });
  }) as unknown as typeof fetch;
  return { fetchImpl, seenUrl: () => seenUrl };
}

describe('EnvpitClient.load({ project, environment }) — explicit scope override (bd:envpit-ed3h Part 2)', () => {
  it('with a valid override: hits GET /api/v1/projects/:project/environments/:environment/config', async () => {
    const cap = urlCapturingFetch();
    const client = await EnvpitClient.load({
      apiKey: 'epk_test',
      pollIntervalMs: 0,
      project: PROJECT_ID,
      environment: ENV_ID,
      fetchImpl: cap.fetchImpl,
    });
    expect(cap.seenUrl()).toBe(`https://envpit.com/api/v1/projects/${PROJECT_ID}/environments/${ENV_ID}/config`);
    client.close();
  });

  it('without an override: the key-scope-inferred alias path is unchanged', async () => {
    const cap = urlCapturingFetch();
    const client = await EnvpitClient.load({ apiKey: 'epk_test', pollIntervalMs: 0, fetchImpl: cap.fetchImpl });
    expect(cap.seenUrl()).toBe('https://envpit.com/api/v1/config');
    client.close();
  });

  it('rejects when only `project` is given (environment omitted)', async () => {
    await expect(
      EnvpitClient.load({ apiKey: 'epk_test', pollIntervalMs: 0, project: PROJECT_ID, fetchImpl: urlCapturingFetch().fetchImpl }),
    ).rejects.toThrow(/project.*environment.*must both be provided/i);
  });

  it('rejects when only `environment` is given (project omitted)', async () => {
    await expect(
      EnvpitClient.load({ apiKey: 'epk_test', pollIntervalMs: 0, environment: ENV_ID, fetchImpl: urlCapturingFetch().fetchImpl }),
    ).rejects.toThrow(/project.*environment.*must both be provided/i);
  });

  it('rejects a malformed (non-UUID) project id', async () => {
    await expect(
      EnvpitClient.load({
        apiKey: 'epk_test',
        pollIntervalMs: 0,
        project: 'not-a-uuid',
        environment: ENV_ID,
        fetchImpl: urlCapturingFetch().fetchImpl,
      }),
    ).rejects.toThrow(/must be UUID/i);
  });

  it('rejects an empty-string environment id', async () => {
    await expect(
      EnvpitClient.load({
        apiKey: 'epk_test',
        pollIntervalMs: 0,
        project: PROJECT_ID,
        environment: '   ',
        fetchImpl: urlCapturingFetch().fetchImpl,
      }),
    ).rejects.toThrow(/non-empty/i);
  });

  it('never attempts a fetch when the override is invalid (fails before any network call)', async () => {
    let called = false;
    const fetchImpl = (async () => {
      called = true;
      return jsonResponse({ K: 'v' });
    }) as unknown as typeof fetch;

    await expect(EnvpitClient.load({ apiKey: 'epk_test', pollIntervalMs: 0, project: 'x', fetchImpl })).rejects.toThrow();
    expect(called).toBe(false);
  });
});
