package envpit

import (
	"fmt"
	"strings"
	"testing"
	"time"
)

// AC-SEC-SDK3-1 (THREATMODEL-envpit-0t2z-3.md F1): every type that transitively holds the API
// key or the config snapshot MUST implement an explicit redacting text representation, and the
// suite must ADVERSARIALLY confirm it — actually try to leak a secret via printing/formatting
// and assert it's redacted, not just eyeball the String()/GoString() source. Go is the
// HIGHEST-RISK language for this (Sentinel F1): %v/%+v/%#v print struct fields — including
// UNEXPORTED ones — via reflection by DEFAULT unless a type overrides String()/GoString().

func TestACSecSDK3_1_ClientNeverLeaksAPIKeyOrSnapshotValuesViaDefaultFormatting(t *testing.T) {
	secretKey := "epk_super-secret-do-not-print-me"
	secretValue := "postgres://leak-me-not:hunter2@db.internal/prod"

	client := newLoadedClient(t, `{"DATABASE_URL":"`+secretValue+`"}`, WithAPIKey(secretKey))

	// Deliberately NOT testing fmt.Sprintf("%v", *client) (dereferencing to a Client VALUE):
	// Client embeds a sync.RWMutex, so copying it by value is a `go vet` copylocks violation at
	// the CALL SITE itself — confirmed by trying it while designing this test (it fails `go vet`,
	// it doesn't "leak quietly") — so this SDK's own `go vet ./...` gate already makes that
	// pattern unreachable in practice, out of this adversarial test's realistic scope.
	rendered := map[string]string{
		"%v":      fmt.Sprintf("%v", client),
		"%+v":     fmt.Sprintf("%+v", client),
		"%#v":     fmt.Sprintf("%#v", client),
		"%s":      fmt.Sprintf("%s", client),
		"Println": fmt.Sprintln(client),
	}
	for label, text := range rendered {
		if strings.Contains(text, secretKey) {
			t.Fatalf("api key leaked via %s: %q", label, text)
		}
		if strings.Contains(text, secretValue) {
			t.Fatalf("config value leaked via %s: %q", label, text)
		}
	}
	if !strings.Contains(rendered["%v"], "redacted") {
		t.Fatalf("expected the redacted marker in %%v output, got %q", rendered["%v"])
	}
}

func TestACSecSDK3_1_ConfigSnapshotNeverLeaksValuesViaDefaultFormatting(t *testing.T) {
	secretValue := "sk_live_do_not_print_this_secret"
	snapshot := ConfigSnapshot{"API_SECRET": strPtr(secretValue)}

	for label, text := range map[string]string{
		"%v":  fmt.Sprintf("%v", snapshot),
		"%+v": fmt.Sprintf("%+v", snapshot),
		"%#v": fmt.Sprintf("%#v", snapshot),
	} {
		if strings.Contains(text, secretValue) {
			t.Fatalf("config value leaked via %s: %q", label, text)
		}
	}
}

func TestACSecSDK3_1_ClientConfigOptionsAccumulatorNeverLeaksAPIKey(t *testing.T) {
	secretKey := "epk_options_accumulator_secret"
	cfg := defaultConfig()
	WithAPIKey(secretKey)(cfg)

	for label, text := range map[string]string{
		"%v":  fmt.Sprintf("%v", cfg),
		"%+v": fmt.Sprintf("%+v", cfg),
		"%#v": fmt.Sprintf("%#v", cfg),
	} {
		if strings.Contains(text, secretKey) {
			t.Fatalf("api key leaked via %s on clientConfig: %q", label, text)
		}
	}
}

func TestACSecSDK3_1_RealtimeTransportNeverLeaksAPIKey(t *testing.T) {
	secretKey := "epk_realtime_transport_secret"
	transport := newRealtimeTransport(realtimeParams{
		host:           "https://example.test",
		apiKey:         secretKey,
		pollInterval:   60,
		onChangeSignal: func(string) {},
		onModeChange:   func(ConnectionMode, ConnectionReason, time.Time) {},
		onLog:          func(string, string) {},
	})

	for label, text := range map[string]string{
		"%v":  fmt.Sprintf("%v", transport),
		"%+v": fmt.Sprintf("%+v", transport),
		"%#v": fmt.Sprintf("%#v", transport),
	} {
		if strings.Contains(text, secretKey) {
			t.Fatalf("api key leaked via %s on realtimeTransport: %q", label, text)
		}
	}
}
