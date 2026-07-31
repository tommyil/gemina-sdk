using System.IO;
using System.Threading;
using System.Threading.Tasks;
using Gemina.Sdk.Api;
using Gemina.Sdk.Client;
using Gemina.Sdk.Model;

namespace Gemina.Sdk
{
    /// <summary>
    /// Drop-in <see cref="IFileTagApi"/> decorator that fixes the upload
    /// calls. The generated multipart path passes no content type to
    /// RestSharp, so every FileTag upload goes out as
    /// <c>application/octet-stream</c> (and non-<c>FileStream</c> streams get
    /// the filename <c>no_file_name_provided</c>); the FileTag endpoint is
    /// content-type-driven and rejects such parts. All eight upload members
    /// (sync/async × plain/WithHttpInfo × TagDocument/TagDocumentByUser)
    /// route through <see cref="FileTagTransport"/>, which resolves the real
    /// content type and filename via <see cref="MediaTypeResolver"/>; the
    /// caller's <see cref="ExceptionFactory"/> is applied to the transport's
    /// response exactly like generated call sites do, so error behaviour is
    /// unchanged. Everything else delegates to an inner generated
    /// <see cref="FileTagApi"/> untouched.
    ///
    /// <see cref="GeminaClient.FileTag"/> returns this decorator by default.
    /// Constructing a raw <c>new FileTagApi(...)</c> keeps the generated
    /// (broken-upload) behaviour.
    /// </summary>
    internal sealed class FileTagApiWithTypedUploads : IFileTagApi
    {
        private readonly FileTagApi _inner;
        private IFileTagTransport _transport;

        internal FileTagApiWithTypedUploads(Configuration configuration)
        {
            _inner = new FileTagApi(configuration);
            _transport = new FileTagTransport(_inner.Configuration);
        }

        /// <summary>The upload transport; injectable in tests.</summary>
        internal IFileTagTransport Transport
        {
            get => _transport;
            set => _transport = value;
        }

        // ---- IApiAccessor ----

        /// <inheritdoc />
        public IReadableConfiguration Configuration
        {
            get => _inner.Configuration;
            set
            {
                _inner.Configuration = value;
                // Keep the transport on the same configuration the generated
                // members use.
                _transport = new FileTagTransport(value);
            }
        }

        /// <inheritdoc />
        public ExceptionFactory ExceptionFactory
        {
            get => _inner.ExceptionFactory;
            set => _inner.ExceptionFactory = value;
        }

        /// <inheritdoc />
        public string GetBasePath()
        {
            return _inner.GetBasePath();
        }

        // ---- Non-upload members: generated behaviour unchanged ----

        /// <inheritdoc />
        public FileTagBalanceOutDTO GetMyFiletagBalance(int operationIndex = 0)
        {
            return _inner.GetMyFiletagBalance(operationIndex);
        }

        /// <inheritdoc />
        public ApiResponse<FileTagBalanceOutDTO> GetMyFiletagBalanceWithHttpInfo(int operationIndex = 0)
        {
            return _inner.GetMyFiletagBalanceWithHttpInfo(operationIndex);
        }

        /// <inheritdoc />
        public Task<FileTagBalanceOutDTO> GetMyFiletagBalanceAsync(int operationIndex = 0, CancellationToken cancellationToken = default)
        {
            return _inner.GetMyFiletagBalanceAsync(operationIndex, cancellationToken);
        }

        /// <inheritdoc />
        public Task<ApiResponse<FileTagBalanceOutDTO>> GetMyFiletagBalanceWithHttpInfoAsync(int operationIndex = 0, CancellationToken cancellationToken = default)
        {
            return _inner.GetMyFiletagBalanceWithHttpInfoAsync(operationIndex, cancellationToken);
        }

        /// <inheritdoc />
        public CreditTransactionListOutDTO GetMyFiletagCreditHistory(int? skip = default, int? limit = default, int operationIndex = 0)
        {
            return _inner.GetMyFiletagCreditHistory(skip, limit, operationIndex);
        }

        /// <inheritdoc />
        public ApiResponse<CreditTransactionListOutDTO> GetMyFiletagCreditHistoryWithHttpInfo(int? skip = default, int? limit = default, int operationIndex = 0)
        {
            return _inner.GetMyFiletagCreditHistoryWithHttpInfo(skip, limit, operationIndex);
        }

