package com.envpit;

import java.io.ByteArrayOutputStream;
import java.io.EOFException;
import java.io.IOException;
import java.io.InputStream;
import java.net.ConnectException;
import java.net.SocketException;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.net.http.HttpTimeoutException;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;

/**
 * {@code GET {host}/api/v1/config} — the one real HTTP call this SDK makes on the initial-load
 * and background-refresh paths (Phase 1 scope — no bootstrap/handshake endpoint). Auth via
 * {@code X-Api-Key}; project+environment are inferred server-side from the key itself
 * (INV-SDK-12).
 */
final class Transport {

    static final String CONFIG_PATH = "/api/v1/config";

    /**
     * AC-SEC-SDK3-2(a) (THREATMODEL-envpit-0t2z-3.md F2): the config-response body is read with a
     * maximum byte cap so an adversarial/misbehaving server sending an unbounded body cannot be
     * buffered into memory without limit.
     */
    static final long DEFAULT_BODY_BYTE_CAP = 5L * 1024 * 1024; // 5 MiB

    private Transport() {
    }

    /**
     * bd:envpit-durd: {@code GET /api/v1/config}'s 200 body is an ENVELOPE, {@code {values:
     * {key: string|null}, secretKeys: [string]}} — not the pre-durd bare {@code {key: value}}
     * map (test-vectors/resolve-body.json is the authoritative spec for every check below).
     * {@code secretKeys} carries key NAMES only, never values; a name absent from {@code values}
     * is tolerated, not an error (a future server-side widening of {@code secretKeys} must not
     * turn into a client-side outage).
     */
    record FetchResult(Map<String, String> values, Set<String> secretKeys, String etag) {
    }

