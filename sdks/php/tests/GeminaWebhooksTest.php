<?php

declare(strict_types=1);

namespace Gemina\Sdk\Tests;

use Gemina\Sdk\GeminaException;
use Gemina\Sdk\GeminaWebhooks;
use Gemina\Sdk\GeminaWebhookVerificationException;
use Gemina\Sdk\Model\DocumentProcessingResultOutDTO;
use Gemina\Sdk\Model\ExtractionCompletedEventData;
use Gemina\Sdk\Model\WebhookTestEventData;
use Gemina\Sdk\ObjectSerializer;
use Gemina\Sdk\WebhookEvent;
use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\TestCase;

/**
 * GeminaWebhooks::unwrap against the shared vectors (contract §6), read from
 * this package's synced copies in tests/fixtures. Mirrors
 * sdks/python/tests/test_webhooks.py case for case, except where a PHP string
 * makes a case meaningless: a string is bytes and a value, so there is no
 * separate bytes form, no caller buffer to change, and no unpaired surrogate.
 */
final class GeminaWebhooksTest extends TestCase
{
    /** @return array{valid: list<array<string,mixed>>, invalid: list<array<string,mixed>>} */
    private static function load(string $name): array
    {
        // Associative arrays: two header names that differ only in case stay two entries.
        return json_decode((string) file_get_contents(__DIR__ . '/fixtures/' . $name), true, 512, JSON_THROW_ON_ERROR);
    }

    private static function shared(): array
    {
        return self::load('webhook_test_vectors.json');
    }

    private static function typed(): array
    {
        return self::load('webhook_typed_vectors.json');
    }

    /** @return array<string, array{0: array<string,mixed>}> */
    private static function keyed(array $vectors): array
    {
        $out = [];
        foreach ($vectors as $vector) {
            $out[$vector['name']] = [$vector];
        }
        return $out;
    }

    public static function validVectors(): array
    {
        return self::keyed(array_merge(self::shared()['valid'], self::typed()['valid']));
    }

    public static function invalidVectors(): array
    {
        return self::keyed(array_merge(self::shared()['invalid'], self::typed()['invalid']));
    }

    private static function named(array $list, string $name): array
    {
        foreach ($list as $vector) {
            if ($vector['name'] === $name) {
                return $vector;
            }
        }
        throw new \LogicException("no vector named {$name}");
    }

    private static function utf8(): array
    {
        return self::named(self::shared()['valid'], 'extraction-completed-utf8-body');
    }

    private static function unwrap(array $vector, ?array $headers = null, int $tolerance = 300): WebhookEvent
    {
        $now = $vector['now'];
        return GeminaWebhooks::unwrap($vector['body'], $headers ?? $vector['headers'], $vector['secret'], $tolerance, fn () => $now);
    }

    private function reasonOf(callable $call): string
    {
        try {
            $call();
        } catch (GeminaWebhookVerificationException $error) {
            $this->assertInstanceOf(GeminaException::class, $error);
            return $error->getReason();
        }
        $this->fail('expected the delivery to be rejected');
    }

    /** The vector's headers, re-signed for another body. */
    private static function signed(array $vector, string $body, ?string $timestamp = null): array
    {
        $headers = array_change_key_case($vector['headers'], CASE_LOWER);
        if ($timestamp !== null) {
            $headers['webhook-timestamp'] = $timestamp;
        }
        $key = base64_decode(substr($vector['secret'], strlen('whsec_')), true);
        $mac = hash_hmac('sha256', "{$headers['webhook-id']}.{$headers['webhook-timestamp']}." . $body, $key, true);
        $headers['webhook-signature'] = 'v1,' . base64_encode($mac);
        return $headers;
    }

    private static function otherSignature(): string
    {
        return 'v1,' . base64_encode(str_repeat("\0", 32));
    }

    public function testEveryVectorIsLoaded(): void
    {
        // A truncated or mis-copied file would otherwise shrink the data providers silently.
        $this->assertSame([12, 30], [count(self::shared()['valid']), count(self::shared()['invalid'])]);
        $this->assertSame([2, 3], [count(self::typed()['valid']), count(self::typed()['invalid'])]);
    }

    #[DataProvider('validVectors')]
    public function testValidVectorsVerify(array $vector): void
    {
        $event = self::unwrap($vector);
        $this->assertSame($vector['expectType'], $event->type);
        // The id header specifically: "one of the header values" would also pass for the timestamp.
        $this->assertSame(array_change_key_case($vector['headers'], CASE_LOWER)['webhook-id'], $event->id);
    }

    #[DataProvider('invalidVectors')]
    public function testInvalidVectorsAreRejectedWithTheExactReason(array $vector): void
    {
        $this->assertSame($vector['reason'], $this->reasonOf(fn () => self::unwrap($vector)));
    }

