/**
 * Retrofit (bd:envpit-0t2z.3 Slice 0): the `SseFrameParser — adversarial input` cases that used
 * to live inline in `realtime-adversarial.test.ts` (extracted from there — see git history) now
 * load from the shared, language-agnostic `test-vectors/sse-frames.json`. Every other SDK
 * language's test suite parameterizes over the exact same file, proving byte-identical wire
 * parsing across all four languages, not just prose agreement.
 */
import { describe, expect, it } from 'vitest';
import { SseFrameParser, type SseFrame } from '../../src/sse-parser.js';
import { loadVectors } from '../vector-loader.js';

interface SseFrameVectorCase {
  name: string;
  chunkMode: 'char' | 'whole';
  input: string;
  expectedFrames: SseFrame[];
}
interface SseFrameVectors {
  cases: SseFrameVectorCase[];
}

const vectors = loadVectors<SseFrameVectors>('sse-frames.json');

describe('SseFrameParser — test-vectors/sse-frames.json', () => {
  for (const c of vectors.cases) {
    it(c.name, () => {
      const parser = new SseFrameParser();
      const chunks = c.chunkMode === 'char' ? Array.from(c.input) : [c.input];
      const frames: SseFrame[] = [];
      for (const chunk of chunks) frames.push(...parser.push(chunk));
      expect(frames).toEqual(c.expectedFrames);
    });
  }
});
