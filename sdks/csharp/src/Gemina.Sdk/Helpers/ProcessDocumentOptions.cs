using System;
using System.Threading;
using System.Threading.Tasks;
using Gemina.Sdk.Model;

namespace Gemina.Sdk
{
    /// <summary>
    /// Optional settings for <see cref="GeminaClient.ProcessDocumentAsync(GeminaDocumentSource, System.Collections.Generic.List{ExtractionTypeModel}, ProcessDocumentOptions, CancellationToken)"/>:
    /// endpoint form fields plus polling knobs.
    /// </summary>
    public class ProcessDocumentOptions
    {
        /// <summary>
        /// Your own identifier for the document. The API requires one; when
        /// omitted the SDK generates a random GUID string.
        /// </summary>
        public string ExternalId { get; set; }

        /// <summary>Template ID for <c>custom_template</c> extraction.</summary>
        public Guid? TemplateId { get; set; }

        /// <summary>The model type to use for the document.</summary>
        public ModelType? ModelType { get; set; }

        /// <summary>Whether to use the Thinking model for the document.</summary>
        public bool? Thinking { get; set; }

        /// <summary>Whether to use the Evaluation model for the document.</summary>
        public bool? Evaluation { get; set; }

        /// <summary>Whether to use the Correction model for the document.</summary>
        public bool? Correction { get; set; }

        /// <summary>Whether to include coordinates in the extraction results.</summary>
        public bool? IncludeCoordinates { get; set; }

        /// <summary>End-user ID to associate with the document.</summary>
        public string EndUserId { get; set; }

        /// <summary>Overall polling deadline in seconds (default 300).</summary>
        public double TimeoutSeconds { get; set; } = 300.0;

        /// <summary>First polling interval in seconds (default 2.0); grows ×1.5 per attempt.</summary>
        public double InitialIntervalSeconds { get; set; } = 2.0;

        /// <summary>Upper bound for the polling interval in seconds (default 15.0).</summary>
        public double MaxIntervalSeconds { get; set; } = 15.0;

        /// <summary>
        /// Injectable wait used between polls. Defaults to
        /// <see cref="Task.Delay(TimeSpan, CancellationToken)"/>; override in
        /// tests to assert the backoff schedule without real waiting.
        /// </summary>
        public Func<TimeSpan, CancellationToken, Task> Delay { get; set; }

        /// <summary>
        /// Injectable uniform random source in [0, 1) used for polling
        /// jitter. Defaults to a shared <see cref="Random"/>; override in
        /// tests for a deterministic schedule.
        /// </summary>
        public Func<double> Random { get; set; }
    }
}