    public function testExtractionCompletedDataIsTyped(): void
    {
        $event = self::unwrap(self::utf8());
        $this->assertInstanceOf(ExtractionCompletedEventData::class, $event->data);
        $this->assertSame('3f2b6c1e-0d4a-4a57-9a43-1f0e5a7b9c10', $event->data->getCorrelationId());
        $this->assertSame('חשבונית-2291', $event->data->getExternalId());
        $this->assertFalse($event->data->getResultIncluded());
        $this->assertNull($event->data->getResult());
        $this->assertSame('2026-11-18T10:15:30Z', $event->timestamp);
    }

    public function testAnIncludedResultIsParsedLikeThePollingPathParsesIt(): void
    {
        $event = self::unwrap(self::named(self::typed()['valid'], 'extraction-completed-with-result'));
        $this->assertInstanceOf(ExtractionCompletedEventData::class, $event->data);
        $this->assertNull($event->data->getError());
        // The wire values, which every language asserts the same way:
        $wireMeta = $event->raw->data->result->data->extractions[0]->meta;
        $this->assertNull($wireMeta->purgeReason);
        $this->assertSame('2026-08-03T17:20:13.180624', $wireMeta->purgeAt);
        // The typed side: exactly what the polling path (json_decode, then ObjectSerializer) gives.
        $polled = ObjectSerializer::deserialize(
            json_decode(json_encode($event->raw->data->result), false, 512, JSON_THROW_ON_ERROR),
            DocumentProcessingResultOutDTO::class
        );
        $this->assertEquals($polled, $event->data->getResult());
        $meta = $event->data->getResult()->getData()->getExtractions()[0]->getMeta();
        $this->assertNull($meta->getPurgeReason());
        $this->assertSame('2026-08-03T17:20:13.180624', $meta->getPurgeAt()->format('Y-m-d\TH:i:s.u'));
        $this->assertSame('28677df7-033a-409f-8b70-1568ddd17ea0', $event->data->getResult()->getMeta()->getDocumentId());
    }

    public function testAnErrorEnvelopeIsTyped(): void
    {
        $data = self::unwrap(self::named(self::typed()['valid'], 'extraction-completed-with-error'))->data;
        $this->assertInstanceOf(ExtractionCompletedEventData::class, $data);
        $this->assertNull($data->getResult());
        $this->assertSame('failed', $data->getStatus());
        $this->assertSame('PROCESSING_ERROR', $data->getError()->getErrors()[0]['error_code']);
    }

    public function testTheTestEventMessageIsTyped(): void
    {
        $data = self::unwrap(self::named(self::shared()['valid'], 'test-event'))->data;
        $this->assertInstanceOf(WebhookTestEventData::class, $data);
        $this->assertSame('This is a test event from Gemina.', $data->getMessage());
    }

    public function testAnUnknownEventTypeKeepsItsTypeAndItsData(): void
    {
        $event = self::unwrap(self::named(self::shared()['valid'], 'unknown-future-event-type'));
        $this->assertSame('invoice.archived', $event->type);
        $this->assertEquals(json_decode('{"documentId":"9b1d4f0a-6c2e-4d8b-8f31-5a7c0e2b4d66","nested":{"n":1}}'), $event->data);
    }

    public function testABodyWithNoTypeIsReturnedRaw(): void
    {
        $event = self::unwrap(self::named(self::shared()['valid'], 'standard-webhooks-published-example'));
        $this->assertNull($event->type);
        $this->assertEquals(json_decode('{"test":2432232314}'), $event->raw);
    }

    public function testACustomToleranceIsHonoured(): void
    {
        $this->assertSame('extraction.completed', self::unwrap(self::named(self::shared()['invalid'], 'timestamp-too-old'), null, 600)->type);
    }

    public function testTheDefaultsNeedNoOptions(): void
    {
        // The real clock: a vector from 2026-11-18 is long out of tolerance.
        $vector = self::utf8();
        $this->assertSame('timestamp_out_of_tolerance',
            $this->reasonOf(fn () => GeminaWebhooks::unwrap($vector['body'], $vector['headers'], $vector['secret'])));
    }

    public static function headerOrders(): array
    {
        return ['lower first' => ['webhook-id', 'Webhook-Id'], 'title first' => ['Webhook-Id', 'webhook-id']];
    }

    #[DataProvider('headerOrders')]
    public function testARepeatedHeaderIsJudgedTheSameInEitherOrder(string $first, string $second): void
    {
        $vector = self::utf8();
        $real = $vector['headers']['webhook-id'];
        $rest = array_diff_key($vector['headers'], ['webhook-id' => true]);
        $this->assertSame($real, self::unwrap($vector, [$first => $real, $second => $real] + $rest)->id);
        $this->assertSame('ambiguous_header',
            $this->reasonOf(fn () => self::unwrap($vector, [$first => $real, $second => 'evt_other'] + $rest)));
    }

