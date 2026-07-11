"""Hand-written convenience layer on top of the generated Gemina client.

Implements the cross-language helper contract: a ``GeminaClient`` facade over
the generated ``*Api`` groups plus the headline ``process_document`` helper
(submit via the async endpoints, poll with jittered exponential backoff,
return the typed terminal result).
"""

from __future__ import annotations

import asyncio
import os
import random
import time
import uuid
from dataclasses import dataclass
from typing import Any, List, Optional, Tuple, Union
from uuid import UUID

import httpx

from gemina._version import __version__
from gemina.errors import GeminaError, GeminaProcessingError, GeminaTimeoutError
from gemina.generated.api_client import ApiClient
from gemina.generated.configuration import Configuration
from gemina.generated.exceptions import ApiException
from gemina.generated.models.chat_query_in_dto import ChatQueryInDTO
from gemina.generated.models.chat_query_out_dto import ChatQueryOutDTO
from gemina.generated.models.document_processing_result_out_dto import (
    DocumentProcessingResultOutDTO,
)
from gemina.generated.models.extraction_type_model import ExtractionTypeModel
from gemina.generated.models.model_type import ModelType
from gemina.generated.models.response_status import ResponseStatus
from gemina.generated.models.web_document_upload_in_dto import WebDocumentUploadInDTO

DEFAULT_BASE_URL = "https://api.gemina.co"

#: Statuses that end polling. ``failed`` raises; the rest are returned.
_TERMINAL_STATUSES = frozenset(
    {
        ResponseStatus.SUCCESS,
        ResponseStatus.PARTIAL,
        ResponseStatus.EMPTY,
        ResponseStatus.FAILED,
    }
)

# Module-level indirection so unit tests can substitute a fake clock.
_monotonic = time.monotonic

#: Transient poll failures tolerated in a row before the error is rethrown.
_MAX_CONSECUTIVE_POLL_FAILURES = 3


@dataclass(frozen=True)
class UrlSource:
    """Marks a ``process_document`` source as a URL reference.

    URLs are submitted via ``POST /v1/documents/requests/web``; everything
    else (paths, bytes, file-like objects) goes through the multipart
    ``POST /v1/documents/requests`` endpoint.
    """

    url: str


class GeminaChatConversation:
    """A stateful chat conversation that threads the server-issued
    ``session_id`` across turns, so follow-up questions keep context — you
    never touch the id yourself::

        chat = client.conversation()
        await chat.send("How much did I spend at Acme in Q1?")
        await chat.send("And the biggest invoice?")  # remembers Acme / Q1
        await chat.delete()                           # end it server-side

    A turn that carries a stale session (24h idle TTL, or after ``reset``)
    fails with the API's ``404 CHAT_SESSION_NOT_FOUND``; catch it, call
    ``reset()``, and resend to continue in a fresh conversation.
    """

    def __init__(self, chat: Any, end_user_id: Optional[str] = None) -> None:
        self._chat = chat
        self._end_user_id = end_user_id
        self._current_session_id: Optional[UUID] = None

    @property
    def session_id(self) -> Optional[UUID]:
        """The current conversation id — ``None`` before the first turn or
        after a ``reset``."""
        return self._current_session_id

    async def send(self, message: str) -> ChatQueryOutDTO:
        """Send one turn; its answer continues this conversation."""
        result = await self._chat.chat_query(
            ChatQueryInDTO(
                message=message,
                end_user_id=self._end_user_id,
                session_id=self._current_session_id,
            )
        )
        if result.session_id is not None:
            self._current_session_id = result.session_id
        return result

    def reset(self) -> None:
        """Forget the conversation locally; the next ``send`` starts a new one."""
        self._current_session_id = None

    async def delete(self) -> None:
        """End the conversation: delete it server-side (mirrors a 'New chat'
        action) and forget it locally. No-op if no turn has been sent yet."""
        session_id = self._current_session_id
        self._current_session_id = None
        if session_id is not None:
            await self._chat.delete_chat_session(session_id)


