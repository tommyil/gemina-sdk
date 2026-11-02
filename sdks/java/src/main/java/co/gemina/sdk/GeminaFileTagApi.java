package co.gemina.sdk;

import java.io.File;
import co.gemina.sdk.generated.ApiCallback;
import co.gemina.sdk.generated.ApiClient;
import co.gemina.sdk.generated.ApiException;
import co.gemina.sdk.generated.ApiResponse;
import co.gemina.sdk.generated.api.FileTagApi;
import co.gemina.sdk.generated.model.FileTagResultOutDTO;

/** Keeps existing upload calls usable when the optional request reference is omitted. */
public final class GeminaFileTagApi extends FileTagApi {
    public GeminaFileTagApi(ApiClient apiClient) { super(apiClient); }

    public FileTagResultOutDTO tagDocument(File file) throws ApiException {
        return super.tagDocument(file, null);
    }

    public ApiResponse<FileTagResultOutDTO> tagDocumentWithHttpInfo(File file) throws ApiException {
        return super.tagDocumentWithHttpInfo(file, null);
    }

    public okhttp3.Call tagDocumentAsync(File file, ApiCallback<FileTagResultOutDTO> callback) throws ApiException {
        return super.tagDocumentAsync(file, null, callback);
    }

    public okhttp3.Call tagDocumentCall(File file, ApiCallback<FileTagResultOutDTO> callback) throws ApiException {
        return super.tagDocumentCall(file, null, callback);
    }

    public FileTagResultOutDTO tagDocumentByUser(File file) throws ApiException {
        return super.tagDocumentByUser(file, null);
    }

    public ApiResponse<FileTagResultOutDTO> tagDocumentByUserWithHttpInfo(File file) throws ApiException {
        return super.tagDocumentByUserWithHttpInfo(file, null);
    }

    public okhttp3.Call tagDocumentByUserAsync(File file, ApiCallback<FileTagResultOutDTO> callback) throws ApiException {
        return super.tagDocumentByUserAsync(file, null, callback);
    }

    public okhttp3.Call tagDocumentByUserCall(File file, ApiCallback<FileTagResultOutDTO> callback) throws ApiException {
        return super.tagDocumentByUserCall(file, null, callback);
    }
}