    static FetchResult fetchConfig(HttpClient httpClient, String host, String apiKey, Duration timeout) {
        String url = host + CONFIG_PATH;

        HttpRequest request;
        try {
            request = HttpRequest.newBuilder(URI.create(url))
                    .header("X-Api-Key", apiKey)
                    .timeout(timeout)
                    .GET()
                    .build();
        } catch (RuntimeException e) {
            throw new NetworkException("envpit: could not build a request for " + url + ": " + e.getMessage(), e);
        }

        HttpResponse<InputStream> response;
        try {
            response = httpClient.send(request, HttpResponse.BodyHandlers.ofInputStream());
        } catch (IOException e) {
            throw mapTransportFailure(url, e);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new NetworkException(
                    "Could not reach EnvPit at " + url + " (interrupted). Check your network/proxy and https://status.envpit.com.",
                    e);
        }

        int status = response.statusCode();
        if (status == 401 || status == 403) {
            drainQuietly(response.body());
            throw new AuthenticationException(
                    "API key rejected (HTTP " + status + "). It may be revoked, expired, or mistyped. Check Project → API Keys in EnvPit.");
        }
        if (status < 200 || status >= 300) {
            drainQuietly(response.body());
            throw new NetworkException("EnvPit returned HTTP " + status + " while fetching config from " + url + ".");
        }

        byte[] body;
        try {
            body = readCapped(response.body(), DEFAULT_BODY_BYTE_CAP);
        } catch (BodyTooLargeException e) {
            throw new NetworkException(
                    "envpit: EnvPit response from " + url + " exceeded the maximum allowed size (" + DEFAULT_BODY_BYTE_CAP + " bytes)");
        } catch (IOException e) {
            // A read error mid-body (e.g. a connection reset after headers already arrived) is
            // transport-shaped, not a JSON-parse concern (bd:envpit-4dbm class) — describe it the
            // same way a pre-response transport failure is described.
            throw mapTransportFailure(url, e);
        }

        String bodyText = new String(body, StandardCharsets.UTF_8);
        Object parsed;
        try {
            parsed = Json.parse(bodyText);
        } catch (JsonParseException e) {
            throw new NetworkException("EnvPit returned an invalid JSON response from " + url + ".");
        }

        if (!(parsed instanceof Map<?, ?> rawMap)) {
            // Covers a bare array/number/string/boolean/null top-level value (Python
            // transport.py's isinstance(parsed, dict) parity; test-vectors/CONFORMANCE.md's
            // "discovered-but-out-of-scope" note on Node's own gap here — this SDK closes it).
            throw new NetworkException("EnvPit returned an invalid JSON response from " + url + ".");
        }

        // bd:envpit-durd (test-vectors/resolve-body.json): strict envelope, {values, secretKeys}
        // BOTH required. A pre-durd bare map (no "values"/"secretKeys" keys at all) fails this
        // check and is REJECTED here, not accepted as a legacy fallback — see resolve-body.json's
        // own `notes.breakingChange`: silently treating a bare map as "secretKeys = []" would make
        // every native-env-merge path believe an environment has no secrets and merge them while
        // reporting none were found. There were zero published SDK releases when this landed, so
        // failing loudly against a pre-durd server is the safe direction, not a compatibility break
        // of anything real. `{}` is ambiguous the same way (a pre-durd empty environment vs. a
        // new server that dropped both fields) and is rejected for the identical reason.
        //
        // This one check gets a cause-naming message rather than the generic one the shape
        // violations below use: it is the check a pre-durd server actually trips, and the most
        // probable way to reach it is a current SDK pointed at an older self-hosted server.
        // "invalid JSON response" alone would send someone hunting a network or proxy fault they
        // do not have. Matches Node's and Python's wording for the same condition.
        if (!rawMap.containsKey("values") || !rawMap.containsKey("secretKeys")) {
            throw new NetworkException(
                    "EnvPit returned a config-resolve response this SDK does not understand (from " + url
                            + "): expected {values, secretKeys}. An EnvPit server predating the "
                            + "secret-labelling change returns a bare key/value map instead — if you "
                            + "self-host, upgrade the server.");
        }

        Object rawValues = rawMap.get("values");
        if (!(rawValues instanceof Map<?, ?> rawValuesMap)) {
            // Covers both `values` missing-shape variants the vectors name: a bare array/string/etc,
            // and `values: null` (a JSON null is not instanceof Map either).
            throw new NetworkException("EnvPit returned an invalid JSON response from " + url + ".");
        }

        Object rawSecretKeys = rawMap.get("secretKeys");
        if (!(rawSecretKeys instanceof List<?> rawSecretKeysList)) {
            // A bare string is iterable character-by-character in some languages this vector suite
            // spans — Java has no such accidental-iteration risk, but the type check is still
            // required: this must be a JSON array, not any other shape.
            throw new NetworkException("EnvPit returned an invalid JSON response from " + url + ".");
        }

        Map<String, String> values = new LinkedHashMap<>();
        for (Map.Entry<?, ?> entry : rawValuesMap.entrySet()) {
            String key = String.valueOf(entry.getKey());
            Object value = entry.getValue();
            if (value == null) {
                values.put(key, null);
            } else if (value instanceof String s) {
                values.put(key, s);
            } else {
                // The config-snapshot contract is a FLAT string map (Sara §2.3) — a non-string,
                // non-null value is a shape violation, not something to silently coerce. Unchanged
                // from the pre-durd contract; this check simply moved inside `values`.
                throw new NetworkException("EnvPit returned an invalid JSON response from " + url + ".");
            }
        }

        Set<String> secretKeys = new LinkedHashSet<>();
        for (Object el : rawSecretKeysList) {
            if (!(el instanceof String s)) {
                throw new NetworkException("EnvPit returned an invalid JSON response from " + url + ".");
            }
            // A secretKeys name absent from `values` is tolerated, not cross-validated here — see
            // resolve-body.json's "secret-key-absent-from-values-is-tolerated" case: the two lists
            // are built from the same server-side query, and a client that hard-failed on a name it
            // couldn't cross-reference would turn any future server-side widening of `secretKeys`
            // into an outage.
            secretKeys.add(s);
        }

        String etag = response.headers().firstValue("Etag").orElse("");
        return new FetchResult(values, secretKeys, etag);
    }

