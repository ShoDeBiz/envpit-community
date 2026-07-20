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
import java.util.Locale;
import java.util.Map;

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

    record FetchResult(Map<String, String> snapshot, String etag) {
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

        Map<String, String> snapshot = new LinkedHashMap<>();
        for (Map.Entry<?, ?> entry : rawMap.entrySet()) {
            String key = String.valueOf(entry.getKey());
            Object value = entry.getValue();
            if (value == null) {
                snapshot.put(key, null);
            } else if (value instanceof String s) {
                snapshot.put(key, s);
            } else {
                // The config-snapshot contract is a FLAT string map (Sara §2.3) — a non-string,
                // non-null value is a shape violation, not something to silently coerce.
                throw new NetworkException("EnvPit returned an invalid JSON response from " + url + ".");
            }
        }

        String etag = response.headers().firstValue("Etag").orElse("");
        return new FetchResult(snapshot, etag);
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
