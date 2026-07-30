/**
 * Property-based tests for `SseFrameParser` (bd:envpit-jf7i) — exercised directly, since it's
 * the one pure function among the three this bd targets that IS exported (`src/sse-parser.ts`).
 * `test/vectors/sse-frames.vectors.test.ts` already proves a fixed set of examples byte-for-byte
 * across all four SDK languages; this file generalizes the ONE property those examples only
 * spot-check ("chunk boundaries never change what gets parsed") to arbitrary well-formed inputs
 * and arbitrary chunk splits, plus a pure robustness property (never throws) against
 * unstructured garbage.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { SseFrameParser, type SseFrame } from '../../src/sse-parser.js';

/** A single field value safe to embed as a raw SSE line without changing meaning on round-trip:
 *  no `\r`/`\n` (would split into another line) and no leading space (the parser strips exactly
 *  one leading space after the field's `: ` — round-tripping a value that already starts with a
 *  space is a real, correct behavior, but it would make the "what did we ask for" vs. "what do
 *  we expect back" bookkeeping below more complex than this test needs). */
const fieldValue = fc.string().filter((s) => !/[\r\n]/.test(s) && !s.startsWith(' '));

/** One logical frame BEFORE serialization to the wire — `event: undefined` means "no `event:`
 *  line at all", which the parser defaults to `'message'`. At least one of `event`/`dataLines`
 *  must be present or the frame is just a stray blank line and dispatches nothing
 *  (`SseFrameParser.dispatch`'s `sawAnyField` guard) — filtered out below so every generated
 *  frame maps to exactly one expected `SseFrame`. */
const frameSpec = fc
  .record({
    event: fc.option(fieldValue.filter((s) => s.length > 0), { nil: undefined }),
    dataLines: fc.array(fieldValue, { maxLength: 3 }),
  })
  .filter((f) => f.event !== undefined || f.dataLines.length > 0);

function serializeFrame(spec: { event: string | undefined; dataLines: string[] }): string {
  const lines: string[] = [];
  if (spec.event !== undefined) lines.push(`event: ${spec.event}`);
  for (const d of spec.dataLines) lines.push(`data: ${d}`);
  lines.push(''); // blank line = frame terminator
  return lines.map((l) => `${l}\n`).join('');
}

function expectedFrame(spec: { event: string | undefined; dataLines: string[] }): SseFrame {
  return { event: spec.event ?? 'message', data: spec.dataLines.join('\n') };
}

/** Splits `text` into chunks at the given cut lengths (each clamped to what's left), covering
 *  every character exactly once, in order — the "some fetch stream delivered this in N pieces,
 *  cut wherever the network happened to flush" scenario `SseFrameParser`'s class doc names as
 *  the whole reason for its internal buffer. */
function splitAt(text: string, cutLengths: number[]): string[] {
  const chunks: string[] = [];
  let rest = text;
  for (const len of cutLengths) {
    if (rest.length === 0) break;
    const n = Math.max(0, Math.min(len, rest.length));
    if (n === 0) continue;
    chunks.push(rest.slice(0, n));
    rest = rest.slice(n);
  }
  if (rest.length > 0) chunks.push(rest);
  return chunks;
}

describe('SseFrameParser — property: chunk-boundary invariance (bd:envpit-jf7i)', () => {
  it('feeding N arbitrary well-formed frames as ONE chunk yields exactly those frames, in order', () => {
    fc.assert(
      fc.property(fc.array(frameSpec, { minLength: 0, maxLength: 6 }), (specs) => {
        const wire = specs.map(serializeFrame).join('');
        const parser = new SseFrameParser();
        const frames = parser.push(wire);
        expect(frames).toEqual(specs.map(expectedFrame));
      }),
      { numRuns: 200 },
    );
  });

  it('splitting the SAME wire text into arbitrary chunks never changes the parsed frames (streaming is chunk-boundary-invariant)', () => {
    fc.assert(
      fc.property(
        fc.array(frameSpec, { minLength: 0, maxLength: 6 }),
        fc.array(fc.integer({ min: 1, max: 7 }), { minLength: 0, maxLength: 40 }),
        (specs, cutLengths) => {
          const wire = specs.map(serializeFrame).join('');
          const expected = specs.map(expectedFrame);

          const wholeParser = new SseFrameParser();
          expect(wholeParser.push(wire)).toEqual(expected);

          const chunked = splitAt(wire, cutLengths);
          const chunkedParser = new SseFrameParser();
          const gotFromChunks: SseFrame[] = [];
          for (const chunk of chunked) gotFromChunks.push(...chunkedParser.push(chunk));
          expect(gotFromChunks).toEqual(expected);

          // The most adversarial split of all: one character per `push()` call.
          const charParser = new SseFrameParser();
          const gotFromChars: SseFrame[] = [];
          for (const ch of wire) gotFromChars.push(...charParser.push(ch));
          expect(gotFromChars).toEqual(expected);
        },
      ),
      { numRuns: 200 },
    );
  });
});

describe('SseFrameParser — property: robustness against unstructured input (bd:envpit-jf7i)', () => {
  it('never throws for ANY string, fed whole or one character at a time', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 200 }), fc.boolean(), (garbage, oneCharAtATime) => {
        const parser = new SseFrameParser();
        expect(() => {
          if (oneCharAtATime) {
            for (const ch of garbage) parser.push(ch);
          } else {
            parser.push(garbage);
          }
        }).not.toThrow();
      }),
      { numRuns: 200 },
    );
  });

  it('every dispatched frame\'s `data` is exactly its `data:` lines joined by `\\n` — no field is ever dropped or reordered', () => {
    fc.assert(
      fc.property(fc.array(frameSpec.filter((f) => f.dataLines.length > 0), { minLength: 1, maxLength: 5 }), (specs) => {
        const wire = specs.map(serializeFrame).join('');
        const parser = new SseFrameParser();
        const frames = parser.push(wire);
        expect(frames.map((f) => f.data)).toEqual(specs.map((s) => s.dataLines.join('\n')));
      }),
      { numRuns: 100 },
    );
  });
});
