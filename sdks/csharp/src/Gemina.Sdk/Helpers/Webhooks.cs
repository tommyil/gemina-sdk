// Verify and parse an incoming Gemina webhook (HELPER_CONTRACT §6).
// Hand-written; lives outside Generated/. No network, no GeminaClient.
using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using Gemina.Sdk.Model;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;

namespace Gemina.Sdk
{
    /// <summary>A verified webhook, as returned by <see cref="GeminaWebhooks"/>.</summary>
    public sealed class WebhookEvent
    {
        /// <summary>The <c>webhook-id</c> header. The same on every retry: deduplicate on it.</summary>
        public string Id { get; internal set; }

        /// <summary><c>extraction.completed</c>, <c>webhook.test</c>, a type added later, or null when the body has no type.</summary>
        public string Type { get; internal set; }

        /// <summary>When the event was recorded, as sent; the same on every retry.</summary>
        public string Timestamp { get; internal set; }

        /// <summary>
        /// <see cref="ExtractionCompletedEventData"/> or <see cref="WebhookTestEventData"/> for the known
        /// types (narrow with <c>is</c>); the parsed <see cref="JToken"/> for any other type.
        /// </summary>
        public object Data { get; internal set; }

        /// <summary>The whole parsed body.</summary>
        public JObject Raw { get; internal set; }
    }

    /// <summary>Options for <see cref="GeminaWebhooks"/>.</summary>
    public sealed class WebhookOptions
    {
        /// <summary>Maximum distance in seconds between the clock and the webhook timestamp. Default 300.</summary>
        public int ToleranceSeconds { get; set; } = 300;

        /// <summary>Clock in seconds since the epoch; may return a fraction. Injectable for tests.</summary>
        public Func<double> Now { get; set; } = SystemClock;

        private static double SystemClock() => DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() / 1000.0;

        internal double ReadClock() => (Now ?? SystemClock)();
    }

    /// <summary>Verifies and parses incoming Gemina webhooks (Standard Webhooks v1).</summary>
    public static class GeminaWebhooks
    {
        private const string SecretPrefix = "whsec_";
        private const string ExtractionCompleted = "extraction.completed";
        private const string WebhookTest = "webhook.test";

        // Each known event type: the generated model its data is read as, and the fields that data must hold.
        private static readonly Dictionary<string, KnownEvent> Known = new Dictionary<string, KnownEvent>(StringComparer.Ordinal)
        {
            [ExtractionCompleted] = new KnownEvent(typeof(ExtractionCompletedEventData), new Dictionary<string, JTokenType>
            {
                ["correlationId"] = JTokenType.String,
                ["status"] = JTokenType.String,
                ["resultIncluded"] = JTokenType.Boolean,
                ["resultPath"] = JTokenType.String,
            }),
            [WebhookTest] = new KnownEvent(typeof(WebhookTestEventData), new Dictionary<string, JTokenType>
            {
                ["message"] = JTokenType.String,
            }),
        };

        // Standard alphabet, padded, no whitespace. \z, not $: $ also matches before a final newline.
        private static readonly Regex Base64 = new Regex(
            @"^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?\z", RegexOptions.CultureInvariant);

        /// <summary>
        /// Verify a webhook's signature and timestamp, then parse it. Pass the RAW
        /// request body exactly as received: a re-serialised body will not verify.
        /// </summary>
        /// <param name="body">The request body as text; it is encoded as UTF-8.</param>
        /// <param name="headers">
        /// The request headers, one entry per value. Names are matched ignoring ASCII case;
        /// a value may hold several values joined with ", ".
        /// </param>
        /// <param name="secret">The endpoint's signing secret, <c>whsec_...</c>.</param>
        /// <param name="options">Tolerance and clock; null for the defaults.</param>
        /// <exception cref="GeminaWebhookVerificationException">
        /// The delivery is not verified or cannot be parsed; <c>Reason</c> says why.
        /// </exception>
        public static WebhookEvent Unwrap(string body, IEnumerable<KeyValuePair<string, string>> headers,
                                          string secret, WebhookOptions options = null)
            => Verify(Encoding.UTF8.GetBytes(body ?? string.Empty), headers, secret, options);

        /// <summary>
        /// Verify a webhook's signature and timestamp, then parse it. Pass the RAW
        /// request body exactly as received: a re-serialised body will not verify.
        /// </summary>
        /// <param name="body">The request body bytes. They are copied: the array may be reused at once.</param>
        /// <param name="headers">
        /// The request headers, one entry per value. Names are matched ignoring ASCII case;
        /// a value may hold several values joined with ", ".
        /// </param>
        /// <param name="secret">The endpoint's signing secret, <c>whsec_...</c>.</param>
        /// <param name="options">Tolerance and clock; null for the defaults.</param>
        /// <exception cref="GeminaWebhookVerificationException">
        /// The delivery is not verified or cannot be parsed; <c>Reason</c> says why.
        /// </exception>
        public static WebhookEvent Unwrap(byte[] body, IEnumerable<KeyValuePair<string, string>> headers,
                                          string secret, WebhookOptions options = null)
            // One private copy: the caller may reuse or change its array at any time.
            => Verify((byte[])(body ?? new byte[0]).Clone(), headers, secret, options);

