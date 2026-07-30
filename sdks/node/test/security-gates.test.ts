/**
 * AC-SEC-SDK3-1 (`outputs/THREATMODEL-envpit-0t2z-3.md` F1, main repo): every type that
 * transitively holds the API key or the config snapshot MUST implement an explicit redacting
 * text representation — Go `String()`/`GoString()`, Python `__repr__`/`__str__`, Java
 * `toString()` already gate this (`sdks/go/envpit/security_gates_test.go`,
 * `sdks/python/tests/test_repr_redaction.py`, `sdks/java/.../ToStringRedactionTest.java`).
 * Node parity-gap register item 1: shipped Node did NOT redact — `util.inspect`/`console.log`
 * prints every own property (`apiKey` AND the full `snapshot` value map) with zero developer
 * effort, and `JSON.stringify(client)` does the same. This suite closes that gap.
 *
 * Adversarial per the threat model's own framing (mirrors the Java test's rationale):
 * the injected API key and config value below are deliberately distinctive, high-entropy
 * strings unlikely to appear by accident in any other rendered field (host, class name, key
 * count), so a false "pass" from a coincidental substring match is not possible.
 */
import { inspect } from 'node:util';
import { describe, expect, it } from 'vitest';
import { EnvpitClient } from '../src/client.js';
import { RealtimeTransport } from '../src/realtime-transport.js';
import { fakeFetch, jsonResponse } from './test-utils.js';

const ADVERSARIAL_API_KEY = 'epk_REDACT_ME_9f3e7c1a2b6d';
const ADVERSARIAL_SECRET_VALUE = 'SEKRIT_CONFIG_VALUE_4b8f21';

describe('AC-SEC-SDK3-1 — EnvpitClient redacted representation', () => {
  it('util.inspect() (console.log\'s own renderer) never contains the raw API key or a config value, and says <redacted>', async () => {
    const client = await EnvpitClient.load({
      apiKey: ADVERSARIAL_API_KEY,
      pollIntervalMs: 0,
      fetchImpl: fakeFetch([() => jsonResponse({ DATABASE_URL: ADVERSARIAL_SECRET_VALUE, PORT: '8080' })]),
    });
    try {
      const rendered = inspect(client);
      expect(rendered).not.toContain(ADVERSARIAL_API_KEY);
      expect(rendered).not.toContain(ADVERSARIAL_SECRET_VALUE);
      expect(rendered).toContain('<redacted>');
    } finally {
      client.stop();
    }
  });

  it('JSON.stringify() never contains the raw API key or a config value', async () => {
    const client = await EnvpitClient.load({
      apiKey: ADVERSARIAL_API_KEY,
      pollIntervalMs: 0,
      fetchImpl: fakeFetch([() => jsonResponse({ DATABASE_URL: ADVERSARIAL_SECRET_VALUE })]),
    });
    try {
      const serialized = JSON.stringify(client);
      expect(serialized).not.toContain(ADVERSARIAL_API_KEY);
      expect(serialized).not.toContain(ADVERSARIAL_SECRET_VALUE);
      expect(serialized).toContain('redacted');
    } finally {
      client.stop();
    }
  });

  it('String(client) / template-literal interpolation never contains the raw API key or a config value', async () => {
    const client = await EnvpitClient.load({
      apiKey: ADVERSARIAL_API_KEY,
      pollIntervalMs: 0,
      fetchImpl: fakeFetch([() => jsonResponse({ DATABASE_URL: ADVERSARIAL_SECRET_VALUE })]),
    });
    try {
      const viaString = String(client);
      const viaTemplate = `${client}`;
      for (const rendered of [viaString, viaTemplate]) {
        expect(rendered).not.toContain(ADVERSARIAL_API_KEY);
        expect(rendered).not.toContain(ADVERSARIAL_SECRET_VALUE);
        expect(rendered).toContain('<redacted>');
      }
    } finally {
      client.stop();
    }
  });

  it('still reports the (safe) key COUNT — redaction must not swallow useful debug info', async () => {
    const client = await EnvpitClient.load({
      apiKey: ADVERSARIAL_API_KEY,
      pollIntervalMs: 0,
      fetchImpl: fakeFetch([() => jsonResponse({ A: '1', B: '2', C: '3' })]),
    });
    try {
      expect(inspect(client)).toContain('keys=3');
    } finally {
      client.stop();
    }
  });
});

describe('AC-SEC-SDK3-1 — RealtimeTransport redacted representation', () => {
  function buildTransport(apiKey: string): RealtimeTransport {
    return new RealtimeTransport({
      host: 'https://example.test',
      apiKey,
      fetchImpl: fakeFetch([]),
      pollIntervalMs: 60_000,
      callbacks: {
        onChangeSignal: () => undefined,
        onModeChange: () => undefined,
        onRealtimeConnected: () => undefined,
        onLog: () => undefined,
      },
    });
  }

  it('util.inspect() never contains the raw API key', () => {
    const transport = buildTransport(ADVERSARIAL_API_KEY);
    const rendered = inspect(transport);
    expect(rendered).not.toContain(ADVERSARIAL_API_KEY);
    expect(rendered).toContain('<redacted>');
  });

  it('JSON.stringify() never contains the raw API key', () => {
    const transport = buildTransport(ADVERSARIAL_API_KEY);
    const serialized = JSON.stringify(transport);
    expect(serialized).not.toContain(ADVERSARIAL_API_KEY);
  });

  it('String(transport) never contains the raw API key', () => {
    const transport = buildTransport(ADVERSARIAL_API_KEY);
    expect(String(transport)).not.toContain(ADVERSARIAL_API_KEY);
    expect(`${transport}`).not.toContain(ADVERSARIAL_API_KEY);
  });
});
