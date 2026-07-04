package co.gemina.sdk;

import java.io.File;

/**
 * The document to process: either a local {@link File} (submitted via
 * {@code POST /v1/documents/requests}, multipart) or a publicly fetchable URL
 * (submitted via {@code POST /v1/documents/requests/web}).
 *
 * <pre>{@code
 * GeminaDocumentSource.fromFile(new File("invoice.pdf"));
 * GeminaDocumentSource.fromUrl("https://example.com/invoice.pdf");
 * }</pre>
 */
public final class GeminaDocumentSource {

    private final File file;
    private final String url;

    private GeminaDocumentSource(File file, String url) {
        this.file = file;
        this.url = url;
    }

    /** A local file to upload. */
    public static GeminaDocumentSource fromFile(File file) {
        if (file == null) {
            throw new IllegalArgumentException("file must not be null");
        }
        return new GeminaDocumentSource(file, null);
    }

    /** A URL the Gemina API fetches the document from. */
    public static GeminaDocumentSource fromUrl(String url) {
        if (url == null || url.isEmpty()) {
            throw new IllegalArgumentException("url must not be null or empty");
        }
        return new GeminaDocumentSource(null, url);
    }

    /** True when this source is a URL reference (routes to {@code /requests/web}). */
    public boolean isUrl() {
        return url != null;
    }

    /** The local file, or {@code null} for URL sources. */
    public File getFile() {
        return file;
    }

    /** The URL, or {@code null} for file sources. */
    public String getUrl() {
        return url;
    }
}
