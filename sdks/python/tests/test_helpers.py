"""Offline unit tests for the hand-written helper layer (contract section 3).

The generated API objects are replaced with fakes injected on the client's
lazy accessors; no network is touched.
"""

from __future__ import annotations

import uuid

import pytest

import gemina.helpers as helpers
from gemina import (
    GeminaClient,
    __version__,
    GeminaError,
    GeminaProcessingError,
    GeminaTimeoutError,
    UrlSource,
)
from gemina.generated.models.document_data_out_dto import DocumentDataOutDTO
from gemina.generated.models.document_processing_meta_out_dto import (
    DocumentProcessingMetaOutDTO,
)
from gemina.generated.models.document_processing_result_out_dto import (
    DocumentProcessingResultOutDTO,
)
from gemina.generated.models.extraction_type_model import ExtractionTypeModel
from gemina.generated.models.response_status import ResponseStatus

CORRELATION_ID = uuid.uuid4()


def make_result(status, correlation_id=CORRELATION_ID, errors=None, data=None):
    """Build a real generated pydantic result model."""
    return DocumentProcessingResultOutDTO(
        status=status,
        meta=DocumentProcessingMetaOutDTO(correlation_id=correlation_id),
        data=data,
        errors=errors,
    )


class FakeDocumentsApi:
    """Stands in for the generated DocumentApi at the API boundary."""

    def __init__(self, submit_result=None, poll_results=()):
        self.submit_result = submit_result
        self.poll_results = list(poll_results)
        self.submit_calls = []
        self.web_calls = []
        self.poll_calls = []

    async def create_document_processing_request(self, **kwargs):
        self.submit_calls.append(kwargs)
        return self.submit_result

    async def create_web_document_processing_request(self, dto):
        self.web_calls.append(dto)
        return self.submit_result

    async def get_document_processing_result_by_correlation_id(self, correlation_id):
        self.poll_calls.append(correlation_id)
        if len(self.poll_results) > 1:
            item = self.poll_results.pop(0)
        else:
            item = self.poll_results[0]  # keep repeating the last item
        if isinstance(item, Exception):
            raise item
        return item


class Recorder:
    """Records the wait durations passed to the injected sleep."""

    def __init__(self, clock=None):
        self.waits = []
        self.clock = clock

    async def sleep(self, seconds):
        self.waits.append(seconds)
        if self.clock is not None:
            self.clock.advance(seconds)


class FakeClock:
    def __init__(self):
        self.now = 0.0

    def advance(self, seconds):
        self.now += seconds

    def monotonic(self):
        return self.now


@pytest.fixture
def client():
    return GeminaClient("test-api-key", base_url="http://localhost:1")


def install(client, fake):
    client._documents = fake


# -- 1. happy path -----------------------------------------------------------


async def test_happy_path_submit_two_nonterminal_polls_then_success(client):
    success = make_result(
        ResponseStatus.SUCCESS, data=DocumentDataOutDTO(extractions=[])
    )
    fake = FakeDocumentsApi(
        submit_result=make_result(ResponseStatus.IN_PROCESS),
        poll_results=[
            make_result(ResponseStatus.IN_PROCESS),
            make_result(ResponseStatus.PENDING),
            success,
        ],
    )
    install(client, fake)
    recorder = Recorder()

    result = await client.process_document(
        b"%PDF-fake",
        [ExtractionTypeModel.INVOICE_HEADERS],
        _sleep=recorder.sleep,
        _random=lambda: 0.5,  # jitter factor exactly 1.0
    )

    assert result is success
    assert result.status == ResponseStatus.SUCCESS
    # submitted once via the file endpoint, never via web
    assert len(fake.submit_calls) == 1
    assert fake.web_calls == []
    # polled with the correlation id from the submit response, three times
    assert fake.poll_calls == [CORRELATION_ID] * 3
    assert len(recorder.waits) == 3