        /// <inheritdoc />
        public Task<CreditTransactionListOutDTO> GetMyFiletagCreditHistoryAsync(int? skip = default, int? limit = default, int operationIndex = 0, CancellationToken cancellationToken = default)
        {
            return _inner.GetMyFiletagCreditHistoryAsync(skip, limit, operationIndex, cancellationToken);
        }

        /// <inheritdoc />
        public Task<ApiResponse<CreditTransactionListOutDTO>> GetMyFiletagCreditHistoryWithHttpInfoAsync(int? skip = default, int? limit = default, int operationIndex = 0, CancellationToken cancellationToken = default)
        {
            return _inner.GetMyFiletagCreditHistoryWithHttpInfoAsync(skip, limit, operationIndex, cancellationToken);
        }

        // ---- Upload members: fixed multipart via FileTagTransport ----
        // operationIndex is accepted for interface parity; like the generated
        // code (which only feeds it to GetOperationServerUrl, and this API
        // defines no operation servers) it does not alter the request.

        /// <inheritdoc />
        public FileTagResultOutDTO TagDocument(Stream file, int operationIndex = 0)
        {
            return TagDocumentWithHttpInfo(file, operationIndex).Data;
        }

        /// <inheritdoc />
        public ApiResponse<FileTagResultOutDTO> TagDocumentWithHttpInfo(Stream file, int operationIndex = 0)
        {
            var response = _transport
                .TagDocumentWithHttpInfoAsync(file, CancellationToken.None)
                .GetAwaiter().GetResult();
            return Checked("TagDocument", response);
        }

        /// <inheritdoc />
        public async Task<FileTagResultOutDTO> TagDocumentAsync(Stream file, int operationIndex = 0, CancellationToken cancellationToken = default)
        {
            var response = await TagDocumentWithHttpInfoAsync(file, operationIndex, cancellationToken).ConfigureAwait(false);
            return response.Data;
        }

        /// <inheritdoc />
        public async Task<ApiResponse<FileTagResultOutDTO>> TagDocumentWithHttpInfoAsync(Stream file, int operationIndex = 0, CancellationToken cancellationToken = default)
        {
            var response = await _transport
                .TagDocumentWithHttpInfoAsync(file, cancellationToken)
                .ConfigureAwait(false);
            return Checked("TagDocument", response);
        }

        /// <inheritdoc />
        public FileTagResultOutDTO TagDocumentByUser(Stream file, int operationIndex = 0)
        {
            return TagDocumentByUserWithHttpInfo(file, operationIndex).Data;
        }

        /// <inheritdoc />
        public ApiResponse<FileTagResultOutDTO> TagDocumentByUserWithHttpInfo(Stream file, int operationIndex = 0)
        {
            var response = _transport
                .TagDocumentByUserWithHttpInfoAsync(file, CancellationToken.None)
                .GetAwaiter().GetResult();
            return Checked("TagDocumentByUser", response);
        }

        /// <inheritdoc />
        public async Task<FileTagResultOutDTO> TagDocumentByUserAsync(Stream file, int operationIndex = 0, CancellationToken cancellationToken = default)
        {
            var response = await TagDocumentByUserWithHttpInfoAsync(file, operationIndex, cancellationToken).ConfigureAwait(false);
            return response.Data;
        }

        /// <inheritdoc />
        public async Task<ApiResponse<FileTagResultOutDTO>> TagDocumentByUserWithHttpInfoAsync(Stream file, int operationIndex = 0, CancellationToken cancellationToken = default)
        {
            var response = await _transport
                .TagDocumentByUserWithHttpInfoAsync(file, cancellationToken)
                .ConfigureAwait(false);
            return Checked("TagDocumentByUser", response);
        }

        /// <summary>
        /// Applies the configured <see cref="ExceptionFactory"/> to the
        /// transport's response, exactly like every generated call site does
        /// after its HTTP request.
        /// </summary>
        private ApiResponse<FileTagResultOutDTO> Checked(string operationName, ApiResponse<FileTagResultOutDTO> response)
        {
            var exceptionFactory = _inner.ExceptionFactory;
            if (exceptionFactory != null)
            {
                var exception = exceptionFactory(operationName, response);
                if (exception != null)
                {
                    throw exception;
                }
            }

            return response;
        }
    }
}
