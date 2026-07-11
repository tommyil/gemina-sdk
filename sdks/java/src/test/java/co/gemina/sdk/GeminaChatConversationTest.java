package co.gemina.sdk;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import java.util.UUID;

import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;

import co.gemina.sdk.GeminaClient.GeminaChatConversation;
import co.gemina.sdk.generated.api.ChatApi;
import co.gemina.sdk.generated.model.ChatQueryInDTO;
import co.gemina.sdk.generated.model.ChatQueryOutDTO;

/**
 * Unit tests for the stateful chat {@link GeminaChatConversation} — mocked at
 * the generated {@link ChatApi} boundary, no network. Mirrors the TypeScript
 * SDK's {@code conversation.test.ts}.
 */
class GeminaChatConversationTest {

    private GeminaClient client;
    private ChatApi chatApi;

    private static ChatQueryOutDTO reply(String answer, UUID sessionId) {
        return new ChatQueryOutDTO().answer(answer).sessionId(sessionId);
    }

    @BeforeEach
    void setUp() {
        client = new GeminaClient("test-api-key", "http://localhost:1");
        chatApi = mock(ChatApi.class);
        client.setChatApi(chatApi);
    }

    @Test
    void conversationFactory_returnsHelperWithNoSessionYet() {
        GeminaChatConversation convo = client.conversation();
        assertNull(convo.getSessionId());
    }

    @Test
    void omitsSessionIdOnFirstTurn_thenThreadsItOnEveryFollowingTurn() throws Exception {
        UUID session = UUID.randomUUID();
        when(chatApi.chatQuery(any(ChatQueryInDTO.class)))
                .thenReturn(reply("first", session))
                .thenReturn(reply("second", session));

        GeminaChatConversation convo = client.conversation("eu-1");

        ChatQueryOutDTO first = convo.send("turn one");
        assertEquals("first", first.getAnswer());
        assertEquals(session, convo.getSessionId());

        convo.send("turn two");

        ArgumentCaptor<ChatQueryInDTO> captor = ArgumentCaptor.forClass(ChatQueryInDTO.class);
        verify(chatApi, org.mockito.Mockito.times(2)).chatQuery(captor.capture());

        ChatQueryInDTO firstBody = captor.getAllValues().get(0);
        assertEquals("turn one", firstBody.getMessage());
        assertEquals("eu-1", firstBody.getEndUserId());
        assertNull(firstBody.getSessionId()); // no session threaded on the first turn

        ChatQueryInDTO secondBody = captor.getAllValues().get(1);
        assertEquals("turn two", secondBody.getMessage());
        assertEquals("eu-1", secondBody.getEndUserId());
        assertEquals(session, secondBody.getSessionId()); // threaded on the follow-up
    }

    @Test
    void reset_forgetsTheSessionSoTheNextTurnStartsFresh() throws Exception {
        UUID sessionA = UUID.randomUUID();
        UUID sessionB = UUID.randomUUID();
        when(chatApi.chatQuery(any(ChatQueryInDTO.class)))
                .thenReturn(reply("a", sessionA))
                .thenReturn(reply("b", sessionB));

        GeminaChatConversation convo = client.conversation();

        convo.send("one");
        assertEquals(sessionA, convo.getSessionId());

        convo.reset();
        assertNull(convo.getSessionId());

        convo.send("two");

        ArgumentCaptor<ChatQueryInDTO> captor = ArgumentCaptor.forClass(ChatQueryInDTO.class);
        verify(chatApi, org.mockito.Mockito.times(2)).chatQuery(captor.capture());
        // No session carried after a reset — a brand-new conversation.
        assertNull(captor.getAllValues().get(1).getSessionId());
        assertEquals(sessionB, convo.getSessionId());
    }

    @Test
    void delete_removesTheSessionServerSideAndForgetsItLocally() throws Exception {
        UUID session = UUID.randomUUID();
        when(chatApi.chatQuery(any(ChatQueryInDTO.class))).thenReturn(reply("x", session));

        GeminaChatConversation convo = client.conversation();
        convo.send("hi");
        convo.delete();

        verify(chatApi).deleteChatSession(session);
        assertNull(convo.getSessionId());
    }

    @Test
    void delete_isANoOpBeforeAnyTurn() throws Exception {
        GeminaChatConversation convo = client.conversation();
        convo.delete();
        verify(chatApi, never()).deleteChatSession(any());
    }
}
