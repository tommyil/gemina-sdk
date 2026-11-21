<?php

declare(strict_types=1);

namespace Gemina\Sdk;

/** A verified webhook, as returned by GeminaWebhooks::unwrap(). */
final class WebhookEvent
{
    /**
     * @param string      $id        The webhook-id header. The same on every retry: deduplicate on it.
     * @param string|null $type      extraction.completed, webhook.test, a type added later, or null when the body has no type.
     * @param string|null $timestamp When the event was recorded, as sent; the same on every retry.
     * @param mixed       $data      Model\ExtractionCompletedEventData or Model\WebhookTestEventData for the
     *                               known types; the decoded value for any other type.
     * @param object      $raw       The whole decoded body.
     */
    public function __construct(
        public readonly string $id,
        public readonly ?string $type,
        public readonly ?string $timestamp,
        public readonly mixed $data,
        public readonly object $raw,
    ) {
    }
}