async def test_submit_already_terminal_skips_polling(client):
    success = make_result(ResponseStatus.SUCCESS)
    fake = FakeDocumentsApi(submit_result=success)
    install(client, fake)

    result = await client.process_document(
        b"data", [ExtractionTypeModel.OCR], _sleep=None, _random=None
    )

    assert result is success
    assert fake.poll_calls == []


# -- 2. terminal failed ------------------------------------------------------


async def test_failed_raises_processing_error_with_result(client):
    failed = make_result(ResponseStatus.FAILED, errors=[{"code": "unreadable"}])
    fake = FakeDocumentsApi(
        submit_result=make_result(ResponseStatus.IN_PROCESS),
        poll_results=[failed],
    )
    install(client, fake)
    recorder = Recorder()

    with pytest.raises(GeminaProcessingError) as excinfo:
        await client.process_document(
            b"data",
            [ExtractionTypeModel.INVOICE_HEADERS],
            _sleep=recorder.sleep,
            _random=lambda: 0.5,
        )

    assert excinfo.value.result is failed
    assert excinfo.value.result.errors == [{"code": "unreadable"}]


async def test_failed_on_submit_raises_without_polling(client):
    failed = make_result(ResponseStatus.FAILED, errors=[{"code": "bad_file"}])
    fake = FakeDocumentsApi(submit_result=failed)
    install(client, fake)

    with pytest.raises(GeminaProcessingError) as excinfo:
        await client.process_document(
            b"data", [ExtractionTypeModel.INVOICE_HEADERS], _sleep=None, _random=None
        )

    assert excinfo.value.result is failed
    assert fake.poll_calls == []


# -- 3. timeout ---------------------------------------------------------------


async def test_timeout_raises_with_correlation_id_and_last_result(
    client, monkeypatch
):
    clock = FakeClock()
    monkeypatch.setattr(helpers, "_monotonic", clock.monotonic)
    last = make_result(ResponseStatus.IN_PROCESS)
    fake = FakeDocumentsApi(
        submit_result=make_result(ResponseStatus.PENDING),
        poll_results=[last],  # never terminal
    )
    install(client, fake)
    recorder = Recorder(clock=clock)

    with pytest.raises(GeminaTimeoutError) as excinfo:
        await client.process_document(
            b"data",
            [ExtractionTypeModel.INVOICE_HEADERS],
            timeout_seconds=4.0,
            _sleep=recorder.sleep,
            _random=lambda: 0.5,
        )

    # waits 2.0 (t=2.0), poll; wait 3.0 (t=5.0 >= 4.0) -> timeout at loop top
    assert excinfo.value.correlation_id == CORRELATION_ID
    assert excinfo.value.last_result is last
    assert fake.poll_calls == [CORRELATION_ID] * 2
    assert recorder.waits == pytest.approx([2.0, 3.0])


# -- 4. backoff schedule -------------------------------------------------------


async def test_backoff_schedule_grows_1_5x_capped_at_max(client):
    n_polls = 8
    fake = FakeDocumentsApi(
        submit_result=make_result(ResponseStatus.IN_PROCESS),
        poll_results=[make_result(ResponseStatus.IN_PROCESS)] * (n_polls - 1)
        + [make_result(ResponseStatus.SUCCESS)],
    )
    install(client, fake)
    recorder = Recorder()

    await client.process_document(
        b"data",
        [ExtractionTypeModel.INVOICE_HEADERS],
        _sleep=recorder.sleep,
        _random=lambda: 0.5,  # jitter factor exactly 1.0
    )

    assert recorder.waits == pytest.approx(
        [2.0, 3.0, 4.5, 6.75, 10.125, 15.0, 15.0, 15.0]
    )


