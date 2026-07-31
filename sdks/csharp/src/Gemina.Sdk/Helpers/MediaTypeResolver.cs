using System.IO;
using System.Text;

namespace Gemina.Sdk
{
    /// <summary>
    /// Picks a multipart file part's content type (and a fallback file name)
    /// from magic bytes, falling back to the file name's extension. Shared by
    /// <see cref="DocumentTransport"/> and <see cref="FileTagTransport"/>.
    ///
    /// The documents endpoint accepts an upload when either the MIME type or
    /// the file extension is recognised; the FileTag endpoint is
    /// content-type-driven — so getting the part's content type right matters
    /// on both paths.
    /// </summary>
    internal static class MediaTypeResolver
    {
        /// <summary>
        /// Resolves the content type for <paramref name="bytes"/>. When
        /// <paramref name="fileName"/> is null or empty it is replaced with a
        /// synthesized <c>"document" + sniffed extension</c> name.
        /// </summary>
        internal static string ResolveContentTypeAndFileName(byte[] bytes, ref string fileName)
        {
            string sniffedType = null;
            string sniffedExtension = null;

            if (bytes.Length >= 12)
            {
                if (bytes[0] == 0x89 && bytes[1] == 0x50 && bytes[2] == 0x4E && bytes[3] == 0x47)
                {
                    sniffedType = "image/png";
                    sniffedExtension = ".png";
                }
                else if (bytes[0] == 0xFF && bytes[1] == 0xD8 && bytes[2] == 0xFF)
                {
                    sniffedType = "image/jpeg";
                    sniffedExtension = ".jpg";
                }
                else if (bytes[0] == 0x47 && bytes[1] == 0x49 && bytes[2] == 0x46 && bytes[3] == 0x38)
                {
                    sniffedType = "image/gif";
                    sniffedExtension = ".gif";
                }
                else if (bytes[0] == 0x25 && bytes[1] == 0x50 && bytes[2] == 0x44 && bytes[3] == 0x46)
                {
                    sniffedType = "application/pdf";
                    sniffedExtension = ".pdf";
                }
                else if (bytes[0] == 0x52 && bytes[1] == 0x49 && bytes[2] == 0x46 && bytes[3] == 0x46
                         && bytes[8] == 0x57 && bytes[9] == 0x45 && bytes[10] == 0x42 && bytes[11] == 0x50)
                {
                    sniffedType = "image/webp";
                    sniffedExtension = ".webp";
                }
                else if (bytes[4] == 0x66 && bytes[5] == 0x74 && bytes[6] == 0x79 && bytes[7] == 0x70)
                {
                    // ISO-BMFF ("....ftyp"): the major brand at bytes 8..12
                    // identifies the container flavour.
                    var majorBrand = Encoding.ASCII.GetString(bytes, 8, 4);
                    switch (majorBrand)
                    {
                        case "heic":
                        case "heix":
                            sniffedType = "image/heic";
                            sniffedExtension = ".heic";
                            break;
                        case "mif1":
                        case "heim":
                        case "heis":
                            sniffedType = "image/heif";
                            sniffedExtension = ".heif";
                            break;
                        case "avif":
                        case "avis":
                            sniffedType = "image/avif";
                            sniffedExtension = ".avif";
                            break;
                        // Sequence brands (msf1/hevc/hevx — burst / Live-Photo
                        // containers) are deliberately NOT mapped: the API
                        // rejects them, and letting them fall through to the
                        // extension/octet-stream path yields a clean 415
                        // instead of a misleading image/heif one.
                    }
                }
            }

            if (string.IsNullOrEmpty(fileName))
            {
                fileName = "document" + (sniffedExtension ?? string.Empty);
            }

            if (sniffedType != null)
            {
                return sniffedType;
            }

            switch (Path.GetExtension(fileName).ToLowerInvariant())
            {
                case ".png": return "image/png";
                case ".jpg":
                case ".jpeg": return "image/jpeg";
                case ".gif": return "image/gif";
                case ".webp": return "image/webp";
                case ".pdf": return "application/pdf";
                case ".heic":
                case ".hif": return "image/heic";
                case ".heif": return "image/heif";
                case ".avif": return "image/avif";
                default: return "application/octet-stream";
            }
        }
    }
}
