<?php

declare(strict_types=1);

namespace Gemina\Sdk;

use Gemina\Sdk\Model\ExtractionCompletedEventData;
use Gemina\Sdk\Model\WebhookTestEventData;

/**
 * Verify and parse an incoming Gemina webhook (HELPER_CONTRACT §6, Standard
 * Webhooks v1). Hand-written; lives outside lib/. No network, no client instance.
 */
final class GeminaWebhooks
{
    private const SECRET_PREFIX = 'whsec_';
    // Standard alphabet, padded, no whitespace. \z, not $: $ also matches before a final newline.
    private const BASE64 = '~\A(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?\z~';
    private const REQUIRED = [
        'extraction.completed' => ['correlationId' => 'is_string', 'status' => 'is_string',
                                   'resultIncluded' => 'is_bool', 'resultPath' => 'is_string'],
        'webhook.test' => ['message' => 'is_string'],
    ];
    private const MODELS = [
        'extraction.completed' => ExtractionCompletedEventData::class,
        'webhook.test' => WebhookTestEventData::class,
    ];

    private function __construct()
    {
    }

    /**
     * Verify a webhook's signature and timestamp, then parse it.
     *
     * Pass the RAW request body exactly as received (for example
     * file_get_contents('php://input')). A re-encoded body will not verify.
     * A PHP string is a value, so the body cannot change under the helper.
     *
     * @param string                        $body             the request body, as received
     * @param array<string,string|string[]> $headers          the request headers (getallheaders()); names are
     *                                                        matched ignoring ASCII case, and a value may be a list
     *                                                        or several values joined with ", "
     * @param string                        $secret           the endpoint's signing secret, whsec_...
     * @param int                           $toleranceSeconds the largest accepted distance between the clock and
     *                                                        the webhook-timestamp header
     * @param callable():(int|float)|null   $now              clock in seconds since the epoch; may return a fraction
     *
     * @throws GeminaWebhookVerificationException the delivery is not verified or cannot be parsed; getReason() says why
     */
    public static function unwrap(
        string $body,
        array $headers,
        string $secret,
        int $toleranceSeconds = 300,
        ?callable $now = null,
    ): WebhookEvent {
        $id = self::header($headers, 'webhook-id');
        $timestampText = self::header($headers, 'webhook-timestamp');
        $signatureHeader = self::header($headers, 'webhook-signature');

        if (preg_match('/\A[0-9]{1,12}\z/', $timestampText) !== 1) {
            throw self::fail('invalid_timestamp', 'The webhook-timestamp header is not a whole number of seconds.');
        }
        // Floats, not integers: a 12-digit timestamp does not fit a 32-bit integer, and every
        // whole number of that size is exact as a float. NAN and INF fail the is_finite test.
        $current = floor($now !== null ? (float) $now() : (float) time());
        if (!is_finite($current) || $toleranceSeconds < 0) {
            throw self::fail('timestamp_out_of_tolerance',
                'The clock or the tolerance is not usable, so the timestamp cannot be checked.');
        }
        if (abs($current - (float) $timestampText) > $toleranceSeconds) {
            throw self::fail('timestamp_out_of_tolerance',
                "The webhook timestamp is more than {$toleranceSeconds} seconds from the current time.");
        }

        $encoded = str_starts_with($secret, self::SECRET_PREFIX) ? substr($secret, strlen(self::SECRET_PREFIX)) : $secret;
        $key = self::decodeBase64($encoded);
        if ($key === null || $key === '') {   // not base64, or an empty key anyone could sign with
            throw self::fail('invalid_secret', 'The signing secret is not valid: expected whsec_ followed by base64.');
        }

        $expected = hash_hmac('sha256', "{$id}.{$timestampText}." . $body, $key, true);

        $matched = false;
        foreach (explode(' ', $signatureHeader) as $entry) {
            $comma = strpos($entry, ',');
            if ($comma === false || substr($entry, 0, $comma) !== 'v1') {
                continue;
            }
            $candidate = self::decodeBase64(substr($entry, $comma + 1));
            // Constant time, and no early exit: the comparison count is independent of position.
            if ($candidate !== null && hash_equals($expected, $candidate)) {
                $matched = true;
            }
        }
        if (!$matched) {
            throw self::fail('no_matching_signature', 'No signature in the webhook-signature header matches.');
        }

        $decoded = self::decodeBody($body);
        $type = isset($decoded->type) && is_string($decoded->type) ? $decoded->type : null;
        $timestamp = isset($decoded->timestamp) && is_string($decoded->timestamp) ? $decoded->timestamp : null;
        $data = $decoded->data ?? null;
        if ($type !== null && isset(self::REQUIRED[$type])) {
            $data = self::readKnownData($type, $data);
        }

        return new WebhookEvent($id, $type, $timestamp, $data, $decoded);
    }