async def test_backoff_jitter_stays_within_bounds(client):
    # cycle through the extremes and a midpoint of random()'s range
    randoms = [0.0, 1.0, 0.25, 0.75, 0.5, 0.0, 1.0]
    fake = FakeDocumentsApi(
        submit_result=make_result(ResponseStatus.IN_PROCESS),
        poll_results=[make_result(ResponseStatus.IN_PROCESS)] * (len(randoms) - 1)
        + [make_result(ResponseStatus.SUCCESS)],
    )
    install(client, fake)
    recorder = Recorder()
    values = iter(randoms)

    await client.process_document(
        b"data",
        [ExtractionTypeModel.INVOICE_HEADERS],
        _sleep=recorder.sleep,
        _random=lambda: next(values),
    )

    nominal = [2.0, 3.0, 4.5, 6.75, 10.125, 15.0, 15.0]
    expected = [n * (0.8 + 0.4 * r) for n, r in zip(nominal, randoms)]
    assert recorder.waits == pytest.approx(expected)
    eps = 1e-9  # FP noise: 0.8 + 0.4*1.0 == 1.2000000000000002
    for wait, n in zip(recorder.waits, nominal):
        assert 0.8 * n - eps <= wait <= 1.2 * n + eps


async def test_custom_polling_knobs(client):
    fake = FakeDocumentsApi(
        submit_result=make_result(ResponseStatus.IN_PROCESS),
        poll_results=[make_result(ResponseStatus.IN_PROCESS)] * 3
        + [make_result(ResponseStatus.SUCCESS)],
    )
    install(client, fake)
    recorder = Recorder()

    await client.process_document(
        b"data",
        [ExtractionTypeModel.INVOICE_HEADERS],
        initial_interval_seconds=1.0,
        max_interval_seconds=2.0,
        _sleep=recorder.sleep,
        _random=lambda: 0.5,
    )

    assert recorder.waits == pytest.approx([1.0, 1.5, 2.0, 2.0])


# -- 5. URL source routes to the web endpoint ---------------------------------


async def test_url_source_routes_to_web_endpoint(client):
    fake = FakeDocumentsApi(submit_result=make_result(ResponseStatus.SUCCESS))
    install(client, fake)

    await client.process_document(
        UrlSource("https://example.com/invoice.pdf"),
        [ExtractionTypeModel.INVOICE_HEADERS],
        external_id="inv-42",
        end_user_id="user-7",
        _sleep=None,
        _random=None,
    )

    assert fake.submit_calls == []
    assert len(fake.web_calls) == 1
    dto = fake.web_calls[0]
    assert dto.url == "https://example.com/invoice.pdf"
    assert dto.external_id == "inv-42"
    assert dto.end_user_id == "user-7"
    assert dto.extraction_types == [ExtractionTypeModel.INVOICE_HEADERS]


async def test_file_path_routes_to_multipart_endpoint(client, tmp_path):
    doc = tmp_path / "invoice.png"
    doc.write_bytes(b"\x89PNG-fake")
    fake = FakeDocumentsApi(submit_result=make_result(ResponseStatus.SUCCESS))
    install(client, fake)

    await client.process_document(
        doc,  # pathlib.Path
        [ExtractionTypeModel.INVOICE_HEADERS],
        _sleep=None,
        _random=None,
    )

    assert fake.web_calls == []
    assert len(fake.submit_calls) == 1
    call = fake.submit_calls[0]
    assert call["file"] == str(doc)  # generated client opens paths itself
    assert call["extraction_types"] == [ExtractionTypeModel.INVOICE_HEADERS]
    assert call["external_id"]  # auto-generated when omitted


async def test_file_like_source_uses_name_and_bytes(client, tmp_path):
    doc = tmp_path / "receipt.pdf"
    doc.write_bytes(b"%PDF-fake")
    fake = FakeDocumentsApi(submit_result=make_result(ResponseStatus.SUCCESS))
    install(client, fake)

    with open(doc, "rb") as handle:
        await client.process_document(
            handle,
            [ExtractionTypeModel.INVOICE_HEADERS],
            _sleep=None,
            _random=None,
        )

    assert fake.submit_calls[0]["file"] == ("receipt.pdf", b"%PDF-fake")