class GeminaClient:
    """Facade over the generated Gemina API client.

    Use as an async context manager so the underlying HTTP connection pool is
    closed deterministically::

        async with GeminaClient("YOUR_API_KEY") as client:
            result = await client.process_document(
                "invoice.png", [ExtractionTypeModel.INVOICE_HEADERS]
            )

    The generated API groups are exposed as lazily-constructed attributes
    (``documents``, ``retrieval``, ``chat``, ``templates``, ``files``,
    ``file_tag``, ``sessions``, ``subscriptions``, ``billing``) — the full
    generated surface, zero wrapping.
    """

    def __init__(
        self,
        api_key: str,
        base_url: str = DEFAULT_BASE_URL,
        **options: Any,
    ) -> None:
        """Create a client authenticated with an API key (``X-API-Key``).

        ``**options`` are forwarded to the generated ``Configuration``
        (e.g. ``proxy=...``, ``ssl_ca_cert=...``, ``retries=...``).
        """
        configuration = Configuration(
            host=base_url.rstrip("/"),
            api_key={"APIKeyHeader": api_key},
            **options,
        )
        self._init_from_configuration(configuration)

    @classmethod
    def with_session_token(
        cls,
        token: str,
        base_url: str = DEFAULT_BASE_URL,
        **options: Any,
    ) -> "GeminaClient":
        """Create a client authenticated with a short-lived session token.

        Configures the ``OAuth2PasswordBearer`` scheme (``Authorization:
        Bearer <token>``) instead of the API key. Session tokens are minted
        server-side via ``client.sessions.mint_retrieval_token(...)``.
        """
        configuration = Configuration(
            host=base_url.rstrip("/"),
            access_token=token,
            **options,
        )
        client = cls.__new__(cls)
        client._init_from_configuration(configuration)
        return client

    def _init_from_configuration(self, configuration: Configuration) -> None:
        self.configuration = configuration
        self.api_client = ApiClient(configuration)
        self.api_client.user_agent = f"gemina-sdk-python/{__version__}"
        self._documents: Optional[Any] = None
        self._retrieval: Optional[Any] = None
        self._chat: Optional[Any] = None
        self._templates: Optional[Any] = None
        self._files: Optional[Any] = None
        self._file_tag: Optional[Any] = None
        self._sessions: Optional[Any] = None
        self._subscriptions: Optional[Any] = None
        self._billing: Optional[Any] = None

    # -- lifecycle -----------------------------------------------------------

    async def __aenter__(self) -> "GeminaClient":
        return self

    async def __aexit__(self, exc_type: Any, exc: Any, tb: Any) -> None:
        await self.close()

    async def close(self) -> None:
        """Close the underlying HTTP connection pool."""
        await self.api_client.close()

    # -- generated API groups (lazy) ----------------------------------------

    @property
    def documents(self) -> Any:
        if self._documents is None:
            from gemina.generated.api.document_api import DocumentApi

            self._documents = DocumentApi(self.api_client)
        return self._documents

    @property
    def retrieval(self) -> Any:
        if self._retrieval is None:
            from gemina.generated.api.retrieval_api import RetrievalApi

            self._retrieval = RetrievalApi(self.api_client)
        return self._retrieval

    @property
    def chat(self) -> Any:
        if self._chat is None:
            from gemina.generated.api.chat_api import ChatApi

            self._chat = ChatApi(self.api_client)
        return self._chat

    @property
    def templates(self) -> Any:
        if self._templates is None:
            from gemina.generated.api.templates_api import TemplatesApi

            self._templates = TemplatesApi(self.api_client)
        return self._templates

    @property
    def files(self) -> Any:
        if self._files is None:
            from gemina.generated.api.files_api import FilesApi

            self._files = FilesApi(self.api_client)
        return self._files

    @property
    def file_tag(self) -> Any:
        if self._file_tag is None:
            from gemina.generated.api.file_tag_api import FileTagApi

            self._file_tag = FileTagApi(self.api_client)
        return self._file_tag

    @property
    def sessions(self) -> Any:
        if self._sessions is None:
            from gemina.generated.api.sessions_api import SessionsApi

            self._sessions = SessionsApi(self.api_client)
        return self._sessions

    @property
    def subscriptions(self) -> Any:
        if self._subscriptions is None:
            from gemina.generated.api.subscriptions_api import SubscriptionsApi

            self._subscriptions = SubscriptionsApi(self.api_client)
        return self._subscriptions

    @property
    def billing(self) -> Any:
        if self._billing is None:
            from gemina.generated.api.billing_api import BillingApi

            self._billing = BillingApi(self.api_client)
        return self._billing

    # -- stateful chat convenience -------------------------------------------

    def conversation(
        self, *, end_user_id: Optional[str] = None
    ) -> GeminaChatConversation:
        """Start a stateful chat ``GeminaChatConversation`` that threads the
        conversation ``session_id`` across turns for you, so follow-up
        questions keep context. The full one-shot surface stays on
        ``client.chat``.

        Args:
            end_user_id: End-user id forwarded with each turn (API-key path
                only; on the session-token path the token's signed scope wins
                server-side).
        """
        return GeminaChatConversation(self.chat, end_user_id)

    # -- the headline one-call flow ------------------------------------------

    async def process_document(
        self,
        source: Union[bytes, "os.PathLike[str]", str, Any, UrlSource],
        extraction_types: List[ExtractionTypeModel],
        *,
        external_id: Optional[str] = None,
        template_id: Optional[Any] = None,
        model_type: Optional[ModelType] = None,
        thinking: Optional[bool] = None,
        evaluation: Optional[bool] = None,
        correction: Optional[bool] = None,
        include_coordinates: Optional[bool] = None,
        end_user_id: Optional[str] = None,
        timeout_seconds: float = 300.0,
        initial_interval_seconds: float = 2.0,
        max_interval_seconds: float = 15.0,
        _sleep: Any = asyncio.sleep,
        _random: Any = random.random,
    ) -> DocumentProcessingResultOutDTO:
        """Submit a document, poll until terminal, return the typed result.

        Args:
            source: A file — ``pathlib.Path`` / ``str`` path / ``bytes`` /
                binary file-like object — or ``UrlSource("https://...")`` for
                a URL reference. Files go to ``POST /v1/documents/requests``;
                URLs to ``POST /v1/documents/requests/web``.
            extraction_types: Required, non-empty list of
                ``ExtractionTypeModel`` values.
            external_id: Your identifier for the document (1-100 chars). The
                API requires one; a random UUID hex is generated if omitted.
            timeout_seconds: Overall polling deadline (default 300s). On
                expiry a ``GeminaTimeoutError`` is raised carrying the
                ``correlation_id`` so you can resume polling yourself.
            initial_interval_seconds / max_interval_seconds: Poll backoff
                knobs — the wait starts at ``initial_interval_seconds``
                (default 2.0), grows x1.5 per attempt, is capped at
                ``max_interval_seconds`` (default 15.0), and each wait is
                multiplied by a random jitter factor in [0.8, 1.2].

        Returns:
            The terminal ``DocumentProcessingResultOutDTO`` for ``success``,
            ``partial`` and ``empty`` statuses (check ``result.status``;
            ``partial``/``empty`` still carry usable data/meta).

        Raises:
            GeminaProcessingError: Terminal ``failed`` status (``.result``
                carries the full result; its ``errors`` list has details).
            GeminaTimeoutError: ``timeout_seconds`` exceeded
                (``.correlation_id`` + ``.last_result``).
            GeminaError: Malformed server response (non-terminal submit
                response without a correlation ID).

        Transient poll failures (connection errors, 5xx responses that do
        not carry a terminal ``failed`` result) are retried on the same
        backoff schedule and overall deadline; after 3 consecutive failures
        the last error is rethrown unchanged. Submit errors are never
        retried.
        """
        if not extraction_types:
            raise ValueError("extraction_types must be a non-empty list")
        if external_id is None:
            external_id = uuid.uuid4().hex

        try:
            if isinstance(source, UrlSource):
                dto = WebDocumentUploadInDTO(
                    url=source.url,
                    external_id=external_id,
                    extraction_types=extraction_types,
                    template_id=template_id,
                    model_type=model_type,
                    thinking=thinking,
                    evaluation=evaluation,
                    correction=correction,
                    include_coordinates=include_coordinates,
                    end_user_id=end_user_id,
                )
                result = await self.documents.create_web_document_processing_request(
                    dto
                )
            else:
                result = await self.documents.create_document_processing_request(
                    external_id=external_id,
                    extraction_types=extraction_types,
                    file=_coerce_file_source(source),
                    template_id=template_id,
                    model_type=model_type,
                    thinking=thinking,
                    evaluation=evaluation,
                    correction=correction,
                    include_coordinates=include_coordinates,
                    end_user_id=end_user_id,
                )
        except ApiException as exc:
            _raise_if_failed_result(exc)
            raise

        if result.status in _TERMINAL_STATUSES:
            return _finish(result)

        correlation_id = result.meta.correlation_id if result.meta else None
        if correlation_id is None:
            raise GeminaError(
                "Malformed server response: non-terminal submit response "
                "without a correlationId"
            )

        deadline = _monotonic() + timeout_seconds
        interval = initial_interval_seconds
        last_result = result
        consecutive_poll_failures = 0
        while True:
            if _monotonic() >= deadline:
                raise GeminaTimeoutError(correlation_id, last_result)
            jitter = 0.8 + 0.4 * _random()
            await _sleep(min(interval, max_interval_seconds) * jitter)
            try:
                result = await self.documents.get_document_processing_result_by_correlation_id(
                    correlation_id
                )
            except (ApiException, httpx.HTTPError) as exc:
                if isinstance(exc, ApiException):
                    # Terminal `failed` served as an HTTP error: raise the
                    # contract error immediately — never retried.
                    _raise_if_failed_result(exc)
                # Transient poll failure (connection blip, 5xx with a
                # non-result body): the document is already submitted, so
                # keep polling on the same backoff schedule and overall
                # deadline. Rethrow unchanged after
                # _MAX_CONSECUTIVE_POLL_FAILURES failures in a row.
                consecutive_poll_failures += 1
                if consecutive_poll_failures >= _MAX_CONSECUTIVE_POLL_FAILURES:
                    raise
                interval = min(interval * 1.5, max_interval_seconds)
                continue
            consecutive_poll_failures = 0
            last_result = result
            if result.status in _TERMINAL_STATUSES:
                return _finish(result)
            interval = min(interval * 1.5, max_interval_seconds)


