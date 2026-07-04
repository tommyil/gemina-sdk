package co.gemina.sdk;

import java.util.Random;
import java.util.UUID;

import co.gemina.sdk.generated.model.ModelType;

/**
 * Optional knobs for {@link GeminaClient#processDocument}. All fields are
 * optional; unset submission fields are simply omitted from the request.
 *
 * <p>Submission options mirror the async endpoint form fields:
 * {@code externalId}, {@code templateId}, {@code modelType}, {@code thinking},
 * {@code evaluation}, {@code correction}, {@code includeCoordinates},
 * {@code endUserId}.</p>
 *
 * <p>Polling knobs: {@code timeoutSeconds} (default 300), {@code
 * initialIntervalSeconds} (default 2.0, growing x1.5 per attempt), {@code
 * maxIntervalSeconds} (default 15.0). {@code sleeper} and {@code random} are
 * injectable for tests.</p>
 *
 * <pre>{@code
 * ProcessDocumentOptions options = ProcessDocumentOptions.builder()
 *         .externalId("invoice-2026-001")
 *         .timeoutSeconds(120)
 *         .build();
 * }</pre>
 */
public final class ProcessDocumentOptions {

    /** Default overall polling deadline, in seconds. */
    public static final double DEFAULT_TIMEOUT_SECONDS = 300.0;
    /** Default first poll interval, in seconds. */
    public static final double DEFAULT_INITIAL_INTERVAL_SECONDS = 2.0;
    /** Default poll interval cap, in seconds. */
    public static final double DEFAULT_MAX_INTERVAL_SECONDS = 15.0;

    private final String externalId;
    private final UUID templateId;
    private final ModelType modelType;
    private final Boolean thinking;
    private final Boolean evaluation;
    private final Boolean correction;
    private final Boolean includeCoordinates;
    private final String endUserId;

    private final double timeoutSeconds;
    private final double initialIntervalSeconds;
    private final double maxIntervalSeconds;
    private final Sleeper sleeper;
    private final Random random;

    private ProcessDocumentOptions(Builder builder) {
        this.externalId = builder.externalId;
        this.templateId = builder.templateId;
        this.modelType = builder.modelType;
        this.thinking = builder.thinking;
        this.evaluation = builder.evaluation;
        this.correction = builder.correction;
        this.includeCoordinates = builder.includeCoordinates;
        this.endUserId = builder.endUserId;
        this.timeoutSeconds = builder.timeoutSeconds;
        this.initialIntervalSeconds = builder.initialIntervalSeconds;
        this.maxIntervalSeconds = builder.maxIntervalSeconds;
        this.sleeper = builder.sleeper;
        this.random = builder.random;
    }

    public static Builder builder() {
        return new Builder();
    }

    /** Options with all defaults. */
    public static ProcessDocumentOptions defaults() {
        return builder().build();
    }

    public String getExternalId() {
        return externalId;
    }

    public UUID getTemplateId() {
        return templateId;
    }

    public ModelType getModelType() {
        return modelType;
    }

    public Boolean getThinking() {
        return thinking;
    }

    public Boolean getEvaluation() {
        return evaluation;
    }

    public Boolean getCorrection() {
        return correction;
    }

    public Boolean getIncludeCoordinates() {
        return includeCoordinates;
    }

    public String getEndUserId() {
        return endUserId;
    }

    public double getTimeoutSeconds() {
        return timeoutSeconds;
    }

    public double getInitialIntervalSeconds() {
        return initialIntervalSeconds;
    }

    public double getMaxIntervalSeconds() {
        return maxIntervalSeconds;
    }

    public Sleeper getSleeper() {
        return sleeper;
    }

    public Random getRandom() {
        return random;
    }

    public static final class Builder {

        private String externalId;
        private UUID templateId;
        private ModelType modelType;
        private Boolean thinking;
        private Boolean evaluation;
        private Boolean correction;
        private Boolean includeCoordinates;
        private String endUserId;

        private double timeoutSeconds = DEFAULT_TIMEOUT_SECONDS;
        private double initialIntervalSeconds = DEFAULT_INITIAL_INTERVAL_SECONDS;
        private double maxIntervalSeconds = DEFAULT_MAX_INTERVAL_SECONDS;
        private Sleeper sleeper = Sleeper.DEFAULT;
        private Random random = new Random();

        private Builder() {
        }

        /**
         * Your own identifier for the document (1-100 chars). When unset, the
         * SDK generates a random UUID string.
         */
        public Builder externalId(String externalId) {
            this.externalId = externalId;
            return this;
        }

        /** Template ID for {@code custom_template} extraction. */
        public Builder templateId(UUID templateId) {
            this.templateId = templateId;
            return this;
        }

        /** The model type to use for the document. */
        public Builder modelType(ModelType modelType) {
            this.modelType = modelType;
            return this;
        }

        /** Whether to use the Thinking model for the document. */
        public Builder thinking(Boolean thinking) {
            this.thinking = thinking;
            return this;
        }

        /** Whether to use the Evaluation model for the document. */
        public Builder evaluation(Boolean evaluation) {
            this.evaluation = evaluation;
            return this;
        }

        /** Whether to use the Correction model for the document. */
        public Builder correction(Boolean correction) {
            this.correction = correction;
            return this;
        }

        /** Whether to include coordinates in the extraction results. */
        public Builder includeCoordinates(Boolean includeCoordinates) {
            this.includeCoordinates = includeCoordinates;
            return this;
        }

        /** End User ID for the document. */
        public Builder endUserId(String endUserId) {
            this.endUserId = endUserId;
            return this;
        }

        /** Overall polling deadline in seconds (default 300). */
        public Builder timeoutSeconds(double timeoutSeconds) {
            this.timeoutSeconds = timeoutSeconds;
            return this;
        }

        /** First poll interval in seconds (default 2.0; grows x1.5 per attempt). */
        public Builder initialIntervalSeconds(double initialIntervalSeconds) {
            this.initialIntervalSeconds = initialIntervalSeconds;
            return this;
        }

        /** Poll interval cap in seconds (default 15.0). */
        public Builder maxIntervalSeconds(double maxIntervalSeconds) {
            this.maxIntervalSeconds = maxIntervalSeconds;
            return this;
        }

        /** Injectable wait between polls; production default is {@code Thread::sleep}. */
        public Builder sleeper(Sleeper sleeper) {
            this.sleeper = sleeper;
            return this;
        }

        /** RNG for the [0.8, 1.2] poll jitter; injectable for deterministic tests. */
        public Builder random(Random random) {
            this.random = random;
            return this;
        }

        public ProcessDocumentOptions build() {
            if (timeoutSeconds <= 0) {
                throw new IllegalArgumentException("timeoutSeconds must be > 0");
            }
            if (initialIntervalSeconds <= 0) {
                throw new IllegalArgumentException("initialIntervalSeconds must be > 0");
            }
            if (maxIntervalSeconds < initialIntervalSeconds) {
                throw new IllegalArgumentException("maxIntervalSeconds must be >= initialIntervalSeconds");
            }
            if (sleeper == null) {
                throw new IllegalArgumentException("sleeper must not be null");
            }
            if (random == null) {
                throw new IllegalArgumentException("random must not be null");
            }
            return new ProcessDocumentOptions(this);
        }
    }
}
