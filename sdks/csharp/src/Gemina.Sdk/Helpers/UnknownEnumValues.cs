using System;
using Gemina.Sdk.Client;
using Newtonsoft.Json;
using Newtonsoft.Json.Converters;
using Newtonsoft.Json.Serialization;

namespace Gemina.Sdk
{
    /// <summary>
    /// Resolves every generated enum to <see cref="UnknownEnumValueConverter"/>, in place of the
    /// <c>StringEnumConverter</c> its attribute names. The polling path (DocumentTransport) and
    /// GeminaWebhooks read with it, so a value the API adds to an enum later does not fail a
    /// whole result.
    /// </summary>
    internal sealed class UnknownEnumValueContractResolver : DefaultContractResolver
    {
        private static readonly JsonConverter Converter = new UnknownEnumValueConverter();

        protected override JsonConverter ResolveContractConverter(Type objectType)
        {
            var type = Nullable.GetUnderlyingType(objectType) ?? objectType;
            return UnknownEnumValueConverter.HasUnknownMember(type) ? Converter : base.ResolveContractConverter(objectType);
        }
    }

    /// <summary>
    /// Reads a string that is not one of an enum's values as its <c>UnknownDefaultOpenApi</c>
    /// member, which the generator adds to every enum (<c>enumUnknownDefaultCase</c>). Any other
    /// kind of value (a number, an object, an array) is refused; writing behaves as
    /// <see cref="StringEnumConverter"/>.
    /// </summary>
    internal sealed class UnknownEnumValueConverter : StringEnumConverter
    {
        internal const string UnknownMember = "UnknownDefaultOpenApi";

        /// <summary>
        /// Integers are refused: only a string can be a value added later, and
        /// StringEnumConverter would otherwise read 42 as an undefined member.
        /// </summary>
        public UnknownEnumValueConverter()
        {
            AllowIntegerValues = false;
        }

        internal static bool HasUnknownMember(Type type) => type.IsEnum && Enum.IsDefined(type, UnknownMember);

        public override object ReadJson(JsonReader reader, Type objectType, object existingValue, JsonSerializer serializer)
        {
            var enumType = Nullable.GetUnderlyingType(objectType) ?? objectType;
            var isString = reader.TokenType == JsonToken.String;
            try
            {
                return base.ReadJson(reader, objectType, existingValue, serializer);
            }
            catch (JsonSerializationException) when (isString && HasUnknownMember(enumType))
            {
                return Enum.Parse(enumType, UnknownMember);
            }
        }
    }

    /// <summary>The HTTP clients of a generated API group (public properties of every group).</summary>
    internal interface IGeneratedApiClients
    {
        ISynchronousClient Client { get; }

        IAsynchronousClient AsynchronousClient { get; }
    }

    /// <summary>Gives the generated groups the facade builds the same unknown-enum tolerance.</summary>
    internal static class UnknownEnumValues
    {
        /// <summary>
        /// The same settings the generated <c>ApiClient</c> starts with, read through
        /// <see cref="UnknownEnumValueContractResolver"/>.
        /// </summary>
        internal static UnknownEnumValueContractResolver NewContractResolver() => new UnknownEnumValueContractResolver
        {
            NamingStrategy = new CamelCaseNamingStrategy
            {
                OverrideSpecifiedNames = false,
            },
        };

        /// <summary>Points the group's own HTTP clients at the tolerant contract resolver.</summary>
        internal static T Tolerate<T>(T api) where T : IGeneratedApiClients
        {
            Apply(api.Client);
            Apply(api.AsynchronousClient);
            return api;
        }

        private static void Apply(object client)
        {
            // A group built with a caller's own client keeps that client as it is.
            if (client is ApiClient generated)
            {
                generated.SerializerSettings.ContractResolver = NewContractResolver();
            }
        }
    }
}

namespace Gemina.Sdk.Api
{
    // The generated groups are partial classes, and each already has public Client and
    // AsynchronousClient properties; these declarations only name them for the facade.
    public partial class BillingApi : IGeneratedApiClients { }

    public partial class ChatApi : IGeneratedApiClients { }

    public partial class DocumentApi : IGeneratedApiClients { }

    public partial class FileTagApi : IGeneratedApiClients { }

    public partial class FilesApi : IGeneratedApiClients { }

    public partial class RetrievalApi : IGeneratedApiClients { }

    public partial class SessionsApi : IGeneratedApiClients { }

    public partial class SubscriptionsApi : IGeneratedApiClients { }

    public partial class TemplatesApi : IGeneratedApiClients { }

    public partial class WebhooksApi : IGeneratedApiClients { }
}
