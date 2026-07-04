using System;
using System.IO;

namespace Gemina.Sdk
{
    /// <summary>
    /// A document to process: a stream, a file on disk, or a URL the Gemina
    /// API fetches itself. Streams and files submit via
    /// <c>POST /v1/documents/requests</c> (multipart); URLs via
    /// <c>POST /v1/documents/requests/web</c>.
    /// </summary>
    public sealed class GeminaDocumentSource
    {
        private GeminaDocumentSource(Stream stream, string filePath, string url)
        {
            Stream = stream;
            FilePath = filePath;
            Url = url;
        }

        /// <summary>The document stream, when built with <see cref="FromStream"/>.</summary>
        public Stream Stream { get; }

        /// <summary>The document file path, when built with <see cref="FromFile"/>.</summary>
        public string FilePath { get; }

        /// <summary>The document URL, when built with <see cref="FromUrl"/>.</summary>
        public string Url { get; }

        /// <summary>True when this source is a URL reference.</summary>
        public bool IsUrl => Url != null;

        /// <summary>Wraps an already-open document stream (image or PDF).</summary>
        /// <param name="stream">A readable stream positioned at the start of the document.</param>
        public static GeminaDocumentSource FromStream(Stream stream)
        {
            if (stream == null)
            {
                throw new ArgumentNullException(nameof(stream));
            }

            return new GeminaDocumentSource(stream, null, null);
        }

        /// <summary>References a document file on disk (opened when the request is submitted).</summary>
        /// <param name="path">Path to an image or PDF file.</param>
        public static GeminaDocumentSource FromFile(string path)
        {
            if (string.IsNullOrWhiteSpace(path))
            {
                throw new ArgumentException("path must be a non-empty string.", nameof(path));
            }

            return new GeminaDocumentSource(null, path, null);
        }

        /// <summary>References a document by URL; the Gemina API downloads it server-side.</summary>
        /// <param name="url">Publicly reachable URL of an image or PDF.</param>
        public static GeminaDocumentSource FromUrl(string url)
        {
            if (string.IsNullOrWhiteSpace(url))
            {
                throw new ArgumentException("url must be a non-empty string.", nameof(url));
            }

            return new GeminaDocumentSource(null, null, url);
        }
    }
}
