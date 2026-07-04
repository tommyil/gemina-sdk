namespace Gemina.Sdk
{
    /// <summary>
    /// Version of the hand-written Gemina SDK package. This is the single
    /// source of truth consumed by the user-agent string; the generated
    /// client's metadata version is irrelevant.
    /// </summary>
    public static class SdkVersion
    {
        /// <summary>The package version, kept in sync with the csproj.</summary>
        public const string Version = "0.1.1";
    }
}
