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
}
