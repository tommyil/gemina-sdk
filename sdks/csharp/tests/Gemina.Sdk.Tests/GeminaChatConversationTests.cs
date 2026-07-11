using System;
using System.Collections.Generic;
using System.Threading;
using System.Threading.Tasks;
using Gemina.Sdk.Api;
using Gemina.Sdk.Model;
using Moq;
using Xunit;

namespace Gemina.Sdk.Tests
{
    public class GeminaChatConversationTests
    {
        private static ChatQueryOutDTO Answer(string answer, Guid sessionId)
        {
            return new ChatQueryOutDTO(answer: answer, sessionId: sessionId);
        }

        // A GeminaClient wired to a mock IChatApi, plus the conversation it hands out.
        private static (Mock<IChatApi> chat, GeminaChatConversation convo) MakeConversation(string endUserId = null)
        {
            var chat = new Mock<IChatApi>(MockBehavior.Strict);
            var client = new GeminaClient("test-api-key", "https://api.example.test") { Chat = chat.Object };
            return (chat, client.Conversation(endUserId));
        }

        [Fact]
        public void Conversation_Factory_ReturnsHelperWithNoSessionYet()
        {
            var (_, convo) = MakeConversation();
            Assert.IsType<GeminaChatConversation>(convo);
            Assert.Null(convo.SessionId);
        }

        [Fact]
        public async Task SendAsync_OmitsSessionOnFirstTurn_ThenThreadsItOnEveryFollowingTurn()
        {
            var session = Guid.NewGuid();
            var (chat, convo) = MakeConversation("eu-1");
            var captured = new List<ChatQueryInDTO>();
            chat
                .Setup(c => c.ChatQueryAsync(It.IsAny<ChatQueryInDTO>(), It.IsAny<int>(), It.IsAny<CancellationToken>()))
                .Callback<ChatQueryInDTO, int, CancellationToken>((req, _, __) => captured.Add(req))
                .ReturnsAsync(Answer("first", session));

            var first = await convo.SendAsync("turn one");
            Assert.Equal("first", first.Answer);
            Assert.Equal(session, convo.SessionId);

            // First turn: no session threaded (a brand-new conversation).
            Assert.Equal("turn one", captured[0].Message);
            Assert.Equal("eu-1", captured[0].EndUserId);
            Assert.Null(captured[0].SessionId);

            await convo.SendAsync("turn two");

            // Second turn: the server-issued session id is carried back.
            Assert.Equal("turn two", captured[1].Message);
            Assert.Equal("eu-1", captured[1].EndUserId);
            Assert.Equal(session, captured[1].SessionId);
        }

        [Fact]
        public async Task Reset_ForgetsTheSession_SoTheNextTurnStartsFresh()
        {
            var sessionA = Guid.NewGuid();
            var sessionB = Guid.NewGuid();
            var (chat, convo) = MakeConversation();
            var captured = new List<ChatQueryInDTO>();
            chat
                .Setup(c => c.ChatQueryAsync(It.IsAny<ChatQueryInDTO>(), It.IsAny<int>(), It.IsAny<CancellationToken>()))
                .Callback<ChatQueryInDTO, int, CancellationToken>((req, _, __) => captured.Add(req))
                // Return factory is evaluated per call (after Callback): 1st → A, 2nd → B.
                .ReturnsAsync(() => captured.Count == 1 ? Answer("a", sessionA) : Answer("b", sessionB));

            await convo.SendAsync("one");
            Assert.Equal(sessionA, convo.SessionId);

            convo.Reset();
            Assert.Null(convo.SessionId);

            await convo.SendAsync("two");
            // No session carried after a reset — a brand-new conversation.
            Assert.Equal("two", captured[1].Message);
            Assert.Null(captured[1].SessionId);
            Assert.Equal(sessionB, convo.SessionId);
        }

        [Fact]
        public async Task DeleteAsync_RemovesTheSessionServerSide_AndForgetsItLocally()
        {
            var session = Guid.NewGuid();
            var (chat, convo) = MakeConversation();
            chat
                .Setup(c => c.ChatQueryAsync(It.IsAny<ChatQueryInDTO>(), It.IsAny<int>(), It.IsAny<CancellationToken>()))
                .ReturnsAsync(Answer("x", session));
            chat
                .Setup(c => c.DeleteChatSessionAsync(It.IsAny<Guid>(), It.IsAny<int>(), It.IsAny<CancellationToken>()))
                .Returns(Task.CompletedTask);

            await convo.SendAsync("hi");
            await convo.DeleteAsync();

            chat.Verify(
                c => c.DeleteChatSessionAsync(session, It.IsAny<int>(), It.IsAny<CancellationToken>()),
                Times.Once);
            Assert.Null(convo.SessionId);
        }

        [Fact]
        public async Task DeleteAsync_IsANoOpBeforeAnyTurn_NothingToDelete()
        {
            // Strict mock: any call to DeleteChatSessionAsync would throw.
            var (chat, convo) = MakeConversation();

            await convo.DeleteAsync();

            chat.Verify(
                c => c.DeleteChatSessionAsync(It.IsAny<Guid>(), It.IsAny<int>(), It.IsAny<CancellationToken>()),
                Times.Never);
        }
    }
}
