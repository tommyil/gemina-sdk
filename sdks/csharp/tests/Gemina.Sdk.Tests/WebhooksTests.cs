using System;
using System.Collections;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Security.Cryptography;
using System.Text;
using Gemina.Sdk.Model;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;
using Xunit;

namespace Gemina.Sdk.Tests
{
    /// <summary>
    /// GeminaWebhooks.Unwrap against the shared vectors (contract §6).
    /// Mirrors sdks/python/tests/test_webhooks.py case for case.
    /// </summary>
    public class WebhooksTests
    {
        public sealed class Vector
        {
            public string Name;
            public string Secret;
            public double Now;
            /// <summary>One entry per JSON property: two names that differ only in case stay two entries.</summary>
            public List<KeyValuePair<string, string>> Headers;
            public string Body;
            public string ExpectType;
            public string Reason;

            public override string ToString() => Name;
        }

        private static readonly (List<Vector> Valid, List<Vector> Invalid) Shared = Load("webhook_test_vectors.json");
        private static readonly (List<Vector> Valid, List<Vector> Invalid) Typed = Load("webhook_typed_vectors.json");

        private static string TestData(string name)
        {
            var dir = new DirectoryInfo(AppContext.BaseDirectory);
            while (dir != null && !Directory.Exists(Path.Combine(dir.FullName, "testdata"))) dir = dir.Parent;
            return Path.Combine(dir!.FullName, "testdata", name);
        }

        private static (List<Vector>, List<Vector>) Load(string name)
        {
            JObject file;
            using (var reader = new JsonTextReader(new StringReader(File.ReadAllText(TestData(name), Encoding.UTF8)))
                   { DateParseHandling = DateParseHandling.None })
            {
                file = JObject.Load(reader);
            }
            List<Vector> Read(string key) => file[key].Select(v => new Vector
            {
                Name = (string)v["name"],
                Secret = (string)v["secret"],
                Now = (double)v["now"],
                Headers = ((JObject)v["headers"]).Properties()
                    .Select(p => new KeyValuePair<string, string>(p.Name, (string)p.Value)).ToList(),
                Body = (string)v["body"],
                ExpectType = v["expectType"]?.Type == JTokenType.String ? (string)v["expectType"] : null,
                Reason = (string)v["reason"],
            }).ToList();
            return (Read("valid"), Read("invalid"));
        }

        public static IEnumerable<object[]> ValidVectors() => Shared.Valid.Concat(Typed.Valid).Select(v => new object[] { v });
        public static IEnumerable<object[]> InvalidVectors() => Shared.Invalid.Concat(Typed.Invalid).Select(v => new object[] { v });

        private static Vector Named(IEnumerable<Vector> list, string name) => list.Single(v => v.Name == name);
        private static Vector Utf8 => Named(Shared.Valid, "extraction-completed-utf8-body");
        private static readonly string OtherSignature = "v1," + Convert.ToBase64String(new byte[32]);

        /// <summary>Unwrap with the vector's clock (and, when given, another tolerance).</summary>
        private static WebhookEvent Unwrap(Vector v, IEnumerable<KeyValuePair<string, string>> headers = null, int toleranceSeconds = 300)
            => GeminaWebhooks.Unwrap(v.Body, headers ?? v.Headers, v.Secret,
                new WebhookOptions { Now = () => v.Now, ToleranceSeconds = toleranceSeconds });

        private static string ReasonOf(Action call)
        {
            var error = Assert.ThrowsAny<GeminaWebhookVerificationException>(call);
            Assert.IsAssignableFrom<GeminaException>(error);
            return error.Reason;
        }

        private static List<KeyValuePair<string, string>> With(IEnumerable<KeyValuePair<string, string>> headers, string name, string value)
            => headers.Where(h => h.Key != name).Append(new KeyValuePair<string, string>(name, value)).ToList();

        /// <summary>The vector's headers, re-signed for other body bytes (for bodies JSON text cannot carry).</summary>
        private static List<KeyValuePair<string, string>> Signed(Vector v, byte[] body)
        {
            var headers = v.Headers.ToDictionary(h => h.Key.ToLowerInvariant(), h => h.Value);
            var key = Convert.FromBase64String(v.Secret.Substring("whsec_".Length));
            var prefix = Encoding.UTF8.GetBytes($"{headers["webhook-id"]}.{headers["webhook-timestamp"]}.");
            using (var hmac = new HMACSHA256(key))
            {
                headers["webhook-signature"] = "v1," + Convert.ToBase64String(hmac.ComputeHash(prefix.Concat(body).ToArray()));
            }
            return headers.ToList();
        }

