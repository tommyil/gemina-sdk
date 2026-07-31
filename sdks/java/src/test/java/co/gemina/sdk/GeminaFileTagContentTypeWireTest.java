package co.gemina.sdk;

import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.IOException;
import java.io.InputStream;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.concurrent.atomic.AtomicReference;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import com.sun.net.httpserver.HttpServer;

import co.gemina.sdk.generated.ApiException;

/**
 * Wire-level proof that the documented facade path — {@code new
 * GeminaClient(apiKey, baseUrl)} then {@code client.fileTag().tagDocument()}
 * — actually routes through {@link GeminaApiClient} and puts
 * {@code image/heic} on the multipart file part. The unit test on
 * {@code buildRequestBodyMultipart} alone can't prove the facade wires the
 * custom client; this captures a real request with the JDK's built-in
 * {@link HttpServer} (no new dependency).
 */
class GeminaFileTagContentTypeWireTest {

    @TempDir
    Path tempDir;

    @Test
    void facadeSendsImageHeicOnTheWireForHeicFile() throws Exception {
        final AtomicReference<byte[]> capturedBody = new AtomicReference<byte[]>();

        HttpServer server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        server.createContext("/", exchange -> {
            capturedBody.set(readAll(exchange.getRequestBody()));
            // Any error answer will do — only the captured request matters.
            byte[] response = "{\"detail\":\"unsupported\"}".getBytes(StandardCharsets.UTF_8);
            exchange.getResponseHeaders().set("Content-Type", "application/json");
            exchange.sendResponseHeaders(415, response.length);
            exchange.getResponseBody().write(response);
            exchange.close();
        });
        server.start();
        try {
            File heic = tempDir.resolve("photo.heic").toFile();
            Files.write(heic.toPath(), new byte[] {
                    0x00, 0x00, 0x00, 0x18, 'f', 't', 'y', 'p', 'h', 'e', 'i', 'c'
            });

            GeminaClient client = new GeminaClient(
                    "test-api-key", "http://127.0.0.1:" + server.getAddress().getPort());
            try {
                client.fileTag().tagDocument(heic);
            } catch (ApiException expected) {
                // The fake server always answers 415; the request was still sent.
            }

            byte[] body = capturedBody.get();
            assertNotNull(body, "no multipart request reached the server");
            // Multipart headers are ASCII; ISO-8859-1 decodes the binary body
            // losslessly so the header lines are searchable.
            String multipart = new String(body, StandardCharsets.ISO_8859_1);
            assertTrue(multipart.contains("filename=\"photo.heic\""),
                    "file part missing from captured body:\n" + multipart);
            assertTrue(multipart.contains("Content-Type: image/heic"),
                    "file part is not image/heic in captured body:\n" + multipart);
        } finally {
            server.stop(0);
        }
    }

    /** Java 8-compatible InputStream drain (no InputStream.readAllBytes). */
    private static byte[] readAll(InputStream in) throws IOException {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        byte[] buffer = new byte[8192];
        int read;
        while ((read = in.read(buffer)) != -1) {
            out.write(buffer, 0, read);
        }
        return out.toByteArray();
    }
}
