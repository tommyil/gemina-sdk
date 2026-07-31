using System;
using System.Collections.Generic;
using System.IO;
using System.Net;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading.Tasks;
using Gemina.Sdk.Model;
using Xunit;

namespace Gemina.Sdk.Tests
{
    /// <summary>
    /// Wire-level regression tests: capture the raw multipart request the SDK
    /// actually sends and pin the file part's Content-Type and filename.
    /// Covers both upload paths — <c>ProcessDocumentAsync</c> (DocumentTransport)
    /// and <c>client.FileTag</c> (FileTagApiWithTypedUploads), the latter
    /// having historically sent every upload as
    /// <c>application/octet-stream</c> via the generated code.
    /// </summary>
    public class MultipartWireTests
    {
        // Real HEIC leader: box size + "ftypheic" major brand.
        private static readonly byte[] HeicBytes = BuildHeic();

        private static byte[] BuildHeic()
        {
            var bytes = new byte[64];
            bytes[3] = 0x18; // box size 24
            Encoding.ASCII.GetBytes("ftypheic").CopyTo(bytes, 4);
            return bytes;
        }

        private static readonly byte[] PngBytes = BuildPng();

        private static byte[] BuildPng()
        {
            var bytes = new byte[64];
            new byte[] { 0x89, 0x50, 0x4E, 0x47 }.CopyTo(bytes, 0);
            return bytes;
        }

        /// <summary>A stream RestSharp cannot rewind or measure — like a network stream.</summary>
        private sealed class NonSeekableStream : Stream
        {
            private readonly MemoryStream _inner;

            public NonSeekableStream(byte[] bytes)
            {
                _inner = new MemoryStream(bytes);
            }

            public override bool CanRead => true;
            public override bool CanSeek => false;
            public override bool CanWrite => false;
            public override long Length => throw new NotSupportedException();
            public override long Position
            {
                get => throw new NotSupportedException();
                set => throw new NotSupportedException();
            }

            public override void Flush() { }
            public override int Read(byte[] buffer, int offset, int count) => _inner.Read(buffer, offset, count);
            public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException();
            public override void SetLength(long value) => throw new NotSupportedException();
            public override void Write(byte[] buffer, int offset, int count) => throw new NotSupportedException();
        }

        private sealed class Captured
        {
            public string ContentType;
            public string FileName;
            public string Path;
            public System.Collections.Specialized.NameValueCollection RequestHeaders;
        }

        private static async Task<Captured> CaptureAsync(
            Func<GeminaClient, Task> call,
            Func<string, GeminaClient> clientFactory = null,
            int responseStatus = 500,
            string responseBody = "{}",
            IDictionary<string, string> responseHeaders = null)
        {
            var port = GetFreePort();
            var prefix = $"http://127.0.0.1:{port}/";
            using (var listener = new HttpListener())
            {
                listener.Prefixes.Add(prefix);
                listener.Start();

                var captured = new Captured();
                string body = null;
                var serverTask = Task.Run(async () =>
                {
                    var ctx = await listener.GetContextAsync().ConfigureAwait(false);
                    captured.Path = ctx.Request.Url.AbsolutePath;
                    captured.RequestHeaders = ctx.Request.Headers;
                    using (var reader = new StreamReader(ctx.Request.InputStream, Encoding.UTF8))
                    {
                        body = await reader.ReadToEndAsync().ConfigureAwait(false);
                    }
                    ctx.Response.StatusCode = responseStatus;
                    ctx.Response.ContentType = "application/json";
                    if (responseHeaders != null)
                    {
                        foreach (var header in responseHeaders)
                        {
                            ctx.Response.AddHeader(header.Key, header.Value);
                        }
                    }
                    var payload = Encoding.UTF8.GetBytes(responseBody);
                    await ctx.Response.OutputStream.WriteAsync(payload, 0, payload.Length).ConfigureAwait(false);
                    ctx.Response.Close();
                });

                var baseUrl = prefix.TrimEnd('/');
                var client = clientFactory != null ? clientFactory(baseUrl) : new GeminaClient("probe-key", baseUrl);
                try
                {
                    await call(client).ConfigureAwait(false);
                }
                catch (Exception)
                {
                    // Expected for the default 500 response.
                }

                await serverTask.ConfigureAwait(false);
                listener.Stop();

                Assert.NotNull(body);
                // RestSharp part order: Content-Type precedes Content-Disposition.
                var match = Regex.Match(
                    body,
                    "Content-Type: (?<ct>[^\\r\\n]+)\\r?\\n" +
                    "Content-Disposition: form-data; name=\"?file\"?; filename=\"?(?<fn>[^\"\\r\\n]*)\"?",
                    RegexOptions.IgnoreCase);
                Assert.True(match.Success, "file part not found in captured body:\n" + body);
                captured.ContentType = match.Groups["ct"].Value.Trim();
                captured.FileName = match.Groups["fn"].Value;
                return captured;
            }
        }

        private static int GetFreePort()
        {
            var l = new System.Net.Sockets.TcpListener(IPAddress.Loopback, 0);
            l.Start();
            var port = ((IPEndPoint)l.LocalEndpoint).Port;
            l.Stop();
            return port;
        }