    private static void drainQuietly(InputStream body) {
        try (body) {
            body.readAllBytes();
        } catch (IOException ignored) {
            // best-effort drain to allow connection reuse; a failure here is not itself an error
        }
    }

    private static final class BodyTooLargeException extends IOException {
    }

    private static byte[] readCapped(InputStream in, long cap) throws IOException {
        try (in) {
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buf = new byte[8192];
            long total = 0;
            int n;
            while ((n = in.read(buf)) != -1) {
                total += n;
                if (total > cap) {
                    throw new BodyTooLargeException();
                }
                out.write(buf, 0, n);
            }
            return out.toByteArray();
        }
    }

    /**
     * Maps a low-level {@code java.net}/{@code java.io} transport failure (DNS/connect/timeout/
     * connection-reset) to a {@link NetworkException} — the bd:envpit-4dbm-class guarantee: EVERY
     * transport failure, including a mid-connection reset (a server that accepted the connection,
     * read the request, then closed with zero response bytes — a rolling-deploy pod kill
     * mid-request, an LB idle-timeout race, a NAT/firewall RST, not a contrived condition), maps
     * here; none may escape as a raw, unwrapped {@link IOException}/{@code java.net.*} exception.
     * Matches Go's {@code mapTransportError}/{@code isConnectionReset} and the fix originally
     * filed against the Python SDK for the same bug class (bd:envpit-4dbm).
     */
    static NetworkException mapTransportFailure(String url, IOException cause) {
        String description = describeFailure(cause);
        return new NetworkException(
                "Could not reach EnvPit at " + url + " (" + description + "). Check your network/proxy and https://status.envpit.com.",
                cause);
    }

    private static String describeFailure(IOException cause) {
        if (cause instanceof HttpTimeoutException) {
            return "timed out";
        }
        if (isConnectionReset(cause)) {
            return "the connection was reset before a response was received";
        }
        String msg = cause.getMessage();
        return msg != null && !msg.isBlank() ? msg : cause.getClass().getSimpleName();
    }

    /**
     * Recognizes the bd:envpit-4dbm error shape across the exception types {@code
     * HttpClient.send()}/{@code sendAsync()} are documented (java.net.http package-info: "if an
     * I/O error occurs ... an IOException is thrown") and empirically observed (see
     * ConnectionResetTest) to throw for a dropped/reset connection:
     * <ul>
     *   <li>{@link SocketException} EXCLUDING {@link ConnectException} — a generic {@code
     *       SocketException} (e.g. "Connection reset", "Broken pipe" on write) is thrown for a
     *       failure AFTER a connection was established (a mid-request reset); {@link
     *       ConnectException} specifically means the connection attempt itself was refused
     *       (ECONNREFUSED) — a distinct, pre-connect failure that must NOT be described with
     *       reset-specific wording.
     *   <li>{@link EOFException} — an unexpected, premature end-of-stream.
     *   <li>An {@link IOException} whose message names a reset/closed-connection condition —
     *       {@code HttpClient}'s internal implementation does not always surface a typed
     *       subclass for every reset shape; matching on message text is the same
     *       verified-empirically fallback Go's own {@code isConnectionReset} needed for its
     *       {@code net.OpError}-wrapped cases.
     * </ul>
     */
    static boolean isConnectionReset(IOException cause) {
        if (cause instanceof ConnectException) {
            return false; // connection REFUSED is a distinct pre-connect failure, not a mid-request reset
        }
        if (cause instanceof SocketException) {
            return true;
        }
        if (cause instanceof EOFException) {
            return true;
        }
        String msg = cause.getMessage();
        if (msg == null) {
            return false;
        }
        String lower = msg.toLowerCase(Locale.ROOT);
        return lower.contains("connection reset")
                || lower.contains("broken pipe")
                || lower.contains("unexpected end of stream")
                || lower.contains("eof reached")
                || lower.contains("connection closed")
                || lower.contains("premature eof");
    }
}
