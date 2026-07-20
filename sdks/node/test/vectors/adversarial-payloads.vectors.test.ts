/**
 * Backfill (bd:envpit-0t2z.3, Slice-0 follow-up — 2 missing families flagged during the Python
 * dispatch): consumes `test-vectors/adversarial-payloads.json` — malformed/oversized/deeply-
 * nested JSON+SSE vectors per Sentinel's AC-SEC-SDK3-2 (`outputs/THREATMODEL-envpit-0t2z-3.md`
 * F2). Two cases (oversized body, oversized SSE line) are PRE-EXISTING, ALREADY-DOCUMENTED Node
 * parity gaps (Sentinel's own threat model + the vector file's own `notes`) — this file documents
 * them as GAP-canary tests (CONFORMANCE.md's established GAP-documented convention), asserting
 * today's real, verified behavior, NOT a hard pass/fail against a cap Node doesn't implement.
 * Fixing Node's caps is explicitly OUT of this bd's scope (tracked separately, bd:envpit-aw7l).
 */
import { describe, expect, it } from 'vitest';
import { NetworkError } from '../../src/errors.js';
import { SseFrameParser } from '../../src/sse-parser.js';
import { fetchConfig } from '../../src/transport.js';
import { loadVectors } from '../vector-loader.js';

const TEST_HOST = 'https://example.test';

interface AdversarialCase {
  name: string;
  kind: 'body-size-cap' | 'sse-line-size-cap' | 'json-depth-bomb' | 'malformed-json';
  recommendedCapBytes?: number;
  payloadBytes?: number;
  payloadRecipe?: string;
  lineBytes?: number;
  lineRecipe?: string;
  event?: string;
  data?: string;
  expectedFrame?: { event: string; data: string };
  depth?: number;
  pattern?: string;
  input?: string;
  expectedSafety: string;
  expectedErrorClass?: 'NetworkError';
  expectedMessageSubstring?: string;
}
interface AdversarialVectors {
  cases: AdversarialCase[];
}

const vectors = loadVectors<AdversarialVectors>('adversarial-payloads.json');
const byName = (name: string): AdversarialCase => {
  const c = vectors.cases.find((c) => c.name === name);
  if (!c) throw new Error(`adversarial-payloads.json: no case named "${name}"`);
  return c;
};

/** `payloadRecipe: "json-object-single-key-K-padded-string"` — build `{"K": "vvv...v"}` whose
 *  UTF-8 byte length equals `targetBytes` exactly (matches the recipe's own documented shape,
 *  same construction `sdks/python/tests/test_json_caps.py` already used as its stopgap). */
function buildPaddedJsonBody(targetBytes: number): string {
  const skeleton = JSON.stringify({ K: '' });
  const padLength = targetBytes - Buffer.byteLength(skeleton, 'utf8');
  return JSON.stringify({ K: 'v'.repeat(padLength) });
}

/** `lineRecipe: "sse-config-changed-data-padded-no-terminator"` — a single unterminated chunk
 *  (no trailing `\n`) whose UTF-8 byte length equals `targetBytes`. */
function buildUnterminatedSseLine(targetBytes: number): string {
  const prefix = 'event: config-changed\ndata: ';
  const padLength = targetBytes - Buffer.byteLength(prefix, 'utf8');
  return prefix + 'x'.repeat(padLength);
}

describe('Adversarial JSON/body/SSE vectors — test-vectors/adversarial-payloads.json', () => {
  describe('body-size-cap', () => {
    it('GAP (documented, bd:envpit-aw7l): Node has no body-size cap today — an oversized body is accepted, not rejected', async () => {
      const c = byName('oversized-response-body-exceeds-cap');
      const body = buildPaddedJsonBody(c.payloadBytes!);
      const fetchImpl = (async () =>
        new Response(body, { status: 200, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch;

      // This is the CANARY assertion — it documents Node's real, current, gap-having behavior
      // (accepts an oversized body) rather than asserting the eventual capped behavior (which
      // would fail against Node's real src today, per this bd's explicit stop condition). The
      // day Node adopts AC-SEC-SDK3-2(a)'s cap, THIS assertion must flip to `.rejects.toThrow`.
      const result = await fetchConfig({ host: TEST_HOST, apiKey: 'epk_test', fetchImpl, timeoutMs: 5000 });
      expect(result.snapshot['K']).toHaveLength(c.payloadBytes! - Buffer.byteLength(JSON.stringify({ K: '' }), 'utf8'));
    });

    it('response body at the recommended cap boundary is accepted (true for Node today regardless of the gap)', async () => {
      const c = byName('response-body-at-cap-boundary-is-accepted');
      const body = buildPaddedJsonBody(c.payloadBytes!);
      const fetchImpl = (async () =>
        new Response(body, { status: 200, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch;

      const result = await fetchConfig({ host: TEST_HOST, apiKey: 'epk_test', fetchImpl, timeoutMs: 5000 });
      expect(result.snapshot['K']).toBeDefined();
    });
  });

  describe('sse-line-size-cap', () => {
    it('GAP (documented, bd:envpit-aw7l): Node has no SSE line-size cap today — an oversized unterminated line does not throw', () => {
      const c = byName('oversized-sse-line-without-terminator-is-capped');
      const huge = buildUnterminatedSseLine(c.lineBytes!);
      const parser = new SseFrameParser();

      // CANARY: documents that Node's parser silently buffers rather than rejecting. No throw,
      // no frame yielded (nothing terminated the line yet) — matches real, verified behavior.
      const frames = parser.push(huge);
      expect(frames).toEqual([]);
    });

    it('SSE line under the cap parses normally', () => {
      const c = byName('sse-line-under-the-cap-parses-normally');
      const parser = new SseFrameParser();
      const frames = parser.push(`event: ${c.event}\ndata: ${c.data}\n\n`);
      expect(frames).toEqual([c.expectedFrame]);
    });
  });

  describe('json-depth-bomb', () => {
    it('deeply-nested array (200,000 levels) is memory-safe: Node parses it cleanly, no crash/hang', async () => {
      const c = byName('json-depth-bomb-nested-arrays-is-memory-safe');
      const depthBomb = '['.repeat(c.depth!) + ']'.repeat(c.depth!);
      const fetchImpl = (async () =>
        new Response(depthBomb, { status: 200, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch;

      // Not a hard requirement to REJECT (see file description: "no-crash-no-hang-no-oom" is
      // satisfied either way) — Node's V8 JSON.parse handles this depth cleanly (verified),
      // so this positive assertion is Node's own real, current, safe behavior.
      const result = await fetchConfig({ host: TEST_HOST, apiKey: 'epk_test', fetchImpl, timeoutMs: 5000 });
      expect(Array.isArray(result.snapshot)).toBe(true);
    });
  });

  describe('malformed-json', () => {
    for (const name of [
      'unterminated-string-value-is-rejected-safely',
      'invalid-unicode-escape-is-rejected-safely',
      'trailing-garbage-after-valid-json-is-rejected',
    ]) {
      it(name, async () => {
        const c = byName(name);
        const fetchImpl = (async () =>
          new Response(c.input!, { status: 200, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch;

        await expect(fetchConfig({ host: TEST_HOST, apiKey: 'epk_test', fetchImpl, timeoutMs: 5000 })).rejects.toThrow(
          NetworkError,
        );
      });
    }
  });
});
