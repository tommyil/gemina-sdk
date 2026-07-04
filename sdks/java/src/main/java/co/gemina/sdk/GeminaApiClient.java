package co.gemina.sdk;

import java.io.File;
import java.util.List;
import java.util.Map;

import co.gemina.sdk.generated.ApiClient;

import okhttp3.MultipartBody;
import okhttp3.RequestBody;

/**
 * {@link ApiClient} with one fix on top of the generated code: multipart form
 * fields that are lists of scalars (e.g. {@code extraction_types}) are sent as
 * repeated plain-text parts — one per item — instead of the JSON-serialized
 * whole list repeated per item, which the API rejects with a 422.
 *
 * <p>Used automatically by every {@link GeminaClient} constructor that builds
 * its own client. If you pass a pre-built {@link ApiClient} to
 * {@link GeminaClient#GeminaClient(ApiClient)}, prefer an instance of this
 * class when you plan to call the multipart document-submission endpoints.</p>
 */
public class GeminaApiClient extends ApiClient {

    @Override
    public RequestBody buildRequestBodyMultipart(Map<String, Object> formParams) {
        MultipartBody.Builder mpBuilder = new MultipartBody.Builder().setType(MultipartBody.FORM);
        for (Map.Entry<String, Object> param : formParams.entrySet()) {
            Object value = param.getValue();
            if (value instanceof File) {
                addPartToMultiPartBuilder(mpBuilder, param.getKey(), (File) value);
            } else if (value instanceof List) {
                for (Object item : (List<?>) value) {
                    if (item instanceof File) {
                        addPartToMultiPartBuilder(mpBuilder, param.getKey(), (File) item);
                    } else {
                        // Repeated scalar form field: one plain-text part per item
                        // (the generated base class would JSON-serialize the whole
                        // list here, e.g. ["invoice_headers"], per item).
                        addPartToMultiPartBuilder(mpBuilder, param.getKey(),
                                (Object) parameterToString(item));
                    }
                }
            } else {
                addPartToMultiPartBuilder(mpBuilder, param.getKey(), value);
            }
        }
        return mpBuilder.build();
    }
}