        private static GeminaWebhookVerificationException Fail(string reason, string message)
            => new GeminaWebhookVerificationException(reason, message);

        // Header names are compared ignoring ASCII case only, as the contract says.
        // OrdinalIgnoreCase folds non-ASCII letters by the runtime's own tables, which
        // differ between .NET Framework and .NET; this gives one answer everywhere.
        private static bool AsciiEqualsIgnoreCase(string a, string b)
        {
            if (a.Length != b.Length) return false;
            for (var i = 0; i < a.Length; i++)
            {
                var x = a[i] >= 'A' && a[i] <= 'Z' ? (char)(a[i] + 32) : a[i];
                var y = b[i] >= 'A' && b[i] <= 'Z' ? (char)(b[i] + 32) : b[i];
                if (x != y) return false;
            }
            return true;
        }

        private static string Header(IReadOnlyList<KeyValuePair<string, string>> headers, string name)
        {
            string found = null;
            foreach (var pair in headers)
            {
                if (pair.Key == null || pair.Value == null || !AsciiEqualsIgnoreCase(pair.Key, name)) continue;
                // A repeat that an HTTP library already joined with ", " is split back into its parts.
                foreach (var part in pair.Value.Split(new[] { ", " }, StringSplitOptions.None))
                {
                    if (found == null) found = part;
                    else if (!string.Equals(found, part, StringComparison.Ordinal))
                        throw Fail(GeminaWebhookVerificationReason.AmbiguousHeader, $"The {name} header was sent more than once with different values.");
                }
            }
            return found ?? throw Fail(GeminaWebhookVerificationReason.MissingHeader, $"The {name} header is missing.");
        }

        private static byte[] DecodeBase64(string text)
            => text != null && Base64.IsMatch(text) ? Convert.FromBase64String(text) : null;

        private static bool IsTimestamp(string text)
        {
            if (text.Length < 1 || text.Length > 12) return false;
            foreach (var character in text) if (character < '0' || character > '9') return false;
            return true;
        }

        private static WebhookEvent Verify(byte[] body, IEnumerable<KeyValuePair<string, string>> headers,
                                           string secret, WebhookOptions options)
        {
            options = options ?? new WebhookOptions();
            // Read the caller's sequence once: it may be one that can only be read once.
            var headerList = (headers ?? Enumerable.Empty<KeyValuePair<string, string>>()).ToList();
            var id = Header(headerList, "webhook-id");
            var timestampText = Header(headerList, "webhook-timestamp");
            var signatureHeader = Header(headerList, "webhook-signature");

            if (!IsTimestamp(timestampText))
                throw Fail(GeminaWebhookVerificationReason.InvalidTimestamp, "The webhook-timestamp header is not a whole number of seconds.");
            // At most 12 digits, so neither the parse nor the subtraction can overflow.
            var timestamp = long.Parse(timestampText, NumberStyles.None, CultureInfo.InvariantCulture);
            var clock = options.ReadClock();
            // "!(x < limit)" is also true for NaN and infinity. A clock beyond 13 digits is out of
            // tolerance for any 12-digit timestamp, and refusing it here keeps the cast to long defined.
            if (!(Math.Abs(clock) < 1e13) || options.ToleranceSeconds < 0)
                throw Fail(GeminaWebhookVerificationReason.TimestampOutOfTolerance,
                    "The clock or the tolerance is not usable, so the timestamp cannot be checked.");
            var now = (long)Math.Floor(clock);
            if (Math.Abs(now - timestamp) > options.ToleranceSeconds)
                throw Fail(GeminaWebhookVerificationReason.TimestampOutOfTolerance,
                    $"The webhook timestamp is more than {options.ToleranceSeconds} seconds from the current time.");

            secret = secret ?? string.Empty;
            var key = DecodeBase64(secret.StartsWith(SecretPrefix, StringComparison.Ordinal)
                ? secret.Substring(SecretPrefix.Length) : secret);
            if (key == null || key.Length == 0)   // not set, not base64, or an empty key anyone could sign with
                throw Fail(GeminaWebhookVerificationReason.InvalidSecret, "The signing secret is not valid: expected whsec_ followed by base64.");

            var prefix = Encoding.UTF8.GetBytes($"{id}.{timestampText}.");
            var signed = new byte[prefix.Length + body.Length];
            Buffer.BlockCopy(prefix, 0, signed, 0, prefix.Length);
            Buffer.BlockCopy(body, 0, signed, prefix.Length, body.Length);

            byte[] expected;
            using (var hmac = new HMACSHA256(key)) expected = hmac.ComputeHash(signed);

            var matched = false;
            foreach (var entry in signatureHeader.Split(' '))
            {
                var comma = entry.IndexOf(',');
                if (comma < 0 || entry.Substring(0, comma) != "v1") continue;
                var candidate = DecodeBase64(entry.Substring(comma + 1));
                // No early exit: keep the comparison count independent of position.
                if (candidate != null && ConstantTimeEquals(candidate, expected)) matched = true;
            }
            if (!matched)
                throw Fail(GeminaWebhookVerificationReason.NoMatchingSignature, "No signature in the webhook-signature header matches.");

            var parsed = ParseBody(body);

            var type = parsed["type"]?.Type == JTokenType.String ? (string)parsed["type"] : null;
            var timestampField = parsed["timestamp"]?.Type == JTokenType.String ? (string)parsed["timestamp"] : null;
            object data = parsed["data"];
            if (type != null && Known.TryGetValue(type, out var known))
                data = ReadKnownData(type, known, parsed["data"] as JObject);

            return new WebhookEvent { Id = id, Type = type, Timestamp = timestampField, Data = data, Raw = parsed };
        }