        private static readonly List<UploadExtractionTypeEnum> Types =
            new List<UploadExtractionTypeEnum> { UploadExtractionTypeEnum.InvoiceHeaders };

        // ---- Documents path (DocumentTransport) ----

        [Fact]
        public async Task Documents_HeicStream_NoFileName_SendsImageHeicAndDocumentHeic()
        {
            var captured = await CaptureAsync(
                c => c.ProcessDocumentAsync(new MemoryStream(HeicBytes), Types));

            Assert.Equal("image/heic", captured.ContentType);
            Assert.Equal("document.heic", captured.FileName);
        }

        [Fact]
        public async Task Documents_HeicFile_SendsImageHeicWithRealName()
        {
            var tmp = Path.Combine(Path.GetTempPath(), "probe-photo.heic");
            File.WriteAllBytes(tmp, HeicBytes);
            try
            {
                var captured = await CaptureAsync(
                    c => c.ProcessDocumentAsync(GeminaDocumentSource.FromFile(tmp), Types));

                Assert.Equal("image/heic", captured.ContentType);
                Assert.Equal("probe-photo.heic", captured.FileName);
            }
            finally
            {
                File.Delete(tmp);
            }
        }

        [Fact]
        public async Task Documents_PngStream_NoFileName_ControlStaysSniffed()
        {
            var captured = await CaptureAsync(
                c => c.ProcessDocumentAsync(new MemoryStream(PngBytes), Types));

            Assert.Equal("image/png", captured.ContentType);
            Assert.Equal("document.png", captured.FileName);
        }

        // ---- FileTag raw-key path (POST /api/v1/filetag) ----

        [Fact]
        public async Task FileTag_PngFileStream_SendsImagePngWithRealFileName()
        {
            // Regression: through the raw generated FileTagApi this part went
            // out as application/octet-stream, breaking every FileTag upload
            // against the content-type-driven endpoint.
            var tmp = Path.Combine(Path.GetTempPath(), "probe-invoice.png");
            File.WriteAllBytes(tmp, PngBytes);
            try
            {
                using (var fs = File.OpenRead(tmp))
                {
                    var stream = fs;
                    var captured = await CaptureAsync(
                        c => c.FileTag.TagDocumentAsync(stream));

                    Assert.Equal("image/png", captured.ContentType);
                    Assert.Equal("probe-invoice.png", captured.FileName);
                    Assert.Equal("/api/v1/filetag", captured.Path);
                    Assert.Equal("probe-key", captured.RequestHeaders["X-API-Key"]);
                }
            }
            finally
            {
                File.Delete(tmp);
            }
        }

        [Fact]
        public async Task FileTag_Sync_HeicStream_NoFileName_SendsImageHeicAndDocumentHeic()
        {
            var captured = await CaptureAsync(
                c => Task.Run(() => c.FileTag.TagDocument(new MemoryStream(HeicBytes))));

            Assert.Equal("image/heic", captured.ContentType);
            Assert.Equal("document.heic", captured.FileName);
        }

        [Fact]
        public async Task FileTag_UnnamedNonSeekableStream_SynthesizesDocumentHeic()
        {
            // A network-like stream: no name, no seeking — the sniffed bytes
            // must still produce both the content type and the extension.
            var captured = await CaptureAsync(
                c => c.FileTag.TagDocumentAsync(new NonSeekableStream(HeicBytes)));

            Assert.Equal("image/heic", captured.ContentType);
            Assert.Equal("document.heic", captured.FileName);
        }

        [Fact]
        public async Task FileTag_WithHttpInfo_SurfacesStatusHeadersAndParsedBody()
        {
            Gemina.Sdk.Client.ApiResponse<FileTagResultOutDTO> response = null;
            var captured = await CaptureAsync(
                async c => { response = await c.FileTag.TagDocumentWithHttpInfoAsync(new MemoryStream(PngBytes)); },
                responseStatus: 200,
                responseBody: FileTagTransportTests.ResultBody,
                responseHeaders: new Dictionary<string, string> { { "X-Wire-Probe", "wire-123" } });

            Assert.Equal("image/png", captured.ContentType);
            Assert.NotNull(response);
            Assert.Equal(HttpStatusCode.OK, response.StatusCode);
            Assert.Equal("2026-07-01_acme_invoice.pdf", response.Data.SuggestedFilename);
            Assert.True(response.Headers.ContainsKey("X-Wire-Probe"),
                "X-Wire-Probe not surfaced; headers present: " + string.Join(", ", response.Headers.Keys));
            Assert.Contains("wire-123", response.Headers["X-Wire-Probe"]);
        }

        // ---- FileTag by-user path (POST /api/v1/filetag/user) ----

        [Fact]
        public async Task FileTag_ByUser_SendsBearerAndTypedPart()
        {
            var captured = await CaptureAsync(
                c => c.FileTag.TagDocumentByUserAsync(new MemoryStream(HeicBytes)),
                clientFactory: baseUrl => GeminaClient.WithSessionToken("session-jwt", baseUrl));

            Assert.Equal("/api/v1/filetag/user", captured.Path);
            Assert.Equal("Bearer session-jwt", captured.RequestHeaders["Authorization"]);
            Assert.Equal("image/heic", captured.ContentType);
            Assert.Equal("document.heic", captured.FileName);
        }
    }
}
