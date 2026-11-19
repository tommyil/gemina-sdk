package co.gemina.sdk;

import co.gemina.sdk.generated.model.ExtractionCompletedEventData;
import co.gemina.sdk.generated.model.WebhookTestEventData;
import com.google.gson.Gson;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParseException;
import com.google.gson.stream.JsonReader;
import com.google.gson.stream.JsonToken;
import java.io.IOException;
import java.io.StringReader;
import java.nio.ByteBuffer;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;
import java.security.MessageDigest;
import java.util.Base64;
import java.util.Collections;
import java.util.Map;
import java.util.regex.Pattern;
import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;

/**
 * Verify and parse an incoming Gemina webhook (HELPER_CONTRACT §6, Standard
 * Webhooks v1). Hand-written; lives outside the generated package. No network,
 * no client instance.
 */
public final class GeminaWebhooks {

    private static final String SECRET_PREFIX = "whsec_";
    // Standard alphabet, padded, no whitespace. matches() tests the whole text.
    private static final Pattern BASE64 =
            Pattern.compile("(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?");
    private static final Pattern TIMESTAMP = Pattern.compile("[0-9]{1,12}");
    private static final Gson GSON = new Gson();

    private GeminaWebhooks() {
    }

    /**
     * Verify a webhook's signature and timestamp, then parse it, with the default
     * tolerance (300 seconds) and the system clock. Pass the RAW request body exactly
     * as received: a re-serialised body will not verify.
     *
     * @param body    the request body as text; it is encoded as UTF-8
     * @param headers the request headers; names are matched ignoring ASCII case, and a
     *                header sent more than once is passed as its values joined with ", "
     * @param secret  the endpoint's signing secret, {@code whsec_...}
     * @throws GeminaWebhookVerificationException the delivery is not verified or cannot be
     *                                            parsed; {@code getReason()} says why
     */
    public static WebhookEvent unwrap(String body, Map<String, String> headers, String secret) {
        return unwrap(body, headers, secret, new WebhookOptions());
    }

    /** As {@link #unwrap(String, Map, String)}, with options. */
    public static WebhookEvent unwrap(String body, Map<String, String> headers, String secret, WebhookOptions options) {
        return verify((body == null ? "" : body).getBytes(StandardCharsets.UTF_8), headers, secret, options);
    }

    /** As {@link #unwrap(String, Map, String)}, for the body's bytes. They are copied: the array may be reused at once. */
    public static WebhookEvent unwrap(byte[] body, Map<String, String> headers, String secret) {
        return unwrap(body, headers, secret, new WebhookOptions());
    }

    /** As {@link #unwrap(byte[], Map, String)}, with options. */
    public static WebhookEvent unwrap(byte[] body, Map<String, String> headers, String secret, WebhookOptions options) {
        // One private copy: the caller may reuse or change its array at any time.
        return verify(body == null ? new byte[0] : body.clone(), headers, secret, options);
    }

    private static GeminaWebhookVerificationException fail(String reason, String message) {
        return new GeminaWebhookVerificationException(reason, message);
    }