        private static JObject ParseBody(byte[] body)
        {
            if (body.Length >= 3 && body[0] == 0xEF && body[1] == 0xBB && body[2] == 0xBF)
                throw Fail(GeminaWebhookVerificationReason.InvalidBody, "The webhook body starts with a byte order mark.");
            JObject parsed;
            try
            {
                // Strict UTF-8, and no date re-interpretation of the raw tree.
                var text = new UTF8Encoding(false, true).GetString(body);
                using (var reader = new JsonTextReader(new StringReader(text)) { DateParseHandling = DateParseHandling.None })
                {
                    parsed = JToken.ReadFrom(reader) as JObject;
                    // Reading on past the first value throws if anything but a comment follows it.
                    while (reader.Read()) { }
                }
            }
            catch (Exception ex) when (ex is JsonException || ex is ArgumentException)   // DecoderFallbackException is an ArgumentException
            {
                throw new GeminaWebhookVerificationException(GeminaWebhookVerificationReason.InvalidBody, "The webhook body is not valid JSON.", ex);
            }
            if (parsed == null)
                throw Fail(GeminaWebhookVerificationReason.InvalidBody, "The webhook body is not a JSON object.");
            // Newtonsoft reads NaN and Infinity as numbers. JSON has neither.
            foreach (var value in parsed.Descendants().OfType<JValue>())
                if (value.Type == JTokenType.Float && (double.IsNaN((double)value) || double.IsInfinity((double)value)))
                    throw Fail(GeminaWebhookVerificationReason.InvalidBody, "The webhook body is not valid JSON.");
            return parsed;
        }

        private static object ReadKnownData(string type, KnownEvent known, JObject data)
        {
            var complete = data != null && known.Required.All(field => Is(data, field.Key, field.Value))
                           && (type != ExtractionCompleted || PayloadIsWhole(data));
            if (!complete)
                throw Fail(GeminaWebhookVerificationReason.InvalidBody, $"The data of this {type} event is missing a required field.");

            // The SAME reader the polling path uses (DocumentTransport): JSON TEXT in, with its
            // settings. Not data.ToObject(...): the tree was read with DateParseHandling.None so that
            // Raw keeps every string as it was sent, and converting from that tree would leave an ISO
            // timestamp inside a custom extraction's `values` (a Dictionary<string, object>) as a
            // string, where polling the same result gives a DateTime. Writing the tokens back to text
            // changes no value; reading that text is exactly what polling does.
            var dataJson = data.ToString(Formatting.None);
            object typed;
            try
            {
                typed = JsonConvert.DeserializeObject(dataJson, known.Model, DocumentTransport.SerializerSettings);
            }
            catch (Exception ex)   // the generated models document no exception set; the contract allows one type out
            {
                throw new GeminaWebhookVerificationException(GeminaWebhookVerificationReason.InvalidBody, $"The data of this {type} event could not be read.", ex);
            }
            return typed ?? throw Fail(GeminaWebhookVerificationReason.InvalidBody, $"The data of this {type} event could not be read.");
        }

        private static bool Is(JObject data, string field, JTokenType kind) => data[field]?.Type == kind;

        private static JToken Present(JToken token) => token == null || token.Type == JTokenType.Null ? null : token;

        // A result or an error that is set must hold its required fields, and the two are never both set.
        private static bool PayloadIsWhole(JObject data)
        {
            var result = Present(data["result"]);
            var error = Present(data["error"]);
            if (result != null && error != null) return false;
            if (result != null)
            {
                var whole = result as JObject;
                if (whole == null || !Is(whole, "status", JTokenType.String)
                    || !(whole["meta"] is JObject) || whole.Property("data") == null) return false;
            }
            var envelope = error as JObject;
            return error == null || (envelope != null && Is(envelope, "status", JTokenType.String));
        }

        private sealed class KnownEvent
        {
            internal KnownEvent(Type model, Dictionary<string, JTokenType> required)
            {
                Model = model;
                Required = required;
            }

            internal Type Model { get; }

            internal Dictionary<string, JTokenType> Required { get; }
        }

        // netstandard2.0 has no CryptographicOperations.FixedTimeEquals.
        private static bool ConstantTimeEquals(byte[] a, byte[] b)
        {
            if (a.Length != b.Length) return false;
            var difference = 0;
            for (var i = 0; i < a.Length; i++) difference |= a[i] ^ b[i];
            return difference == 0;
        }
    }
}