    private static function fail(string $reason, string $message, ?\Throwable $previous = null): GeminaWebhookVerificationException
    {
        return new GeminaWebhookVerificationException($reason, $message, $previous);
    }

    /** @param array<array-key,mixed> $headers */
    private static function header(array $headers, string $name): string
    {
        $values = [];
        foreach ($headers as $key => $value) {
            // ASCII case only. Before PHP 8.2 strtolower() follows the locale: under a
            // single-byte Turkish locale it does not turn "I" into "i".
            if (strtr((string) $key, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz') !== $name || $value === null) {
                continue;
            }
            foreach (is_array($value) ? $value : [$value] as $item) {
                if (!is_scalar($item) && !$item instanceof \Stringable) {
                    continue;   // an array or an object PHP cannot turn into text is not a header value
                }
                foreach (explode(', ', (string) $item) as $part) {   // a repeat that was already joined
                    $values[$part] = true;
                }
            }
        }
        if ($values === []) {
            throw self::fail('missing_header', "The {$name} header is missing.");
        }
        if (count($values) > 1) {
            throw self::fail('ambiguous_header', "The {$name} header was sent more than once with different values.");
        }
        // An array key that looks like a whole number becomes an integer key: cast it back.
        return (string) array_key_first($values);
    }

    private static function decodeBody(string $body): object
    {
        if (str_starts_with($body, "\xEF\xBB\xBF")) {
            throw self::fail('invalid_body', 'The webhook body starts with a byte order mark.');
        }
        try {
            // Objects as stdClass, as ObjectSerializer expects; the same call the polling path makes.
            // json_decode also refuses bytes that are not UTF-8, a second value, and NaN.
            $decoded = json_decode($body, false, 512, JSON_THROW_ON_ERROR);
        } catch (\JsonException $e) {
            throw self::fail('invalid_body', 'The webhook body is not valid JSON.', $e);
        }
        if (!is_object($decoded)) {
            throw self::fail('invalid_body', 'The webhook body is not a JSON object.');
        }
        return $decoded;
    }

    private static function readKnownData(string $type, mixed $data): object
    {
        $complete = is_object($data);
        foreach (self::REQUIRED[$type] as $field => $check) {
            $complete = $complete && $check($data->{$field} ?? null);
        }
        if ($complete && $type === 'extraction.completed') {
            $complete = self::payloadIsWhole($data);
        }
        if (!$complete) {
            throw self::fail('invalid_body', "The data of this {$type} event is missing a required field.");
        }
        try {
            $typed = ObjectSerializer::deserialize($data, self::MODELS[$type]);
        } catch (\Throwable $e) {
            // The generated serializer documents no exception set; the contract allows one type out.
            throw self::fail('invalid_body', "The data of this {$type} event could not be read.", $e);
        }
        if (!is_object($typed)) {
            throw self::fail('invalid_body', "The data of this {$type} event could not be read.");
        }
        return $typed;
    }

    /** A result or an error that is set must hold its required fields, and the two are never both set. */
    private static function payloadIsWhole(object $data): bool
    {
        $result = $data->result ?? null;
        $error = $data->error ?? null;
        if ($result !== null && $error !== null) {
            return false;
        }
        if ($result !== null && !(is_object($result) && is_string($result->status ?? null)
                && is_object($result->meta ?? null) && property_exists($result, 'data'))) {
            return false;
        }
        return $error === null || (is_object($error) && is_string($error->status ?? null));
    }

    private static function decodeBase64(string $text): ?string
    {
        if (preg_match(self::BASE64, $text) !== 1) {
            return null;
        }
        $decoded = base64_decode($text, true);
        return $decoded === false ? null : $decoded;
    }
}
