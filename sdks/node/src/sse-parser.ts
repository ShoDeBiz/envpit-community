/** One dispatched server-sent-events frame. */
export interface SseFrame {
  /** The frame's `event:` field, or `'message'` per the SSE spec's default when no `event:`
   *  line was present. */
  event: string;
  /** The frame's `data:` field(s), joined by `\n` (multiple `data:` lines per frame). */
  data: string;
}

const DEFAULT_EVENT_NAME = 'message';

/**
 * A minimal server-sent-events frame parser. Feed it decoded text chunks (which may split a
 * frame, or even a single line, across chunk boundaries — this is exactly how a streamed
 * `fetch` response body arrives) and it yields complete frames as they become available.
 * Comment lines (leading `:`, used by the server for `: heartbeat` keep-alives,
 * `outputs/SPEC-envpit-a9d-1a-architecture.md` §5.3) are consumed and produce no frame.
 *
 * Deliberately NOT a general-purpose SSE client — no `id:`/`retry:` handling, no
 * last-event-id replay (the server doesn't support replay either, `config-events.constants.ts`
 * doc comment: "no `Last-Event-ID` replay exists"). This SDK only needs `event:`/`data:` per
 * the server's documented wire contract.
 */
export class SseFrameParser {
  private buffer = '';
  private eventName = DEFAULT_EVENT_NAME;
  private dataLines: string[] = [];
  private sawAnyField = false;

  /** Feed a decoded text chunk; returns any complete frames it produced (zero, one, or many). */
  push(chunk: string): SseFrame[] {
    this.buffer += chunk;
    const frames: SseFrame[] = [];
    let newlineIndex: number;
    while ((newlineIndex = this.buffer.indexOf('\n')) !== -1) {
      const rawLine = this.buffer.slice(0, newlineIndex);
      this.buffer = this.buffer.slice(newlineIndex + 1);
      const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;

      if (line === '') {
        const frame = this.dispatch();
        if (frame) frames.push(frame);
        continue;
      }
      if (line.startsWith(':')) continue; // comment / heartbeat — not a field, no-op

      const colonIndex = line.indexOf(':');
      const field = colonIndex === -1 ? line : line.slice(0, colonIndex);
      let value = colonIndex === -1 ? '' : line.slice(colonIndex + 1);
      if (value.startsWith(' ')) value = value.slice(1);

      if (field === 'event') {
        this.eventName = value || DEFAULT_EVENT_NAME;
        this.sawAnyField = true;
      } else if (field === 'data') {
        this.dataLines.push(value);
        this.sawAnyField = true;
      }
      // `id:`/`retry:` are accepted-and-ignored by design — see class doc comment.
    }
    return frames;
  }

  private dispatch(): SseFrame | null {
    if (!this.sawAnyField) return null; // a stray/consecutive blank line — nothing to dispatch
    const frame: SseFrame = { event: this.eventName, data: this.dataLines.join('\n') };
    this.eventName = DEFAULT_EVENT_NAME;
    this.dataLines = [];
    this.sawAnyField = false;
    return frame;
  }
}
