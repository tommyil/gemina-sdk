"""Official Python SDK for the Gemina API.

Quickstart::

    import asyncio
    from gemina import GeminaClient, UploadExtractionTypeEnum

    async def main():
        async with GeminaClient("YOUR_API_KEY") as client:
            result = await client.process_document(
                "invoice.png", [UploadExtractionTypeEnum.INVOICE_HEADERS]
            )
            print(result.status)

    asyncio.run(main())

The full generated client is available as ``gemina.generated`` and through
the ``GeminaClient`` group accessors (``client.documents``, ``client.chat``,
...).
"""

from gemina._version import __version__ as __version__
from gemina.errors import (
    GeminaError as GeminaError,
    GeminaProcessingError as GeminaProcessingError,
    GeminaTimeoutError as GeminaTimeoutError,
)
from gemina.helpers import (
    GeminaChatConversation as GeminaChatConversation,
    GeminaClient as GeminaClient,
    UrlSource as UrlSource,
)

# Commonly-used generated models/enums, re-exported for convenience.
# (Importing any gemina.generated submodule initializes the full generated
# package, so gemina.generated is also usable after `import gemina`.)
from gemina.generated.models.chat_message_out_dto import (
    ChatMessageOutDTO as ChatMessageOutDTO,
)
from gemina.generated.models.chat_query_in_dto import ChatQueryInDTO as ChatQueryInDTO
from gemina.generated.models.chat_query_out_dto import (
    ChatQueryOutDTO as ChatQueryOutDTO,
)
from gemina.generated.models.chat_session_list_out_dto import (
    ChatSessionListOutDTO as ChatSessionListOutDTO,
)
from gemina.generated.models.chat_session_out_dto import (
    ChatSessionOutDTO as ChatSessionOutDTO,
)
from gemina.generated.models.chat_transcript_out_dto import (
    ChatTranscriptOutDTO as ChatTranscriptOutDTO,
)
from gemina.generated.models.document_processing_result_out_dto import (
    DocumentProcessingResultOutDTO as DocumentProcessingResultOutDTO,
)
from gemina.generated.models.extraction_type_model import (
    ExtractionTypeModel as ExtractionTypeModel,
)
from gemina.generated.models.upload_extraction_type_enum import (
    UploadExtractionTypeEnum as UploadExtractionTypeEnum,
)
from gemina.generated.models.model_type import ModelType as ModelType
from gemina.generated.models.response_status import ResponseStatus as ResponseStatus
from gemina.generated.models.retrieval_aggregate_in_dto import (
    RetrievalAggregateInDTO as RetrievalAggregateInDTO,
)
from gemina.generated.models.retrieval_query_in_dto import (
    RetrievalQueryInDTO as RetrievalQueryInDTO,
)
from gemina.generated.models.session_token_in_dto import (
    SessionTokenInDTO as SessionTokenInDTO,
)
from gemina.generated.models.spend_limit_out_dto import (
    SpendLimitOutDTO as SpendLimitOutDTO,
)
from gemina.generated.models.spend_limit_update_in_dto import (
    SpendLimitUpdateInDTO as SpendLimitUpdateInDTO,
)
from gemina import generated as generated

__all__ = [
    "__version__",
    "GeminaClient",
    "GeminaChatConversation",
    "UrlSource",
    "GeminaError",
    "GeminaProcessingError",
    "GeminaTimeoutError",
    "generated",
    # generated re-exports
    "ChatMessageOutDTO",
    "ChatQueryInDTO",
    "ChatQueryOutDTO",
    "ChatSessionListOutDTO",
    "ChatSessionOutDTO",
    "ChatTranscriptOutDTO",
    "DocumentProcessingResultOutDTO",
    "ExtractionTypeModel",
    "UploadExtractionTypeEnum",
    "ModelType",
    "ResponseStatus",
    "RetrievalAggregateInDTO",
    "RetrievalQueryInDTO",
    "SessionTokenInDTO",
    "SpendLimitOutDTO",
    "SpendLimitUpdateInDTO",
]
