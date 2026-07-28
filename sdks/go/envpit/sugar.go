package envpit

import (
	"context"
	"sync"
)

// Package-level default client (Sara §2.2: "package-level default over NewClient" — the Go
// mapping of Node/Python's module-level sugar layer, http.DefaultClient precedent).
var (
	defaultMu     sync.RWMutex
	defaultClient *Client
)

// Load is the package-level sugar entry point: fetches your environment's config once
// (blocking) via NewClient, and installs the result as the package-level default so
// Get/GetOr/GetInt/GetIntOr/GetBool/GetBoolOr/Changes/Connections/Errors/CacheInfo/Close (the
// package-level functions below) delegate to it.
//
//	client, err := envpit.Load(ctx)
//	dbURL, err := client.Get("DATABASE_URL")
//
// Calling Load again closes the OUTGOING default client's background work before installing the
// new one (Python-SDK parity, bd:envpit-igc0's lesson: the previous default must never be
// orphaned/unstoppable) — the new client is installed first so a concurrent package-level call
// never observes a gap, and the old client's Close() (which can block briefly joining its
// goroutines) runs after the swap so it can never stall an unrelated concurrent call.
//
// Prefer NewClient directly for multiple independent clients (e.g. more than one
// project/environment in the same process) — the package-level sugar only ever tracks one
// "current" default.
func Load(ctx context.Context, opts ...Option) (*Client, error) {
	client, err := NewClient(ctx, opts...)
	if err != nil {
		return nil, err
	}
	defaultMu.Lock()
	previous := defaultClient
	defaultClient = client
	defaultMu.Unlock()
	if previous != nil {
		previous.Close()
	}
	return client, nil
}

func requireDefault() *Client {
	defaultMu.RLock()
	c := defaultClient
	defaultMu.RUnlock()
	if c == nil {
		panic("envpit: no default client — call envpit.Load(ctx) first")
	}
	return c
}

// Get delegates to the package-level default client's Get. Panics if Load hasn't been called
// yet (a pure programmer-usage error, not a runtime/data condition).
func Get(key string) (string, error) { return requireDefault().Get(key) }

// GetOr delegates to the package-level default client's GetOr.
func GetOr(key, def string) string { return requireDefault().GetOr(key, def) }

// GetInt delegates to the package-level default client's GetInt.
func GetInt(key string) (int, error) { return requireDefault().GetInt(key) }

// GetIntOr delegates to the package-level default client's GetIntOr.
func GetIntOr(key string, def int) int { return requireDefault().GetIntOr(key, def) }

// GetBool delegates to the package-level default client's GetBool.
func GetBool(key string) (bool, error) { return requireDefault().GetBool(key) }

// GetBoolOr delegates to the package-level default client's GetBoolOr.
func GetBoolOr(key string, def bool) bool { return requireDefault().GetBoolOr(key, def) }

// Changes delegates to the package-level default client's Changes.
func Changes(ctx context.Context) <-chan ChangeEvent { return requireDefault().Changes(ctx) }

// Connections delegates to the package-level default client's Connections.
func Connections(ctx context.Context) <-chan ConnectionEvent {
	return requireDefault().Connections(ctx)
}

// Errors delegates to the package-level default client's Errors.
func Errors(ctx context.Context) <-chan error { return requireDefault().Errors(ctx) }

// Cache delegates to the package-level default client's CacheInfo. (Named Cache, not CacheInfo,
// to avoid colliding with the CacheInfo type — Go's single flat package-level identifier
// namespace, unlike Node/Python where a method name and a type name never collide.)
func Cache() CacheInfo { return requireDefault().CacheInfo() }

// MergeIntoEnv delegates to the package-level default client's MergeIntoEnv — see that
// method's doc comment (env.go) for the full boot-time-snapshot / no-override-by-default /
// secret-filtering contract.
func MergeIntoEnv(opts ...MergeOption) MergeResult { return requireDefault().MergeIntoEnv(opts...) }

// Close closes and clears the package-level default client, if one is set. Unlike the other
// package-level functions, Close is a no-op (not a panic) when no default client is set.
func Close() {
	defaultMu.Lock()
	client := defaultClient
	defaultClient = nil
	defaultMu.Unlock()
	if client != nil {
		client.Close()
	}
}
