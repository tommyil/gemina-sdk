using System;
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
    /// member, which the generator adds to every enum (<c>enumUnknownDefaultCase</c>). Every
    /// other token, and writing, behaves as <see cref="StringEnumConverter"/>.
    /// </summary>
    internal sealed class UnknownEnumValueConverter : StringEnumConverter
    {
        internal const string UnknownMember = "UnknownDefaultOpenApi";

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
}