    private static WebhookEvent verify(byte[] body, Map<String, String> headers, String secret, WebhookOptions options) {
        GeminaClient.installLenientJson();
        if (options == null) {
            options = new WebhookOptions();
        }

        String id = header(headers, "webhook-id");
        String timestampText = header(headers, "webhook-timestamp");
        String signatureHeader = header(headers, "webhook-signature");

        if (!TIMESTAMP.matcher(timestampText).matches()) {
            throw fail("invalid_timestamp", "The webhook-timestamp header is not a whole number of seconds.");
        }
        // At most 12 digits, so neither the parse nor the subtraction can overflow.
        long timestamp = Long.parseLong(timestampText);
        double clock = options.getNow().getAsDouble();
        // "!(x < limit)" is also true for NaN and infinity. A clock beyond 13 digits is out of
        // tolerance for any 12-digit timestamp, and refusing it here keeps the subtraction from overflowing.
        if (!(Math.abs(clock) < 1e13) || options.getToleranceSeconds() < 0) {
            throw fail("timestamp_out_of_tolerance",
                    "The clock or the tolerance is not usable, so the timestamp cannot be checked.");
        }
        long now = (long) Math.floor(clock);
        if (Math.abs(now - timestamp) > options.getToleranceSeconds()) {
            throw fail("timestamp_out_of_tolerance",
                    "The webhook timestamp is more than " + options.getToleranceSeconds()
                            + " seconds from the current time.");
        }

        String encodedKey = secret == null ? null
                : secret.startsWith(SECRET_PREFIX) ? secret.substring(SECRET_PREFIX.length()) : secret;
        byte[] key = decodeBase64(encodedKey);
        if (key == null || key.length == 0) {   // not set, not base64, or an empty key anyone could sign with
            throw fail("invalid_secret", "The signing secret is not valid: expected whsec_ followed by base64.");
        }

        byte[] expected;
        try {
            Mac mac = Mac.getInstance("HmacSHA256");
            mac.init(new SecretKeySpec(key, "HmacSHA256"));
            mac.update((id + "." + timestampText + ".").getBytes(StandardCharsets.UTF_8));
            expected = mac.doFinal(body);
        } catch (GeneralSecurityException e) {
            // HmacSHA256 is a required algorithm on every Java platform, and the key is non-empty.
            throw new GeminaWebhookVerificationException("invalid_secret",
                    "The signing secret cannot be used as an HMAC key.", e);
        }

        boolean matched = false;
        for (String entry : signatureHeader.split(" ")) {
            int comma = entry.indexOf(',');
            if (comma < 0 || !"v1".equals(entry.substring(0, comma))) {
                continue;
            }
            byte[] candidate = decodeBase64(entry.substring(comma + 1));
            // Constant time, and no early exit: the comparison count is independent of position.
            if (candidate != null && MessageDigest.isEqual(candidate, expected)) {
                matched = true;
            }
        }
        if (!matched) {
            throw fail("no_matching_signature", "No signature in the webhook-signature header matches.");
        }

        JsonObject parsed = parseBody(body);
        String type = stringOrNull(parsed.get("type"));
        JsonElement data = parsed.get("data");
        Object typed = data;
        if ("webhook.test".equals(type) || "extraction.completed".equals(type)) {
            typed = readKnownData(type, data);
        }
        return new WebhookEvent(id, type, stringOrNull(parsed.get("timestamp")), typed, parsed);
    }

    private static JsonObject parseBody(byte[] body) {
        // Gson silently skips a leading byte order mark, so it is refused here.
        if (body.length >= 3 && (body[0] & 0xFF) == 0xEF && (body[1] & 0xFF) == 0xBB && (body[2] & 0xFF) == 0xBF) {
            throw fail("invalid_body", "The webhook body starts with a byte order mark.");
        }
        JsonElement element;
        try {
            String text = StandardCharsets.UTF_8.newDecoder()
                    .onMalformedInput(CodingErrorAction.REPORT).onUnmappableCharacter(CodingErrorAction.REPORT)
                    .decode(ByteBuffer.wrap(body)).toString();
            // A strict reader, read through the adapter. JsonParser and Gson.fromJson both
            // switch the reader to lenient, which accepts NaN and other non-JSON.
            JsonReader reader = new JsonReader(new StringReader(text));
            reader.setLenient(false);
            element = GSON.getAdapter(JsonElement.class).read(reader);
            if (reader.peek() != JsonToken.END_DOCUMENT) {
                throw fail("invalid_body", "The webhook body holds more than one JSON value.");
            }
        } catch (IOException | JsonParseException | IllegalStateException e) {
            // CharacterCodingException and MalformedJsonException are IOExceptions.
            throw new GeminaWebhookVerificationException("invalid_body", "The webhook body is not valid JSON.", e);
        }
        if (element == null || !element.isJsonObject()) {
            throw fail("invalid_body", "The webhook body is not a JSON object.");
        }
        return element.getAsJsonObject();
    }

