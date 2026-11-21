using System;
using Gemina.Sdk.Model;

namespace Gemina.Sdk
{
    /// <summary>
    /// Base exception for errors raised by the hand-written Gemina helper
    /// layer. Transport/HTTP errors from the generated client
    /// (<see cref="Gemina.Sdk.Client.ApiException"/>) pass through unwrapped.
    /// </summary>
    public class GeminaException : Exception
    {
        /// <summary>Initializes a new instance of the <see cref="GeminaException"/> class.</summary>
        public GeminaException()
        {
        }

        /// <summary>Initializes a new instance with a message.</summary>
        /// <param name="message">The error message.</param>
        public GeminaException(string message)
            : base(message)
        {
        }

        /// <summary>Initializes a new instance with a message and inner exception.</summary>
        /// <param name="message">The error message.</param>
        /// <param name="innerException">The underlying cause.</param>
        public GeminaException(string message, Exception innerException)
            : base(message, innerException)
        {
        }
    }

    /// <summary>
    /// Thrown when document processing reaches the terminal <c>failed</c>
    /// status. The full result is available via <see cref="Result"/>; its
    /// <c>Errors</c> list carries the failure details.
    /// </summary>
    public class GeminaProcessingException : GeminaException
    {
        /// <summary>The terminal <c>failed</c> processing result.</summary>
        public DocumentProcessingResultOutDTO Result { get; }

        /// <summary>Initializes a new instance carrying the failed result.</summary>
        /// <param name="result">The terminal <c>failed</c> result returned by the API.</param>
        public GeminaProcessingException(DocumentProcessingResultOutDTO result)
            : base(BuildMessage(result))
        {
            Result = result;
        }

        private static string BuildMessage(DocumentProcessingResultOutDTO result)
        {
            var errorCount = result?.Errors?.Count ?? 0;
            return errorCount > 0
                ? $"Document processing failed with {errorCount} error(s); inspect the Result.Errors list for details."
                : "Document processing failed; inspect the Result property for details.";
        }
    }

    /// <summary>
    /// Thrown when the overall polling deadline is exceeded before document
    /// processing reaches a terminal status. Carries the
    /// <see cref="CorrelationId"/> and the last result seen, so callers may
    /// resume polling themselves (e.g. via
    /// <c>Documents.GetDocumentProcessingResultByCorrelationIdAsync</c>).
    /// </summary>
    public class GeminaTimeoutException : GeminaException
    {
        /// <summary>Correlation id of the in-flight processing request.</summary>
        public Guid CorrelationId { get; }

        /// <summary>The last (non-terminal) result seen before the deadline, if any.</summary>
        public DocumentProcessingResultOutDTO LastResult { get; }

        /// <summary>Initializes a new instance carrying the correlation id and last seen result.</summary>
        /// <param name="correlationId">Correlation id of the in-flight request.</param>
        /// <param name="lastResult">The last result seen before timing out (may be null).</param>
        /// <param name="timeoutSeconds">The deadline that was exceeded, in seconds.</param>
        public GeminaTimeoutException(Guid correlationId, DocumentProcessingResultOutDTO lastResult, double timeoutSeconds)
            : base($"Document processing did not reach a terminal status within {timeoutSeconds}s " +
                   $"(correlationId: {correlationId}). You can resume polling with " +
                   "Documents.GetDocumentProcessingResultByCorrelationIdAsync.")
        {
            CorrelationId = correlationId;
            LastResult = lastResult;
        }
    }

    /// <summary>
    /// Thrown by <see cref="GeminaWebhooks.Unwrap(string, System.Collections.Generic.IEnumerable{System.Collections.Generic.KeyValuePair{string, string}}, string, WebhookOptions)"/>
    /// when an incoming webhook cannot be verified or parsed (contract §6).
    /// No other exception type leaves the helper.
    /// </summary>
    public class GeminaWebhookVerificationException : GeminaException
    {
        /// <summary>
        /// Why the delivery was refused: <c>missing_header</c>, <c>ambiguous_header</c>,
        /// <c>invalid_timestamp</c>, <c>timestamp_out_of_tolerance</c>, <c>invalid_secret</c>,
        /// <c>no_matching_signature</c> or <c>invalid_body</c>, the constants of
        /// <see cref="GeminaWebhookVerificationReason"/>.
        /// </summary>
        public string Reason { get; }

        /// <summary>Initializes a new instance with a reason and a message.</summary>
        /// <param name="reason">One of the reason names listed on <see cref="Reason"/>.</param>
        /// <param name="message">The error message.</param>
        public GeminaWebhookVerificationException(string reason, string message)
            : base(message)
        {
            Reason = reason;
        }

        /// <summary>Initializes a new instance with a reason, a message and the underlying cause.</summary>
        /// <param name="reason">One of the reason names listed on <see cref="Reason"/>.</param>
        /// <param name="message">The error message.</param>
        /// <param name="innerException">The underlying cause.</param>
        public GeminaWebhookVerificationException(string reason, string message, Exception innerException)
            : base(message, innerException)
        {
            Reason = reason;
        }
    }

    /// <summary>
    /// The values of <see cref="GeminaWebhookVerificationException.Reason"/> (contract §6).
    /// </summary>
    public static class GeminaWebhookVerificationReason
    {
        /// <summary>A <c>webhook-id</c>, <c>webhook-timestamp</c> or <c>webhook-signature</c> header is missing.</summary>
        public const string MissingHeader = "missing_header";

        /// <summary>A <c>webhook-id</c>, <c>webhook-timestamp</c> or <c>webhook-signature</c> header was sent more than once with different values.</summary>
        public const string AmbiguousHeader = "ambiguous_header";

        /// <summary>The <c>webhook-timestamp</c> header is not 1 to 12 ASCII digits.</summary>
        public const string InvalidTimestamp = "invalid_timestamp";

        /// <summary>The timestamp is too far from the clock, or the clock or the tolerance is not usable.</summary>
        public const string TimestampOutOfTolerance = "timestamp_out_of_tolerance";

        /// <summary>The signing secret is not <c>whsec_</c> followed by base64 of at least one byte.</summary>
        public const string InvalidSecret = "invalid_secret";

        /// <summary>No <c>v1</c> signature in the <c>webhook-signature</c> header matches the body.</summary>
        public const string NoMatchingSignature = "no_matching_signature";

        /// <summary>The body is not one JSON object, or a known event's data is incomplete or cannot be read.</summary>
        public const string InvalidBody = "invalid_body";
    }
}