        [Fact]
        public void EveryVectorIsLoaded()
        {
            // A truncated or mis-copied file would otherwise shrink the theories silently.
            Assert.Equal((12, 30), (Shared.Valid.Count, Shared.Invalid.Count));
            Assert.Equal((3, 3), (Typed.Valid.Count, Typed.Invalid.Count));
        }

        [Theory]
        [MemberData(nameof(ValidVectors))]
        public void ValidVectorsVerify(Vector v)
        {
            var webhook = Unwrap(v);
            Assert.Equal(v.ExpectType, webhook.Type);
            // The id header specifically: "one of the header values" would also pass for the timestamp.
            Assert.Equal(v.Headers.First(h => h.Key.ToLowerInvariant() == "webhook-id").Value, webhook.Id);
        }

        [Theory]
        [MemberData(nameof(InvalidVectors))]
        public void InvalidVectorsAreRejectedWithTheExactReason(Vector v)
        {
            Assert.Equal(v.Reason, ReasonOf(() => Unwrap(v)));
        }

        [Fact]
        public void BytesAndStringBodiesAreEquivalent()
        {
            var v = Utf8;
            var asBytes = GeminaWebhooks.Unwrap(Encoding.UTF8.GetBytes(v.Body), v.Headers, v.Secret, new WebhookOptions { Now = () => v.Now });
            Assert.True(JToken.DeepEquals(asBytes.Raw, Unwrap(v).Raw));
        }

        [Fact]
        public void AllFourCallFormsExist()
        {
            var v = Named(Shared.Invalid, "timestamp-too-old");   // so that the default clock and tolerance both matter
            var bytes = Encoding.UTF8.GetBytes(v.Body);
            Assert.Equal("timestamp_out_of_tolerance", ReasonOf(() => GeminaWebhooks.Unwrap(v.Body, v.Headers, v.Secret)));
            Assert.Equal("timestamp_out_of_tolerance", ReasonOf(() => GeminaWebhooks.Unwrap(bytes, v.Headers, v.Secret)));
            var options = new WebhookOptions { Now = () => v.Now, ToleranceSeconds = 600 };
            Assert.Equal("extraction.completed", GeminaWebhooks.Unwrap(v.Body, v.Headers, v.Secret, options).Type);
            Assert.Equal("extraction.completed", GeminaWebhooks.Unwrap(bytes, v.Headers, v.Secret, options).Type);
        }

        [Fact]
        public void ExtractionCompletedDataIsTyped()
        {
            var webhook = Unwrap(Utf8);
            Assert.True(webhook.Data is ExtractionCompletedEventData);
            var data = (ExtractionCompletedEventData)webhook.Data;
            Assert.Equal(Guid.Parse("3f2b6c1e-0d4a-4a57-9a43-1f0e5a7b9c10"), data.CorrelationId);
            Assert.Equal("חשבונית-2291", data.ExternalId);
            Assert.False(data.ResultIncluded);
            Assert.Null(data.Result);
            // The raw tree is read with DateParseHandling.None: the timestamp is the text that was sent.
            Assert.Contains("\"timestamp\":\"2026-11-18T10:15:30Z\"", Utf8.Body);
            Assert.Equal("2026-11-18T10:15:30Z", webhook.Timestamp);
        }

        [Fact]
        public void AnIncludedResultIsParsedLikeThePollingPathParsesIt()
        {
            var webhook = Unwrap(Named(Typed.Valid, "extraction-completed-with-result"));
            var data = Assert.IsType<ExtractionCompletedEventData>(webhook.Data);
            Assert.Null(data.Error);
            // The wire values, which every language asserts the same way:
            var wireMeta = (JObject)webhook.Raw["data"]["result"]["data"]["extractions"][0]["meta"];
            Assert.Equal(JTokenType.Null, wireMeta["purgeReason"].Type);
            Assert.Equal(JTokenType.String, wireMeta["purgeAt"].Type);
            Assert.Equal("2026-08-03T17:20:13.180624", (string)wireMeta["purgeAt"]);
            // The typed side: what the polling path's reader gives for the same JSON. PurgeReason is a
            // generated enum that cannot be null, so it is compared, not asserted null.
            var polled = DocumentTransport.HandleResponse(200, webhook.Raw["data"]["result"].ToString(Formatting.None), "test");
            var meta = data.Result.Data.Extractions[0].Meta;
            Assert.Equal(polled.Data.Extractions[0].Meta.PurgeReason, meta.PurgeReason);
            Assert.Equal(polled.Data.Extractions[0].Meta.PurgeAt, meta.PurgeAt);
            Assert.Equal(Guid.Parse("28677df7-033a-409f-8b70-1568ddd17ea0"), data.Result.Meta.DocumentId);
        }

