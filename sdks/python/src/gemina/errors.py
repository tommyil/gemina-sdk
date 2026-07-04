"""Hand-written SDK error types.

Transport/HTTP errors raised by the generated client (for example
``gemina.generated.exceptions.ApiException``) pass through unwrapped.
"""

from __future__ import annotations

from typing import Any, Optional


class GeminaError(Exception):
    """Base class for all hand-written Gemina SDK errors."""


class GeminaProcessingError(GeminaError):
    """Document processing finished with a terminal ``failed`` status.

    Attributes:
        result: The full ``DocumentProcessingResultOutDTO``; its ``errors``
            list carries the failure details.
    """

    def __init__(self, result: Any) -> None:
        self.result = result
        errors = getattr(result, "errors", None)
        super().__init__(
            "Document processing finished with status 'failed'"
            + (f": {errors!r}" if errors else "")
        )


class GeminaTimeoutError(GeminaError):
    """The polling deadline (``timeout_seconds``) was exceeded.

    Attributes:
        correlation_id: The correlation ID of the in-flight request. You can
            resume polling yourself via
            ``client.documents.get_document_processing_result_by_correlation_id``.
        last_result: The last (non-terminal) result seen while polling, if any.
    """

    def __init__(self, correlation_id: Any, last_result: Optional[Any] = None) -> None:
        self.correlation_id = correlation_id
        self.last_result = last_result
        super().__init__(
            f"Timed out waiting for document processing result "
            f"(correlationId={correlation_id}). The request is still running "
            f"server-side; resume polling with client.documents."
            f"get_document_processing_result_by_correlation_id()."
        )
