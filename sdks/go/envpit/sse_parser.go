package envpit

import (
	"errors"
	"strings"
)

// SseFrame is one dispatched server-sent-events frame.
type SseFrame struct {
	// Event is the frame's event: field, or "message" per the SSE spec's default when no
	// event: line was present.
	Event string
	// Data is the frame's data: field(s), joined by "\n" (multiple data: lines per frame).
	Data string
}

const defaultSSEEventName = "message"

// defaultMaxSSELineBytes — AC-SEC-SDK3-2(b) (THREATMODEL-envpit-0t2z-3.md F2): a per-line byte
// cap so an adversarial/misbehaving server sending an unterminated line cannot grow the internal
// buffer unbounded in memory. Node has no equivalent cap yet (a documented parity-gap,
// bd:envpit-aw7l) — this SDK must not reproduce that gap.
const defaultMaxSSELineBytes = 64 * 1024

// errSSELineTooLong is returned when a single SSE line exceeds the configured byte cap without
// a terminating newline. The caller (realtimeTransport) treats this exactly like any other
// stream failure — drop the connection, reconnect via the existing degraded/backoff path. No new
// connection states are needed (AC-SEC-SDK3-2).
var errSSELineTooLong = errors.New("envpit: SSE line exceeded the maximum byte cap without a terminator")

// sseFrameParser is a minimal server-sent-events frame parser. Feed it chunks of the raw
// response body (which may split a frame, or even a single line, across chunk boundaries —
// exactly how a streamed HTTP response body arrives) via push, and it yields complete frames as
// they become available. Comment lines (leading ':', used by the server for ': heartbeat'
// keep-alives) are consumed and produce no frame.
//
// Go strings are already raw byte sequences (unlike Node's UTF-16 strings or Python's decoded
// str), so — unlike the Node/Python ports — this parser never needs an incremental UTF-8
// decoding step: splitting on the single-byte '\n' delimiter is always safe regardless of where
// a multi-byte UTF-8 character happens to straddle a chunk boundary, because 0x0A never appears
// as a continuation byte in a valid UTF-8 sequence.
//
// Deliberately NOT a general-purpose SSE client — no id:/retry: handling, no Last-Event-ID
// replay (the server doesn't support replay either).
type sseFrameParser struct {
	buffer       string
	eventName    string
	dataLines    []string
	sawAnyField  bool
	maxLineBytes int
}

func newSSEFrameParser(maxLineBytes int) *sseFrameParser {
	if maxLineBytes <= 0 {
		maxLineBytes = defaultMaxSSELineBytes
	}
	return &sseFrameParser{eventName: defaultSSEEventName, maxLineBytes: maxLineBytes}
}

// push feeds a chunk of raw bytes (as a string); returns any complete frames it produced (zero,
// one, or many). Returns errSSELineTooLong if the in-progress line has grown past the byte cap
// without a terminator — the internal buffer is reset first so the parser is left in a clean
// state for the caller to decide what happens next (reconnect).
func (p *sseFrameParser) push(chunk string) ([]SseFrame, error) {
	p.buffer += chunk
	var frames []SseFrame

	for {
		idx := strings.IndexByte(p.buffer, '\n')
		if idx == -1 {
			break
		}
		rawLine := p.buffer[:idx]
		p.buffer = p.buffer[idx+1:]
		line := strings.TrimSuffix(rawLine, "\r")

		switch {
		case line == "":
			if frame, ok := p.dispatch(); ok {
				frames = append(frames, frame)
			}
		case strings.HasPrefix(line, ":"):
			// comment / heartbeat — not a field, no-op.
		default:
			field, value := splitSSEField(line)
			switch field {
			case "event":
				if value == "" {
					value = defaultSSEEventName
				}
				p.eventName = value
				p.sawAnyField = true
			case "data":
				p.dataLines = append(p.dataLines, value)
				p.sawAnyField = true
			}
			// id:/retry: are accepted-and-ignored by design — see type doc comment.
		}
	}

	if len(p.buffer) > p.maxLineBytes {
		p.reset()
		return frames, errSSELineTooLong
	}
	return frames, nil
}

func splitSSEField(line string) (field, value string) {
	idx := strings.IndexByte(line, ':')
	if idx == -1 {
		return line, ""
	}
	field = line[:idx]
	value = strings.TrimPrefix(line[idx+1:], " ")
	return field, value
}

func (p *sseFrameParser) dispatch() (SseFrame, bool) {
	if !p.sawAnyField {
		return SseFrame{}, false // a stray/consecutive blank line — nothing to dispatch
	}
	frame := SseFrame{Event: p.eventName, Data: strings.Join(p.dataLines, "\n")}
	p.eventName = defaultSSEEventName
	p.dataLines = nil
	p.sawAnyField = false
	return frame, true
}

func (p *sseFrameParser) reset() {
	p.buffer = ""
	p.eventName = defaultSSEEventName
	p.dataLines = nil
	p.sawAnyField = false
}