        [Fact]
        public void ATimestampInsideFreeFormValuesIsReadAsThePollingPathReadsIt()
        {
            // `values` is a Dictionary<string, object>: the one place where a reader that keeps strings
            // and a reader that parses dates would differ.
            var v = Named(Typed.Valid, "extraction-completed-with-result");
            var body = JObject.Parse(v.Body);
            body["data"]["result"]["data"]["extractions"][0]["values"]["issued"] = "2026-11-18T09:30:00Z";
            var bytes = Encoding.UTF8.GetBytes(body.ToString(Formatting.None));

            var webhook = GeminaWebhooks.Unwrap(bytes, Signed(v, bytes), v.Secret, new WebhookOptions { Now = () => v.Now });

            var typed = ((ExtractionCompletedEventData)webhook.Data).Result.Data.Extractions[0].Values["issued"];
            var polled = DocumentTransport.HandleResponse(200, webhook.Raw["data"]["result"].ToString(Formatting.None), "test")
                .Data.Extractions[0].Values["issued"];
            Assert.IsType<DateTime>(polled);
            Assert.Equal(polled.GetType(), typed.GetType());
            Assert.Equal(polled, typed);
            Assert.Equal("2026-11-18T09:30:00Z", (string)webhook.Raw["data"]["result"]["data"]["extractions"][0]["values"]["issued"]);
        }

        [Fact]
        public void AnEnumValueAddedToTheApiLaterReadsAsUnknownLikePolling()
        {
            var webhook = Unwrap(Named(Typed.Valid, "extraction-completed-with-unknown-enum-values"));
            var result = Assert.IsType<ExtractionCompletedEventData>(webhook.Data).Result;
            Assert.Equal(ResponseStatus.UnknownDefaultOpenApi, result.Status);
            Assert.Equal(ModelType.UnknownDefaultOpenApi, result.Data.Extractions[0].Meta.ModelType);
            var raw = webhook.Raw["data"]["result"];               // the value that was sent stays in Raw
            Assert.Equal("queued", (string)raw["status"]);
            Assert.Equal("nova", (string)raw["data"]["extractions"][0]["meta"]["modelType"]);
            var polled = DocumentTransport.HandleResponse(200, raw.ToString(Formatting.None), "test");
            Assert.Equal(polled.Status, result.Status);
            Assert.Equal(polled.Data.Extractions[0].Meta.ModelType, result.Data.Extractions[0].Meta.ModelType);
        }

        [Theory]
        [InlineData("42")]
        [InlineData("{}")]
        [InlineData("[]")]
        public void OnlyAnUnknownStringReadsAsUnknownAnythingElseIsStillRefused(string modelType)
        {
            var v = Named(Typed.Valid, "extraction-completed-with-unknown-enum-values");
            var body = JObject.Parse(v.Body);
            body["data"]["result"]["data"]["extractions"][0]["meta"]["modelType"] = JToken.Parse(modelType);
            var bytes = Encoding.UTF8.GetBytes(body.ToString(Formatting.None));
            Assert.Equal("invalid_body", ReasonOf(() =>
                GeminaWebhooks.Unwrap(bytes, Signed(v, bytes), v.Secret, new WebhookOptions { Now = () => v.Now })));
            // The polling reader refuses it too.
            Assert.ThrowsAny<JsonException>(() =>
                DocumentTransport.HandleResponse(200, body["data"]["result"].ToString(Formatting.None), "test"));
        }

        [Fact]
        public void AnInlineEnumRefusesANumber()
        {
            var v = Named(Typed.Valid, "extraction-completed-with-unknown-enum-values");
            var body = JObject.Parse(v.Body);
            body["data"]["result"]["data"]["extractions"][0]["verifiedDiff"] = JArray.Parse("[{\"field\":\"totalAmount\",\"status\":42}]");
            var bytes = Encoding.UTF8.GetBytes(body.ToString(Formatting.None));
            Assert.Equal("invalid_body", ReasonOf(() =>
                GeminaWebhooks.Unwrap(bytes, Signed(v, bytes), v.Secret, new WebhookOptions { Now = () => v.Now })));
        }

        [Fact]
        public void AnErrorEnvelopeIsTyped()
        {
            var data = Assert.IsType<ExtractionCompletedEventData>(Unwrap(Named(Typed.Valid, "extraction-completed-with-error")).Data);
            Assert.Null(data.Result);
            Assert.Equal("failed", data.Status);
            Assert.Equal("PROCESSING_ERROR", data.Error.Errors[0]["error_code"].ToString());
        }