    public function testARepeatedHeaderThatALibraryAlreadyJoinedIsJudgedTheSame(): void
    {
        $vector = self::utf8();
        $signature = $vector['headers']['webhook-signature'];
        $this->assertSame('extraction.completed',
            self::unwrap($vector, ['webhook-signature' => "{$signature}, {$signature}"] + $vector['headers'])->type);
        foreach ([self::otherSignature() . ", {$signature}", "{$signature}, " . self::otherSignature()] as $joined) {
            $this->assertSame('ambiguous_header',
                $this->reasonOf(fn () => self::unwrap($vector, ['webhook-signature' => $joined] + $vector['headers'])));
        }
    }

    public function testAHeaderGivenAsAListContributesEachItem(): void
    {
        $vector = self::utf8();
        $signature = $vector['headers']['webhook-signature'];
        $this->assertSame('extraction.completed',
            self::unwrap($vector, ['webhook-signature' => [$signature, $signature]] + $vector['headers'])->type);
        $this->assertSame('ambiguous_header', $this->reasonOf(
            fn () => self::unwrap($vector, ['webhook-signature' => [$signature, self::otherSignature()]] + $vector['headers'])));
    }

    public static function lookalikeNames(): array
    {
        // KELVIN SIGN lower-cases to "k" and DOTLESS I upper-cases to "I" under Unicode rules.
        return ['kelvin sign' => ["webhoo\u{212A}-id"], 'dotless i' => ["webhook-\u{0131}d"]];
    }

    #[DataProvider('lookalikeNames')]
    public function testHeaderNamesAreFoldedByAsciiCaseOnly(string $lookalike): void
    {
        $vector = self::utf8();
        $rest = array_diff_key($vector['headers'], ['webhook-id' => true]);
        $this->assertSame('missing_header',
            $this->reasonOf(fn () => self::unwrap($vector, [$lookalike => $vector['headers']['webhook-id']] + $rest)));
    }

    public function testHeaderNamesFoldTheSameUnderASingleByteTurkishLocale(): void
    {
        // Astra round 9, C1: before PHP 8.2, strtolower() follows LC_CTYPE, and under a
        // single-byte Turkish locale "I" does not lower-case to "i". Only an application's
        // setlocale() call changes LC_CTYPE; the environment alone does not.
        $previous = setlocale(LC_CTYPE, '0');
        if (setlocale(LC_CTYPE, 'tr_TR.ISO-8859-9', 'tr_TR.ISO8859-9') === false) {
            $this->markTestSkipped('the tr_TR.ISO-8859-9 locale is not installed here');
        }
        try {
            $this->assertSame('extraction.completed', self::unwrap(self::named(self::shared()['valid'], 'header-names-mixed-case'))->type);
            $conflict = self::named(self::shared()['invalid'], 'same-header-twice-with-different-values');
            $this->assertSame('ambiguous_header', $this->reasonOf(fn () => self::unwrap($conflict)));
        } finally {
            setlocale(LC_CTYPE, $previous);
        }
    }

    public static function unusableClockOrTolerance(): array
    {
        return [
            'tolerance -1' => [-1, null],
            'clock NAN' => [300, NAN],
            'clock INF' => [300, INF],
            'clock -INF' => [300, -INF],
        ];
    }

    #[DataProvider('unusableClockOrTolerance')]
    public function testAClockOrToleranceThatIsNotUsableNeverSwitchesTheCheckOff(int $tolerance, ?float $clock): void
    {
        // An expired delivery, correctly signed. NAN makes "difference > tolerance" false: it must not pass.
        // (A NAN or INF tolerance cannot reach the helper: the int parameter refuses it with a TypeError.)
        $vector = self::named(self::shared()['invalid'], 'timestamp-too-old');
        $now = $clock ?? $vector['now'];
        $this->assertSame('timestamp_out_of_tolerance', $this->reasonOf(
            fn () => GeminaWebhooks::unwrap($vector['body'], $vector['headers'], $vector['secret'], $tolerance, fn () => $now)));
    }

    public function testATimestampAbove2To31Verifies(): void
    {
        // A 32-bit build would overflow if the age were computed with integers.
        $vector = self::utf8();
        $headers = self::signed($vector, $vector['body'], '4000000000');
        $event = GeminaWebhooks::unwrap($vector['body'], $headers, $vector['secret'], 300, fn () => 4000000000);
        $this->assertSame('extraction.completed', $event->type);
    }

    public function testASignedBodyThatIsNotUtf8IsRejected(): void
    {
        $vector = self::utf8();
        $body = "{\"type\":\"extraction.completed\",\"data\":\"\xFF\"}";
        $this->assertSame('invalid_body', $this->reasonOf(
            fn () => GeminaWebhooks::unwrap($body, self::signed($vector, $body), $vector['secret'], 300, fn () => $vector['now'])));
    }

    public function testOnlyTheVerificationErrorEverLeavesTheHelper(): void
    {
        $vector = self::utf8();
        foreach ([[], ['webhook-id' => null], ['webhook-timestamp' => str_repeat('9', 400)]] as $headers) {
            $this->reasonOf(fn () => GeminaWebhooks::unwrap($vector['body'], $headers, $vector['secret']));
        }
    }
}
