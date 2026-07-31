package co.gemina.sdk;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;

import java.io.File;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.LinkedHashMap;
import java.util.Map;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import okhttp3.MediaType;
import okhttp3.MultipartBody;
import okhttp3.RequestBody;

/**
 * Offline tests for the multipart Content-Type fix: the JDK's
 * {@code content-types.properties} table predates HEIC/HEIF/AVIF, so the
 * generated client labels those uploads {@code application/octet-stream},
 * which the content-type-driven FileTag endpoint rejects with a 415.
 * {@link GeminaApiClient#guessContentTypeFromFile(File)} must map them by
 * extension while leaving JDK-known formats untouched.
 */
class GeminaApiClientContentTypeTest {

    @TempDir
    Path tempDir;

    /** Minimal ISO-BMFF prefix: size + 'ftyp' + major brand 'heic'. */
    private static final byte[] HEIC_BYTES = {
            0x00, 0x00, 0x00, 0x18, 'f', 't', 'y', 'p', 'h', 'e', 'i', 'c'
    };

    private static final byte[] PNG_BYTES = {
            (byte) 0x89, 'P', 'N', 'G', '\r', '\n', 0x1a, '\n'
    };

    private MediaType buildAndGetFilePartContentType(String fileName, byte[] content)
            throws IOException {
        File file = tempDir.resolve(fileName).toFile();
        Files.write(file.toPath(), content);

        Map<String, Object> formParams = new LinkedHashMap<String, Object>();
        formParams.put("file", file);

        RequestBody body = new GeminaApiClient().buildRequestBodyMultipart(formParams);
        MultipartBody multipart = (MultipartBody) body;
        assertEquals(1, multipart.size());
        return multipart.part(0).body().contentType();
    }

    @Test
    void heicFilePartIsImageHeic() throws IOException {
        MediaType contentType = buildAndGetFilePartContentType("photo.heic", HEIC_BYTES);
        assertNotNull(contentType);
        assertEquals(MediaType.parse("image/heic"), contentType);
    }

    @Test
    void hifFilePartIsImageHeic() throws IOException {
        MediaType contentType = buildAndGetFilePartContentType("photo.hif", HEIC_BYTES);
        assertEquals(MediaType.parse("image/heic"), contentType);
    }

    @Test
    void heifFilePartIsImageHeif() throws IOException {
        MediaType contentType = buildAndGetFilePartContentType("photo.heif", HEIC_BYTES);
        assertEquals(MediaType.parse("image/heif"), contentType);
    }

    @Test
    void avifFilePartIsImageAvif() throws IOException {
        MediaType contentType = buildAndGetFilePartContentType("photo.avif", HEIC_BYTES);
        assertEquals(MediaType.parse("image/avif"), contentType);
    }

    @Test
    void uppercaseExtensionIsMappedToo() throws IOException {
        MediaType contentType = buildAndGetFilePartContentType("PHOTO.HEIC", HEIC_BYTES);
        assertEquals(MediaType.parse("image/heic"), contentType);
    }

    @Test
    void pngControlKeepsJdkGuessedType() throws IOException {
        // Control: a format the JDK table already knows must keep the
        // superclass's answer, not fall into the extension mapping.
        MediaType contentType = buildAndGetFilePartContentType("image.png", PNG_BYTES);
        assertEquals(MediaType.parse("image/png"), contentType);
    }

    @Test
    void unknownExtensionStaysOctetStream() throws IOException {
        MediaType contentType = buildAndGetFilePartContentType("data.zzz", PNG_BYTES);
        assertEquals(MediaType.parse("application/octet-stream"), contentType);
    }
}