async def test_failed_result_served_as_http_error_raises_processing_error(client):
    # The live API serves terminal `failed` results with an HTTP 500, which
    # the generated client turns into ServiceException before terminal
    # handling sees it. The helper must unwrap it into GeminaProcessingError.
    from gemina.generated.exceptions import ServiceException

    failed = make_result(ResponseStatus.FAILED, errors=[{"code": "engine_error"}])
    fake = FakeDocumentsApi(
        submit_result=make_result(ResponseStatus.IN_PROCESS),
    )

    async def raise_500(correlation_id):
        fake.poll_calls.append(correlation_id)
        raise ServiceException(
            status=500, reason="Internal Server Error", body=failed.to_json()
        )

    fake.get_document_processing_result_by_correlation_id = raise_500
    install(client, fake)
    recorder = Recorder()

    with pytest.raises(GeminaProcessingError) as excinfo:
        await client.process_document(
            b"data",
            [ExtractionTypeModel.INVOICE_HEADERS],
            _sleep=recorder.sleep,
            _random=lambda: 0.5,
        )

    assert excinfo.value.result.status == ResponseStatus.FAILED
    assert excinfo.value.result.errors == [{"code": "engine_error"}]
    assert excinfo.value.result.meta.correlation_id == CORRELATION_ID
    # terminal `failed` is never treated as transient: exactly one poll
    assert len(fake.poll_calls) == 1


# -- transient poll failures are retried ---------------------------------------


async def test_transient_poll_errors_retried_then_success(client):
    import httpx

    from gemina.generated.exceptions import ServiceException

    success = make_result(ResponseStatus.SUCCESS)
    fake = FakeDocumentsApi(
        submit_result=make_result(ResponseStatus.IN_PROCESS),
        poll_results=[
            ServiceException(
                status=503,
                reason="Service Unavailable",
                body="upstream connect error",  # not a result body
            ),
            httpx.ConnectError("connection reset by peer"),
            success,
        ],
    )
    install(client, fake)
    recorder = Recorder()

    result = await client.process_document(
        b"data",
        [ExtractionTypeModel.INVOICE_HEADERS],
        _sleep=recorder.sleep,
        _random=lambda: 0.5,
    )

    assert result is success
    assert fake.poll_calls == [CORRELATION_ID] * 3
    # backoff schedule keeps growing across failed attempts
    assert recorder.waits == pytest.approx([2.0, 3.0, 4.5])


async def test_three_consecutive_transient_errors_rethrow_last_unchanged(client):
    from gemina.generated.exceptions import ServiceException

    blips = [
        ServiceException(
            status=503, reason="Service Unavailable", body='{"detail": "blip"}'
        )
        for _ in range(3)
    ]
    fake = FakeDocumentsApi(
        submit_result=make_result(ResponseStatus.IN_PROCESS),
        poll_results=list(blips),
    )
    install(client, fake)
    recorder = Recorder()

    with pytest.raises(ServiceException) as excinfo:
        await client.process_document(
            b"data",
            [ExtractionTypeModel.INVOICE_HEADERS],
            _sleep=recorder.sleep,
            _random=lambda: 0.5,
        )

    assert excinfo.value is blips[2]  # the last error, unchanged
    assert fake.poll_calls == [CORRELATION_ID] * 3


async def test_transient_failure_counter_resets_on_successful_poll(client):
    from gemina.generated.exceptions import ServiceException

    def blip():
        return ServiceException(
            status=502, reason="Bad Gateway", body='{"detail": "lb blip"}'
        )

    success = make_result(ResponseStatus.SUCCESS)
    fake = FakeDocumentsApi(
        submit_result=make_result(ResponseStatus.IN_PROCESS),
        poll_results=[
            blip(),
            blip(),
            make_result(ResponseStatus.IN_PROCESS),  # resets the counter
            blip(),
            blip(),
            success,
        ],
    )
    install(client, fake)
    recorder = Recorder()

    result = await client.process_document(
        b"data",
        [ExtractionTypeModel.INVOICE_HEADERS],
        _sleep=recorder.sleep,
        _random=lambda: 0.5,
    )

    assert result is success
    assert fake.poll_calls == [CORRELATION_ID] * 6


