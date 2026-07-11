"""Offline unit tests for the stateful chat conversation helper.

The generated ``ChatApi`` is replaced with a fake installed on the client's
lazy ``chat`` accessor; no network is touched. Mirrors the TypeScript SDK's
``conversation.test.ts``.
"""

from __future__ import annotations

import uuid
from types import SimpleNamespace

import pytest

from gemina import GeminaChatConversation, GeminaClient

SESS_9 = uuid.uuid4()
SESS_A = uuid.uuid4()
SESS_B = uuid.uuid4()
SESS_X = uuid.uuid4()


def reply(answer, session_id):
    """A minimal stand-in for a ChatQueryOutDTO (helper only reads these)."""
    return SimpleNamespace(answer=answer, session_id=session_id)


class FakeChatApi:
    """Stands in for the generated ChatApi at the API boundary."""

    def __init__(self, responses=()):
        self.responses = list(responses)
        self.query_calls = []
        self.delete_calls = []

    async def chat_query(self, chat_query_in_dto):
        self.query_calls.append(chat_query_in_dto)
        return self.responses.pop(0)

    async def delete_chat_session(self, session_id):
        self.delete_calls.append(session_id)


def make_conversation(responses=(), *, end_user_id=None):
    chat = FakeChatApi(responses)
    client = GeminaClient("key", base_url="http://localhost:1")
    client._chat = chat  # inject the fake on the lazy accessor
    return chat, client.conversation(end_user_id=end_user_id)


def test_conversation_factory_returns_the_helper():
    _, convo = make_conversation()
    assert isinstance(convo, GeminaChatConversation)
    assert convo.session_id is None


async def test_omits_session_id_first_turn_and_threads_it_after():
    chat, convo = make_conversation(
        [reply("first", SESS_9), reply("second", SESS_9)],
        end_user_id="eu-1",
    )

    first = await convo.send("turn one")
    assert first.answer == "first"
    assert convo.session_id == SESS_9
    dto1 = chat.query_calls[0]
    assert dto1.message == "turn one"
    assert dto1.end_user_id == "eu-1"
    assert dto1.session_id is None  # no id carried on the first turn

    await convo.send("turn two")
    dto2 = chat.query_calls[1]
    assert dto2.message == "turn two"
    assert dto2.end_user_id == "eu-1"
    assert dto2.session_id == SESS_9  # threaded on the follow-up turn


async def test_reset_forgets_session_so_next_turn_starts_fresh():
    chat, convo = make_conversation([reply("a", SESS_A), reply("b", SESS_B)])

    await convo.send("one")
    assert convo.session_id == SESS_A

    convo.reset()
    assert convo.session_id is None

    await convo.send("two")
    # No session id carried after a reset — a brand-new conversation.
    assert chat.query_calls[1].session_id is None
    assert convo.session_id == SESS_B


async def test_delete_removes_session_server_side_and_forgets_it_locally():
    chat, convo = make_conversation([reply("x", SESS_X)])

    await convo.send("hi")
    await convo.delete()

    assert chat.delete_calls == [SESS_X]
    assert convo.session_id is None


async def test_delete_is_a_no_op_before_any_turn():
    chat, convo = make_conversation()
    await convo.delete()
    assert chat.delete_calls == []
