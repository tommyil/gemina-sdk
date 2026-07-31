using System.Text;
using Xunit;

namespace Gemina.Sdk.Tests
{
    /// <summary>
    /// Offline tests for the shared magic-byte + extension resolver: the
    /// legacy five formats stay byte-identical, the ISO-BMFF branch maps the
    /// still-image HEIC/HEIF/AVIF brands (and deliberately not the sequence
    /// brands), and the extension fallback covers the new formats.
    /// </summary>
    public class MediaTypeResolverTests
    {
        private static byte[] IsoBmff(string majorBrand)
        {
            var bytes = new byte[64];
            bytes[3] = 0x18; // box size 24
            Encoding.ASCII.GetBytes("ftyp" + majorBrand).CopyTo(bytes, 4);
            return bytes;
        }

        private static byte[] Png()
        {
            var bytes = new byte[64];
            new byte[] { 0x89, 0x50, 0x4E, 0x47 }.CopyTo(bytes, 0);
            return bytes;
        }

        // ---- ISO-BMFF brand sniffing ----

        [Theory]
        [InlineData("heic", "image/heic", ".heic")]
        [InlineData("heix", "image/heic", ".heic")]
        [InlineData("mif1", "image/heif", ".heif")]
        [InlineData("heim", "image/heif", ".heif")]
        [InlineData("heis", "image/heif", ".heif")]
        [InlineData("avif", "image/avif", ".avif")]
        [InlineData("avis", "image/avif", ".avif")]
        public void IsoBmffStillImageBrands_AreSniffed(string brand, string expectedType, string expectedExtension)
        {
            string fileName = null;
            var contentType = MediaTypeResolver.ResolveContentTypeAndFileName(IsoBmff(brand), ref fileName);

            Assert.Equal(expectedType, contentType);
            Assert.Equal("document" + expectedExtension, fileName);
        }

        [Fact]
        public void HeicStream_NoFileName_SynthesizesDocumentHeic()
        {
            string fileName = null;
            var contentType = MediaTypeResolver.ResolveContentTypeAndFileName(IsoBmff("heic"), ref fileName);

            Assert.Equal("image/heic", contentType);
            Assert.Equal("document.heic", fileName);
        }

        [Fact]
        public void HeicBytes_WithRealFileName_KeepTheName()
        {
            string fileName = "vacation-receipt.heic";
            var contentType = MediaTypeResolver.ResolveContentTypeAndFileName(IsoBmff("heic"), ref fileName);

            Assert.Equal("image/heic", contentType);
            Assert.Equal("vacation-receipt.heic", fileName);
        }

        [Theory]
        [InlineData("msf1")]
        [InlineData("hevc")]
        [InlineData("hevx")]
        public void IsoBmffSequenceBrands_AreNotSniffed_FallThroughToOctetStream(string brand)
        {
            // Burst / Live-Photo containers the API rejects: no sniff, no
            // extension -> octet-stream and a bare "document" name, so the
            // server can answer a clean 415 instead of a misleading one.
            string fileName = null;
            var contentType = MediaTypeResolver.ResolveContentTypeAndFileName(IsoBmff(brand), ref fileName);

            Assert.Equal("application/octet-stream", contentType);
            Assert.Equal("document", fileName);
        }

        [Fact]
        public void IsoBmffSequenceBrand_WithHeicExtension_RescuedByExtensionFallback()
        {
            string fileName = "burst.heic";
            var contentType = MediaTypeResolver.ResolveContentTypeAndFileName(IsoBmff("msf1"), ref fileName);

            Assert.Equal("image/heic", contentType);
        }

        // ---- Legacy five formats: unchanged ----

        [Theory]
        [InlineData(new byte[] { 0x89, 0x50, 0x4E, 0x47 }, "image/png", ".png")]
        [InlineData(new byte[] { 0xFF, 0xD8, 0xFF }, "image/jpeg", ".jpg")]
        [InlineData(new byte[] { 0x47, 0x49, 0x46, 0x38 }, "image/gif", ".gif")]
        [InlineData(new byte[] { 0x25, 0x50, 0x44, 0x46 }, "application/pdf", ".pdf")]
        public void LegacyMagicBytes_AreSniffedUnchanged(byte[] magic, string expectedType, string expectedExtension)
        {
            var bytes = new byte[64];
            magic.CopyTo(bytes, 0);

            string fileName = null;
            var contentType = MediaTypeResolver.ResolveContentTypeAndFileName(bytes, ref fileName);

            Assert.Equal(expectedType, contentType);
            Assert.Equal("document" + expectedExtension, fileName);
        }

        [Fact]
        public void WebpMagicBytes_AreSniffedUnchanged()
        {
            var bytes = new byte[64];
            Encoding.ASCII.GetBytes("RIFF").CopyTo(bytes, 0);
            Encoding.ASCII.GetBytes("WEBP").CopyTo(bytes, 8);

            string fileName = null;
            var contentType = MediaTypeResolver.ResolveContentTypeAndFileName(bytes, ref fileName);

            Assert.Equal("image/webp", contentType);
            Assert.Equal("document.webp", fileName);
        }

        [Fact]
        public void UnknownBytes_NoFileName_StayOctetStreamAndBareDocument()
        {
            string fileName = null;
            var contentType = MediaTypeResolver.ResolveContentTypeAndFileName(new byte[64], ref fileName);

            Assert.Equal("application/octet-stream", contentType);
            Assert.Equal("document", fileName);
        }

        [Fact]
        public void ShortBuffer_FallsBackToExtension()
        {
            string fileName = "tiny.png";
            var contentType = MediaTypeResolver.ResolveContentTypeAndFileName(new byte[4], ref fileName);

            Assert.Equal("image/png", contentType);
        }

        // ---- Extension fallback for the new formats ----

        [Theory]
        [InlineData("photo.heic", "image/heic")]
        [InlineData("photo.HEIC", "image/heic")]
        [InlineData("photo.hif", "image/heic")]
        [InlineData("photo.heif", "image/heif")]
        [InlineData("photo.avif", "image/avif")]
        public void NewExtensions_ResolveWhenBytesAreUnrecognised(string name, string expectedType)
        {
            string fileName = name;
            var contentType = MediaTypeResolver.ResolveContentTypeAndFileName(new byte[64], ref fileName);

            Assert.Equal(expectedType, contentType);
            Assert.Equal(name, fileName);
        }

        [Fact]
        public void SniffWinsOverMismatchedExtension()
        {
            // PNG magic beats a .heic extension — sniff is authoritative.
            string fileName = "mislabeled.heic";
            var contentType = MediaTypeResolver.ResolveContentTypeAndFileName(Png(), ref fileName);

            Assert.Equal("image/png", contentType);
        }
    }
}
