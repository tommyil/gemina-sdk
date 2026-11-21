<?php

declare(strict_types=1);

namespace Gemina\Sdk;

/**
 * Thrown by GeminaWebhooks::unwrap() when an incoming webhook cannot be
 * verified or parsed (contract §6). No other exception type leaves the helper.
 */
class GeminaWebhookVerificationException extends GeminaException
{
    /**
     * @param string $reason missing_header|ambiguous_header|invalid_timestamp|timestamp_out_of_tolerance|invalid_secret|no_matching_signature|invalid_body
     */
    public function __construct(private readonly string $reason, string $message, ?\Throwable $previous = null)
    {
        parent::__construct($message, 0, $previous);
    }

    /**
     * Why the delivery was refused: missing_header, ambiguous_header,
     * invalid_timestamp, timestamp_out_of_tolerance, invalid_secret,
     * no_matching_signature or invalid_body: the constants of
     * GeminaWebhookVerificationReason.
     */
    public function getReason(): string
    {
        return $this->reason;
    }
}