def _finish(result: DocumentProcessingResultOutDTO) -> DocumentProcessingResultOutDTO:
    """Terminal handling: ``failed`` raises, everything terminal returns."""
    if result.status == ResponseStatus.FAILED:
        raise GeminaProcessingError(result)
    return result


def _raise_if_failed_result(exc: ApiException) -> None:
    """Convert an HTTP-error response that carries a terminal ``failed``
    processing result into ``GeminaProcessingError``.

    The API serves terminal ``failed`` results with an error status code
    (e.g. 500), which makes the generated client raise ``ApiException``
    before the result body reaches the terminal handling. If the exception
    body parses as a ``DocumentProcessingResultOutDTO`` with status
    ``failed``, raise the contract's ``GeminaProcessingError`` carrying the
    typed result. Anything else (real transport/HTTP errors, validation
    errors) passes through unwrapped.
    """
    body = getattr(exc, "body", None)
    if not body:
        return
    try:
        parsed = DocumentProcessingResultOutDTO.from_json(body)
    except Exception:
        return
    if parsed is not None and parsed.status == ResponseStatus.FAILED:
        raise GeminaProcessingError(parsed) from exc


def _coerce_file_source(
    source: Union[bytes, "os.PathLike[str]", str, Any],
) -> Union[bytes, str, Tuple[str, bytes]]:
    """Normalize a file source into what the generated client accepts.

    The generated ``create_document_processing_request`` takes
    ``bytes | str-path | (filename, bytes)``; paths are opened and read by
    the generated client itself.
    """
    if isinstance(source, (bytes, bytearray)):
        return bytes(source)
    if isinstance(source, (str, os.PathLike)):
        return os.fspath(source)
    read = getattr(source, "read", None)
    if callable(read):
        data = read()
        if isinstance(data, str):
            raise GeminaError(
                "File-like sources must be opened in binary mode ('rb')"
            )
        name = getattr(source, "name", None)
        if isinstance(name, str) and name:
            return (os.path.basename(name), bytes(data))
        return bytes(data)
    raise TypeError(
        "Unsupported document source: expected bytes, a path, a binary "
        f"file-like object, or UrlSource — got {type(source).__name__}"
    )