        [Fact]
        public void TheTestEventMessageIsTyped()
        {
            var webhook = Unwrap(Named(Shared.Valid, "test-event"));
            if (webhook.Data is WebhookTestEventData test)
            {
                Assert.Equal("This is a test event from Gemina.", test.Message);
            }
            else
            {
                Assert.Fail("expected WebhookTestEventData");
            }
        }

        [Fact]
        public void AnUnknownEventTypeKeepsItsTypeAndItsData()
        {
            var webhook = Unwrap(Named(Shared.Valid, "unknown-future-event-type"));
            Assert.Equal("invoice.archived", webhook.Type);
            Assert.True(JToken.DeepEquals(
                JObject.Parse("{\"documentId\":\"9b1d4f0a-6c2e-4d8b-8f31-5a7c0e2b4d66\",\"nested\":{\"n\":1}}"), (JToken)webhook.Data));
        }

        [Fact]
        public void ABodyWithNoTypeIsReturnedRaw()
        {
            var webhook = Unwrap(Named(Shared.Valid, "standard-webhooks-published-example"));
            Assert.Null(webhook.Type);
            Assert.True(JToken.DeepEquals(JObject.Parse("{\"test\":2432232314}"), webhook.Raw));
        }

        [Fact]
        public void ACustomToleranceIsHonoured()
        {
            Assert.Equal("extraction.completed", Unwrap(Named(Shared.Invalid, "timestamp-too-old"), toleranceSeconds: 600).Type);
        }

        [Fact]
        public void TheCallersBufferIsCopiedBeforeAnythingElseReadsIt()
        {
            // The clock runs after the copy and before the HMAC: overwriting the array from inside it
            // fails any helper that signs or parses the caller's array. Overwriting after the call
            // returns would pass even with no copy at all.
            var v = Utf8;
            var buffer = Encoding.UTF8.GetBytes(v.Body);
            var webhook = GeminaWebhooks.Unwrap(buffer, v.Headers, v.Secret, new WebhookOptions
            {
                Now = () =>
                {
                    for (var i = 0; i < buffer.Length; i++) buffer[i] = (byte)'x';
                    return v.Now;
                },
            });
            Assert.Equal("extraction.completed", webhook.Type);
        }

        [Theory]
        [InlineData("webhook-id", "Webhook-Id")]
        [InlineData("Webhook-Id", "webhook-id")]
        public void ARepeatedHeaderIsJudgedTheSameInEitherOrder(string first, string second)
        {
            var v = Utf8;
            var real = v.Headers.Single(h => h.Key == "webhook-id").Value;
            var rest = v.Headers.Where(h => h.Key != "webhook-id").ToList();
            List<KeyValuePair<string, string>> Headers(string other) => new[]
            {
                new KeyValuePair<string, string>(first, real), new KeyValuePair<string, string>(second, other),
            }.Concat(rest).ToList();
            Assert.Equal(real, Unwrap(v, Headers(real)).Id);
            Assert.Equal("ambiguous_header", ReasonOf(() => Unwrap(v, Headers("evt_other"))));
        }

        [Fact]
        public void ARepeatedHeaderThatALibraryAlreadyJoinedIsJudgedTheSame()
        {
            var v = Utf8;
            var signature = v.Headers.Single(h => h.Key == "webhook-signature").Value;
            Assert.Equal("extraction.completed", Unwrap(v, With(v.Headers, "webhook-signature", $"{signature}, {signature}")).Type);
            foreach (var joined in new[] { $"{OtherSignature}, {signature}", $"{signature}, {OtherSignature}" })
            {
                Assert.Equal("ambiguous_header", ReasonOf(() => Unwrap(v, With(v.Headers, "webhook-signature", joined))));
            }
        }

        private sealed class ReadOnce : IEnumerable<KeyValuePair<string, string>>
        {
            private readonly IEnumerable<KeyValuePair<string, string>> _inner;
            private bool _read;
            public ReadOnce(IEnumerable<KeyValuePair<string, string>> inner) => _inner = inner;

            public IEnumerator<KeyValuePair<string, string>> GetEnumerator()
            {
                if (_read) throw new InvalidOperationException("this sequence can be read only once");
                _read = true;
                return _inner.GetEnumerator();
            }

            IEnumerator IEnumerable.GetEnumerator() => GetEnumerator();
        }

        [Fact]
        public void AHeaderSequenceThatCanBeReadOnlyOnceStillVerifies()
        {
            Assert.Equal("extraction.completed", Unwrap(Utf8, new ReadOnce(Utf8.Headers)).Type);
        }