    private static Object readKnownData(String type, JsonElement data) {
        boolean test = "webhook.test".equals(type);
        JsonObject object = data != null && data.isJsonObject() ? data.getAsJsonObject() : null;
        boolean complete = object != null && (test
                ? isString(object.get("message"))
                : isString(object.get("correlationId")) && isString(object.get("status"))
                        && isBoolean(object.get("resultIncluded")) && isString(object.get("resultPath"))
                        && payloadIsWhole(object));
        if (!complete) {
            throw fail("invalid_body", "The data of this " + type + " event is missing a required field.");
        }
        try {
            // The generated fromJson is what polling uses (GeminaClient), with the lenient dates installed above.
            return test ? WebhookTestEventData.fromJson(object.toString())
                    : ExtractionCompletedEventData.fromJson(object.toString());
        } catch (IOException | RuntimeException e) {
            // The generated models document no exception set; the contract allows one type out.
            throw new GeminaWebhookVerificationException("invalid_body",
                    "The data of this " + type + " event could not be read.", e);
        }
    }

    // Header names are compared ignoring ASCII case only. String.equalsIgnoreCase folds
    // by Unicode rules, which match, for one, U+212A KELVIN SIGN against "k".
    private static boolean asciiEqualsIgnoreCase(String a, String b) {
        if (a.length() != b.length()) {
            return false;
        }
        for (int i = 0; i < a.length(); i++) {
            char x = a.charAt(i);
            char y = b.charAt(i);
            if (x >= 'A' && x <= 'Z') {
                x = (char) (x + 32);
            }
            if (y >= 'A' && y <= 'Z') {
                y = (char) (y + 32);
            }
            if (x != y) {
                return false;
            }
        }
        return true;
    }

    private static String header(Map<String, String> headers, String name) {
        String found = null;
        Map<String, String> entries = headers == null ? Collections.<String, String>emptyMap() : headers;
        for (Map.Entry<String, String> entry : entries.entrySet()) {
            if (entry.getKey() == null || entry.getValue() == null || !asciiEqualsIgnoreCase(entry.getKey(), name)) {
                continue;
            }
            // A repeat that an HTTP library already joined with ", " is split back into its parts.
            for (String part : entry.getValue().split(", ", -1)) {
                if (found == null) {
                    found = part;
                } else if (!found.equals(part)) {
                    throw fail("ambiguous_header", "The " + name + " header was sent more than once with different values.");
                }
            }
        }
        if (found == null) {
            throw fail("missing_header", "The " + name + " header is missing.");
        }
        return found;
    }

    private static byte[] decodeBase64(String text) {
        return text != null && BASE64.matcher(text).matches() ? Base64.getDecoder().decode(text) : null;
    }

    private static boolean isString(JsonElement element) {
        return element != null && element.isJsonPrimitive() && element.getAsJsonPrimitive().isString();
    }

    private static boolean isBoolean(JsonElement element) {
        return element != null && element.isJsonPrimitive() && element.getAsJsonPrimitive().isBoolean();
    }

    private static String stringOrNull(JsonElement element) {
        return isString(element) ? element.getAsString() : null;
    }

    private static boolean present(JsonElement element) {
        return element != null && !element.isJsonNull();
    }

    /** A result or an error that is set must hold its required fields, and the two are never both set. */
    private static boolean payloadIsWhole(JsonObject data) {
        JsonElement result = data.get("result");
        JsonElement error = data.get("error");
        if (present(result) && present(error)) {
            return false;
        }
        if (present(result)) {
            if (!result.isJsonObject()) {
                return false;
            }
            JsonObject whole = result.getAsJsonObject();
            JsonElement meta = whole.get("meta");
            if (!isString(whole.get("status")) || meta == null || !meta.isJsonObject() || !whole.has("data")) {
                return false;
            }
        }
        return !present(error) || (error.isJsonObject() && isString(error.getAsJsonObject().get("status")));
    }
}
