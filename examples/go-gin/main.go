// Gin example — resolves config from a real EnvPit server through the PUBLISHED Go SDK
// (github.com/ShoDeBiz/envpit-community/sdks/go/envpit), not a `replace` to the local checkout.
//
// Why this exists: every Go SDK test in this repo uses a fake transport. That proves the
// client behaves as designed; it does not prove the design matches the server — and those
// diverged once already, when the resolve body changed from a bare map to
// { values, secretKeys }. This file is the smallest thing that would have caught that class
// of bug: a framework example making a real HTTP call through a real module-proxy dependency.
//
// The selling point demonstrated here: EnvPit config is merged into the process environment
// ONCE at startup, before the app reads anything — so ordinary os.Getenv("X") code, including
// Gin's own os.Getenv-based config, works completely untouched.
//
//	set -a; . ~/.envpit-example.env; set +a
//	go run .
package main

import (
	"context"
	"fmt"
	"log"
	"net/http"
	"os"
	"sort"
	"time"

	"github.com/ShoDeBiz/envpit-community/sdks/go/envpit"
	"github.com/gin-gonic/gin"
)

// startupReport is computed ONCE at boot (mirroring MergeIntoEnv's own boot-time-snapshot
// contract) and served read-only by the HTTP handler below — the handler never re-fetches or
// re-merges, it just reports what startup already proved.
type startupReport struct {
	mergedKeys                       []string
	skippedExistingKeys              []string
	skippedSecretKeys                []string
	secretKeyCount                   int
	secretKeysConfirmedAbsentFromEnv bool
	sampleMergedKey                  string
	sampleMergedKeyReadableViaGetenv bool
}

func main() {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	// envpit.Load falls back to the ENVPIT_API_KEY environment variable on its own (see
	// options.go WithAPIKey doc comment) — we never read or print the key ourselves. ENVPIT_HOST
	// has no such built-in fallback (WithHost's default is the hard-coded production host), so
	// an optional local override is wired through explicitly, same convention as
	// examples/node/index.mjs.
	opts := []envpit.Option{}
	if host := os.Getenv("ENVPIT_HOST"); host != "" {
		opts = append(opts, envpit.WithHost(host))
	}

	client, err := envpit.Load(ctx, opts...)
	if err != nil {
		log.Fatalf("envpit: failed to load config: %v", err)
	}
	defer client.Close()

	// One-time, boot-time-only write into os.Environ (env.go's own doc comment: "Call
	// MergeIntoEnv once, synchronously, immediately after Load/NewClient returns and before
	// your program spawns other goroutines"). Zero options = the safe default: secret-flagged
	// keys are excluded (SkippedSecrets), and an existing os.Environ value always wins
	// (SkippedExisting).
	result := client.MergeIntoEnv()

	report := buildStartupReport(client, result)
	logStartupReport(report)

	if !report.secretKeysConfirmedAbsentFromEnv {
		// This would mean a secret-flagged key leaked into the real process environment despite
		// the default (secrets-excluded) MergeIntoEnv call — fail loudly, never serve traffic.
		log.Fatal("envpit: FAIL — a secret-flagged key is present in the process environment; refusing to start")
	}

	router := gin.Default()
	router.GET("/config", func(c *gin.Context) {
		c.JSON(http.StatusOK, gin.H{
			"mergedKeys":                       report.mergedKeys,
			"skippedExistingKeys":              report.skippedExistingKeys,
			"skippedSecretKeys":                report.skippedSecretKeys,
			"secretKeyCount":                   report.secretKeyCount,
			"secretKeysConfirmedAbsentFromEnv": report.secretKeysConfirmedAbsentFromEnv,
			"sampleMergedKey":                  report.sampleMergedKey,
			"sampleMergedKeyReadableViaGetenv": report.sampleMergedKeyReadableViaGetenv,
			"note":                             "key NAMES only — no config value is ever included in this response",
		})
	})

	addr := ":8081"
	log.Printf("gin example listening on %s — GET /config", addr)
	if err := router.Run(addr); err != nil {
		log.Fatalf("gin: server error: %v", err)
	}
}

// buildStartupReport assembles the read-only report served by /config. Crucially, the
// secret-absence check does NOT trust result.SkippedSecrets (a struct the SDK computed) — it
// re-derives the answer from a fresh os.LookupEnv call against the real environment, per the
// task's explicit requirement ("asserted with os.LookupEnv against the real environment rather
// than trusting the returned result struct").
func buildStartupReport(client *envpit.Client, result envpit.MergeResult) startupReport {
	secretKeys := client.SecretKeys() // sorted key NAMES only, never values

	confirmedAbsent := true
	for _, k := range secretKeys {
		if _, present := os.LookupEnv(k); present {
			confirmedAbsent = false
			break
		}
	}

	var sampleKey string
	var sampleReadable bool
	if len(result.Merged) > 0 {
		sampleKey = result.Merged[0]
		_, sampleReadable = os.LookupEnv(sampleKey)
	}

	mergedKeys := make([]string, 0, len(result.Merged))
	mergedKeys = append(mergedKeys, result.Merged...)
	skippedExisting := make([]string, 0, len(result.SkippedExisting))
	skippedExisting = append(skippedExisting, result.SkippedExisting...)
	skippedSecrets := make([]string, 0, len(result.SkippedSecrets))
	skippedSecrets = append(skippedSecrets, result.SkippedSecrets...)
	sort.Strings(mergedKeys)
	sort.Strings(skippedExisting)
	sort.Strings(skippedSecrets)

	return startupReport{
		mergedKeys:                       mergedKeys,
		skippedExistingKeys:              skippedExisting,
		skippedSecretKeys:                skippedSecrets,
		secretKeyCount:                   len(secretKeys),
		secretKeysConfirmedAbsentFromEnv: confirmedAbsent,
		sampleMergedKey:                  sampleKey,
		sampleMergedKeyReadableViaGetenv: sampleReadable,
	}
}

func logStartupReport(r startupReport) {
	fmt.Println("envpit: config merged into process environment (key NAMES only, no values printed)")
	fmt.Printf("  merged            : %v\n", r.mergedKeys)
	fmt.Printf("  skipped (existing): %v\n", r.skippedExistingKeys)
	fmt.Printf("  skipped (secret)  : %v\n", r.skippedSecretKeys)
	fmt.Printf("  secret-flagged keys in this environment: %d\n", r.secretKeyCount)
	fmt.Printf("  secret keys confirmed ABSENT from process env (os.LookupEnv): %v\n", r.secretKeysConfirmedAbsentFromEnv)
	if r.sampleMergedKey != "" {
		fmt.Printf("  sample: os.Getenv(%q) now readable by ordinary code = %v\n", r.sampleMergedKey, r.sampleMergedKeyReadableViaGetenv)
	} else {
		fmt.Println("  sample: no non-secret key merged in this environment to demonstrate os.Getenv with")
	}
}
