package envpit

import (
	"context"
	"sync"
	"sync/atomic"
)

// subRegistry tracks every live subscriber channel for one event kind (ChangeEvent /
// ConnectionEvent / error) and provides the non-blocking, drop-on-full dispatch AC-GO-01
// requires. All mutation AND every dispatch send happen under the same mutex — this is what
// makes "unsubscribe races with an in-flight dispatch send" impossible: a channel is only ever
// closed strictly after it has been removed from subs under this lock, and dispatch only ever
// iterates the live map under the same lock, so a send-after-close can never happen (Sara §3.2:
// "subscriber channels close on ctx-done or Close() — never send-after-close").
type subRegistry[T any] struct {
	mu         sync.Mutex
	subs       map[chan T]struct{}
	dropped    int64
	warnedDrop bool
}

func newSubRegistry[T any]() *subRegistry[T] {
	return &subRegistry[T]{subs: make(map[chan T]struct{})}
}

// subscribe registers a new buffered channel and returns its receive-only view. The channel is
// closed (and removed from the registry) when either subCtx is done or clientCtx is done,
// whichever happens first — clientCtx covers Client.Close() so a subscriber whose own ctx is
// never cancelled (e.g. context.Background()) still doesn't leak the watcher goroutine forever.
func (r *subRegistry[T]) subscribe(subCtx, clientCtx context.Context, buffer int) <-chan T {
	ch := make(chan T, buffer)
	r.mu.Lock()
	r.subs[ch] = struct{}{}
	r.mu.Unlock()

	go func() {
		select {
		case <-subCtx.Done():
		case <-clientCtx.Done():
		}
		r.unsubscribe(ch)
	}()

	return ch
}

func (r *subRegistry[T]) unsubscribe(ch chan T) {
	r.mu.Lock()
	_, ok := r.subs[ch]
	if ok {
		delete(r.subs, ch)
	}
	r.mu.Unlock()
	if ok {
		close(ch)
	}
}

// closeAll unregisters and closes every currently-live subscriber channel — called once from
// Client.Close().
func (r *subRegistry[T]) closeAll() {
	r.mu.Lock()
	defer r.mu.Unlock()
	for ch := range r.subs {
		delete(r.subs, ch)
		close(ch)
	}
}

// dispatch delivers payload to every live subscriber with a non-blocking send. A full buffer
// drops the event for that subscriber (counted in Dropped()) rather than blocking the SDK's one
// dispatch path — the whole point of AC-GO-01. warnDropped is invoked at most once per
// "episode" (a run of one-or-more drops not separated by a fully-clean dispatch pass) — never
// once per individual drop, matching the bounded-lines diagnostics discipline used elsewhere in
// this SDK (INV-SDK-10's cadence, applied here to a different failure shape).
func (r *subRegistry[T]) dispatch(payload T, warnDropped func()) {
	r.mu.Lock()
	defer r.mu.Unlock()
	droppedThisPass := false
	for ch := range r.subs {
		select {
		case ch <- payload:
		default:
			atomic.AddInt64(&r.dropped, 1)
			droppedThisPass = true
		}
	}
	if droppedThisPass {
		if !r.warnedDrop {
			r.warnedDrop = true
			if warnDropped != nil {
				warnDropped()
			}
		}
	} else {
		r.warnedDrop = false
	}
}

// Dropped returns the total number of notifications dropped so far because a subscriber's
// buffered channel was full.
func (r *subRegistry[T]) Dropped() int64 { return atomic.LoadInt64(&r.dropped) }
