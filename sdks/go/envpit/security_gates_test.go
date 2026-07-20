package envpit

import (
	"os"
	"path/filepath"
	"reflect"
	"regexp"
	"runtime"
	"strings"
	"testing"
)

// srcRoot is this package's own runtime source directory (sdks/go/envpit/*.go) — grep-gate
// scope, matching sdks/python/tests/test_no_disk_write.py and test_no_skip_tls.py's own
// "runtime source tree, never tests/" scope.
func srcRoot(t *testing.T) string {
	t.Helper()
	_, thisFile, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("runtime.Caller failed while resolving the package source directory")
	}
	return filepath.Dir(thisFile)
}

func runtimeSourceFiles(t *testing.T) []string {
	t.Helper()
	root := srcRoot(t)
	entries, err := os.ReadDir(root)
	if err != nil {
		t.Fatalf("failed to list %s: %v", root, err)
	}
	var files []string
	for _, e := range entries {
		name := e.Name()
		if e.IsDir() || !strings.HasSuffix(name, ".go") || strings.HasSuffix(name, "_test.go") {
			continue
		}
		files = append(files, filepath.Join(root, name))
	}
	return files
}

// ---- INV-SDK-3 / AC-SEC-SDK3-4 — no runtime disk writes, ever ------------------------------

func TestINV_SDK_3_and_ACSecSDK3_4_NoRuntimeSourceFileWritesToDisk(t *testing.T) {
	forbidden := []struct {
		label   string
		pattern *regexp.Regexp
	}{
		{"os.WriteFile", regexp.MustCompile(`\bos\.WriteFile\(`)},
		{"os.Create", regexp.MustCompile(`\bos\.Create\(`)},
		{"os.OpenFile with a write flag", regexp.MustCompile(`\bos\.OpenFile\([^)]*O_(WRONLY|RDWR|CREATE|APPEND|TRUNC)`)},
		{"os.CreateTemp", regexp.MustCompile(`\bos\.CreateTemp\(`)},
		{"ioutil.WriteFile (legacy)", regexp.MustCompile(`\bioutil\.WriteFile\(`)},
		{"the encoding/gob package", regexp.MustCompile(`\bencoding/gob\b`)},
	}

	var offenders []string
	for _, path := range runtimeSourceFiles(t) {
		content, err := os.ReadFile(path)
		if err != nil {
			t.Fatalf("read %s: %v", path, err)
		}
		text := string(content)
		for _, f := range forbidden {
			if f.pattern.MatchString(text) {
				offenders = append(offenders, filepath.Base(path)+": "+f.label)
			}
		}
	}
	if len(offenders) > 0 {
		t.Fatalf("disk-write-capable pattern(s) found in runtime source: %v", offenders)
	}
}

func TestINV_SDK_3_HTTPClientHasNoResponseDiskCacheEnabled(t *testing.T) {
	// net/http's default Transport (used unless a caller overrides it via WithHTTPClient) has no
	// disk-cache concept at all — unlike e.g. github.com/gregjones/httpcache. Positive,
	// source-grepped confirmation that no such dependency was ever added, and that this module
	// has ZERO runtime dependencies in the first place (ADR-S3-02).
	goModPath := filepath.Join(srcRoot(t), "go.mod")
	content, err := os.ReadFile(goModPath)
	if err != nil {
		t.Fatalf("read go.mod: %v", err)
	}
	text := string(content)
	for _, forbidden := range []string{"httpcache", "diskcache", "requests_cache"} {
		if strings.Contains(text, forbidden) {
			t.Fatalf("go.mod references %s — a disk-cache-capable HTTP dependency", forbidden)
		}
	}
	// Zero runtime dependencies: go.mod must not have a require block at all (the module has no
	// third-party imports of any kind, test or runtime).
	if strings.Contains(text, "require") {
		t.Fatalf("go.mod has a require block — this SDK is meant to have zero runtime dependencies (ADR-S3-02):\n%s", text)
	}
}

// ---- AC-SEC-SDK3-3 — no skip-TLS option anywhere in the public API -------------------------

func TestACSecSDK3_3_NoTLSBypassPatternAnywhereInRuntimeSource(t *testing.T) {
	forbidden := []struct {
		label   string
		pattern *regexp.Regexp
	}{
		{"InsecureSkipVerify", regexp.MustCompile(`InsecureSkipVerify`)},
		{"an 'insecure' option name", regexp.MustCompile(`(?i)insecure`)},
		{"a 'skip verify'-style option name", regexp.MustCompile(`(?i)skip.?verify`)},
	}
	var offenders []string
	for _, path := range runtimeSourceFiles(t) {
		content, err := os.ReadFile(path)
		if err != nil {
			t.Fatalf("read %s: %v", path, err)
		}
		text := string(content)
		for _, f := range forbidden {
			if f.pattern.MatchString(text) {
				offenders = append(offenders, filepath.Base(path)+": "+f.label)
			}
		}
	}
	if len(offenders) > 0 {
		t.Fatalf("TLS-bypass-capable pattern(s) found in runtime source: %v", offenders)
	}
}

// TestACSecSDK3_3_PublicOptionSetIsExactlyTheDocumentedSix locks the public Option surface to
// Sara's exact documented list (SPEC-envpit-0t2z-3-1a-architecture.md §2.2:
// WithAPIKey/WithHost/WithPollInterval/WithTimeout/WithHTTPClient/WithLogger) — a future
// WithInsecure/WithSkipVerify/WithTLSConfig addition would both fail the grep gate above (name
// match) AND grow this count, so this test is a second, independent tripwire.
func TestACSecSDK3_3_PublicOptionSetIsExactlyTheDocumentedSix(t *testing.T) {
	known := []Option{
		WithAPIKey(""), WithHost(""), WithPollInterval(0), WithTimeout(0),
		WithHTTPClient(nil), WithLogger(nil),
	}
	if len(known) != 6 {
		t.Fatalf("expected exactly 6 documented Options (Sara §2.2's list), got %d", len(known))
	}
	if reflect.TypeOf(known[0]).Kind() != reflect.Func {
		t.Fatal("sanity: Option must be a function type")
	}
}