        [Theory]
        [InlineData("webhoo\u212A-id")]   // KELVIN SIGN: lower-cases to "k" under Unicode rules
        [InlineData("webhook-\u0131d")]   // DOTLESS I: upper-cases to "I" under Unicode rules
        public void HeaderNamesAreFoldedByAsciiCaseOnly(string lookalike)
        {
            var v = Utf8;
            var headers = v.Headers.Select(h => h.Key == "webhook-id" ? new KeyValuePair<string, string>(lookalike, h.Value) : h).ToList();
            Assert.Equal("missing_header", ReasonOf(() => Unwrap(v, headers)));
        }

        [Theory]
        [InlineData(-1, 0.0)]                      // a negative tolerance, with the vector's own clock
        [InlineData(300, double.NaN)]
        [InlineData(300, double.PositiveInfinity)]
        [InlineData(300, double.NegativeInfinity)]
        public void AClockOrToleranceThatIsNotUsableNeverSwitchesTheCheckOff(int toleranceSeconds, double clock)
        {
            // An expired delivery, correctly signed. NaN makes "difference > tolerance" false: it must not pass.
            var v = Named(Shared.Invalid, "timestamp-too-old");
            var options = new WebhookOptions { ToleranceSeconds = toleranceSeconds, Now = () => clock == 0.0 ? v.Now : clock };
            Assert.Equal("timestamp_out_of_tolerance", ReasonOf(() => GeminaWebhooks.Unwrap(v.Body, v.Headers, v.Secret, options)));
        }

        [Fact]
        public void TextThatIsNotWellFormedVerifiesTheSubstitutedBytes()
        {
            // Encoding.UTF8 replaces an unpaired surrogate, so the signature no longer matches.
            var v = Utf8;
            Assert.Equal("no_matching_signature",
                ReasonOf(() => GeminaWebhooks.Unwrap(v.Body + "\ud800", v.Headers, v.Secret, new WebhookOptions { Now = () => v.Now })));
        }

        [Fact]
        public void ASignedBodyThatIsNotUtf8IsRejected()
        {
            var v = Utf8;
            var body = Encoding.ASCII.GetBytes("{\"type\":\"extraction.completed\",\"data\":\"").Concat(new byte[] { 0xFF, 0x22, 0x7D }).ToArray();
            Assert.Equal("invalid_body",
                ReasonOf(() => GeminaWebhooks.Unwrap(body, Signed(v, body), v.Secret, new WebhookOptions { Now = () => v.Now })));
        }

        [Fact]
        public void AnUnsetSecretIsAnInvalidSecret()
        {
            // Environment.GetEnvironmentVariable returns null when the variable is not set.
            var v = Utf8;
            Assert.Equal("invalid_secret",
                ReasonOf(() => GeminaWebhooks.Unwrap(v.Body, v.Headers, null, new WebhookOptions { Now = () => v.Now })));
        }

        [Fact]
        public void OnlyTheVerificationErrorEverLeavesTheHelper()
        {
            var v = Utf8;
            var cases = new List<IEnumerable<KeyValuePair<string, string>>>
            {
                null,
                new List<KeyValuePair<string, string>>(),
                new[] { new KeyValuePair<string, string>("webhook-id", null) },
                new[] { new KeyValuePair<string, string>("webhook-timestamp", new string('9', 400)) },
            };
            foreach (var headers in cases)
            {
                ReasonOf(() => GeminaWebhooks.Unwrap(v.Body, headers, v.Secret));
            }
            ReasonOf(() => GeminaWebhooks.Unwrap((string)null, v.Headers, v.Secret, new WebhookOptions { Now = () => v.Now }));
            ReasonOf(() => GeminaWebhooks.Unwrap((byte[])null, v.Headers, v.Secret, new WebhookOptions { Now = () => v.Now }));
        }

        [Fact]
        public void TheReasonConstantsNameEveryReasonTheVectorsAssert()
        {
            // The body, header, clock and tolerance parameters are typed, so the wrong-typed inputs
            // the other languages refuse at run time do not compile here.
            var constants = typeof(GeminaWebhookVerificationReason)
                .GetFields(BindingFlags.Public | BindingFlags.Static)
                .Where(field => field.IsLiteral)
                .Select(field => (string)field.GetRawConstantValue())
                .OrderBy(reason => reason, StringComparer.Ordinal);
            var reasons = Shared.Invalid.Concat(Typed.Invalid)
                .Select(v => v.Reason)
                .Distinct()
                .OrderBy(reason => reason, StringComparer.Ordinal);
            Assert.Equal(reasons, constants);
        }
    }
}
