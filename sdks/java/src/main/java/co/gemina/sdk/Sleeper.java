package co.gemina.sdk;

/**
 * Injectable wait used by {@link GeminaClient#processDocument} between polls.
 * The production default is {@link Thread#sleep(long)}; unit tests inject a
 * recording no-op to assert the backoff schedule without real waiting.
 */
@FunctionalInterface
public interface Sleeper {

    /** Production default: {@link Thread#sleep(long)}. */
    Sleeper DEFAULT = Thread::sleep;

    void sleep(long millis) throws InterruptedException;
}
