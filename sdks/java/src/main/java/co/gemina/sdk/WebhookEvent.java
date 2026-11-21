package co.gemina.sdk;

import com.google.gson.JsonObject;

/** A verified webhook, as returned by {@link GeminaWebhooks#unwrap}. */
public final class WebhookEvent {

    private final String id;
    private final String type;
    private final String timestamp;
    private final Object data;
    private final JsonObject raw;

    WebhookEvent(String id, String type, String timestamp, Object data, JsonObject raw) {
        this.id = id;
        this.type = type;
        this.timestamp = timestamp;
        this.data = data;
        this.raw = raw;
    }

    /** The {@code webhook-id} header. The same on every retry: deduplicate on it. */
    public String getId() {
        return id;
    }

    /** {@code extraction.completed}, {@code webhook.test}, a type added later, or null when the body has no type. */
    public String getType() {
        return type;
    }

    /** When the event was recorded, as sent; the same on every retry. */
    public String getTimestamp() {
        return timestamp;
    }

    /**
     * {@link co.gemina.sdk.generated.model.ExtractionCompletedEventData} or
     * {@link co.gemina.sdk.generated.model.WebhookTestEventData} for the known types
     * (narrow with {@code instanceof}); the parsed {@link com.google.gson.JsonElement}
     * for any other type.
     */
    public Object getData() {
        return data;
    }

    /** The whole parsed body. */
    public JsonObject getRaw() {
        return raw;
    }
}