async def test_submit_errors_are_not_retried(client):
    from gemina.generated.exceptions import ServiceException

    fake = FakeDocumentsApi()
    boom = ServiceException(
        status=503, reason="Service Unavailable", body='{"detail": "upstream down"}'
    )

    async def submit_raises(**kwargs):
        fake.submit_calls.append(kwargs)
        raise boom

    fake.create_document_processing_request = submit_raises
    install(client, fake)

    with pytest.raises(ServiceException) as excinfo:
        await client.process_document(
            b"data", [ExtractionTypeModel.INVOICE_HEADERS], _sleep=None, _random=None
        )

    assert excinfo.value is boom
    assert len(fake.submit_calls) == 1  # single attempt, passed through
    assert fake.poll_calls == []


# -- malformed responses / bad input ------------------------------------------


async def test_nonterminal_submit_without_correlation_id_raises(client):
    fake = FakeDocumentsApi(
        submit_result=make_result(ResponseStatus.IN_PROCESS, correlation_id=None)
    )
    install(client, fake)

    with pytest.raises(GeminaError) as excinfo:
        await client.process_document(
            b"data", [ExtractionTypeModel.INVOICE_HEADERS], _sleep=None, _random=None
        )
    assert not isinstance(excinfo.value, (GeminaProcessingError, GeminaTimeoutError))


async def test_empty_extraction_types_rejected(client):
    install(client, FakeDocumentsApi())
    with pytest.raises(ValueError):
        await client.process_document(b"data", [])


# -- facade wiring -------------------------------------------------------------


def test_configuration_api_key_host_and_user_agent(client):
    assert client.configuration.api_key == {"APIKeyHeader": "test-api-key"}
    assert client.configuration.host == "http://localhost:1"
    assert client.api_client.user_agent == f"gemina-sdk-python/{__version__}"
    # Auth comes solely from Configuration's declared security schemes; the
    # facade must not inject credential default headers (every protected op
    # declares security since gemina-api-v2 PR #200).
    assert "X-API-Key" not in client.api_client.default_headers
    auth = client.configuration.auth_settings()
    assert auth["APIKeyHeader"]["value"] == "test-api-key"


def test_with_session_token_uses_bearer_scheme():
    client = GeminaClient.with_session_token("tok-123", base_url="http://localhost:1")
    assert client.configuration.access_token == "tok-123"
    assert client.configuration.api_key == {}
    auth = client.configuration.auth_settings()
    assert auth["OAuth2PasswordBearer"]["value"] == "Bearer tok-123"
    assert client.api_client.user_agent == f"gemina-sdk-python/{__version__}"
    assert "Authorization" not in client.api_client.default_headers
    assert "X-API-Key" not in client.api_client.default_headers


def test_lazy_api_group_accessors(client):
    from gemina.generated.api.billing_api import BillingApi
    from gemina.generated.api.chat_api import ChatApi
    from gemina.generated.api.document_api import DocumentApi
    from gemina.generated.api.file_tag_api import FileTagApi
    from gemina.generated.api.files_api import FilesApi
    from gemina.generated.api.retrieval_api import RetrievalApi
    from gemina.generated.api.sessions_api import SessionsApi
    from gemina.generated.api.subscriptions_api import SubscriptionsApi
    from gemina.generated.api.templates_api import TemplatesApi

    expected = {
        "documents": DocumentApi,
        "retrieval": RetrievalApi,
        "chat": ChatApi,
        "templates": TemplatesApi,
        "files": FilesApi,
        "file_tag": FileTagApi,
        "sessions": SessionsApi,
        "subscriptions": SubscriptionsApi,
        "billing": BillingApi,
    }
    for name, cls in expected.items():
        group = getattr(client, name)
        assert isinstance(group, cls)
        assert getattr(client, name) is group  # cached
        assert group.api_client is client.api_client
