package co.gemina.sdk;

import java.io.File;
import java.util.List;
import java.util.Locale;
import java.util.Map;

import co.gemina.sdk.generated.ApiClient;

import okhttp3.MultipartBody;
import okhttp3.RequestBody;

/**
 * {@link ApiClient} with two fixes on top of the generated code:
 *
 * <ol>
 *   <li>Multipart form fields that are lists of scalars (e.g.
 *   {@code extraction_types}) are sent as repeated plain-text parts — one per
 *   item — instead of the JSON-serialized whole list repeated per item, which
 *   the API rejects with a 422.</li>
 *   <li>HEIC/HEIF/AVIF files get a correct multipart {@code Content-Type}.
 *   The generated base class derives it via
 *   {@code URLConnection.guessContentTypeFromName}, whose JDK table
 *   ({@code content-types.properties}) predates those formats and returns
 *   {@code null} — degraded to {@code application/octet-stream}. The Gemina
 *   FileTag endpoint is content-type-driven, so octet-stream fails with a
 *   415 even though the API supports the format.</li>
 * </ol>
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

    /**
     * Content-Type guessing that also recognizes the modern still-image
     * formats the Gemina API accepts. The JDK's
     * {@code content-types.properties} lacks HEIC/HEIF/AVIF entries, so the
     * generated implementation falls back to
     * {@code application/octet-stream} for them — which the content-type-
     * driven FileTag endpoint rejects with a 415.
     */
    @Override
    public String guessContentTypeFromFile(File file) {
        String contentType = super.guessContentTypeFromFile(file);
        if (contentType != null && !"application/octet-stream".equals(contentType)) {
            return contentType;
        }
        String name = file.getName().toLowerCase(Locale.ROOT);
        if (name.endsWith(".heic") || name.endsWith(".hif")) {
            return "image/heic";
        }
        if (name.endsWith(".heif")) {
            return "image/heif";
        }
        if (name.endsWith(".avif")) {
            return "image/avif";
        }
        // Literal rather than contentType: super currently coerces null to
        // octet-stream, but a future regeneration must not be able to make
        // this method return null (MediaType.parse(null) would NPE).
        return "application/octet-stream";
    }
}
