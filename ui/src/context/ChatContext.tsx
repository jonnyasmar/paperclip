import {
  createContext,
  useCallback,
  useContext,
  useState,
  type ReactNode,
} from "react";
import { api } from "../api/client";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PersistedMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  thinking?: string;
  toolCalls?: Array<{ name: string; args: string; result?: string }>;
  timestamp: string;
}

export interface ChatSummary {
  chatId: string;
  agentId: string;
  agentName: string;
  agentIcon: string | null;
  runId: string | null;
  lastMessage: string;
  messageCount: number;
  createdAt: string;
  updatedAt: string;
}

interface ActiveChat {
  agentId: string;
  agentName: string;
  agentIcon?: string | null;
  chatId: string;
  runId?: string;
  issueTitle?: string;
  initialMessages?: PersistedMessage[];
}

interface ChatContextValue {
  activeChat: ActiveChat | null;
  isChatPanelOpen: boolean;
  toggleChatPanel: () => void;
  openChatPanel: () => void;
  openChat: (agent: {
    id: string;
    name: string;
    icon?: string | null;
  }) => Promise<void>;
  openRunChat: (
    runId: string,
    agent: { id: string; name: string; icon?: string | null },
    issueTitle?: string,
  ) => Promise<void>;
  resumeChat: (chatId: string) => Promise<void>;
  closeChat: () => void;
  endRunChat: () => Promise<void>;
  deleteChat: (chatId: string) => Promise<void>;
}

const ChatContext = createContext<ChatContextValue | null>(null);

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export function ChatProvider({ children }: { children: ReactNode }) {
  const [activeChat, setActiveChat] = useState<ActiveChat | null>(null);
  const [isChatPanelOpen, setIsChatPanelOpen] = useState(false);

  const toggleChatPanel = useCallback(() => {
    setIsChatPanelOpen((prev) => !prev);
  }, []);

  const openChatPanel = useCallback(() => {
    setIsChatPanelOpen(true);
  }, []);

  const openChat = useCallback(
    async (agent: { id: string; name: string; icon?: string | null }) => {
      const result = await api.post<{ chatId: string; sessionId: string | null }>(
        `/agents/${agent.id}/chat`,
        {},
      );
      setActiveChat({
        agentId: agent.id,
        agentName: agent.name,
        agentIcon: agent.icon,
        chatId: result.chatId,
      });
      setIsChatPanelOpen(true);
    },
    [],
  );

  const openRunChat = useCallback(
    async (
      runId: string,
      agent: { id: string; name: string; icon?: string | null },
      issueTitle?: string,
    ) => {
      const result = await api.post<{
        chatId: string;
        sessionId: string | null;
        runId: string;
      }>(`/runs/${runId}/chat`, {});
      setActiveChat({
        agentId: agent.id,
        agentName: agent.name,
        agentIcon: agent.icon,
        chatId: result.chatId,
        runId: result.runId,
        issueTitle,
      });
      setIsChatPanelOpen(true);
    },
    [],
  );

  const resumeChat = useCallback(async (chatId: string) => {
    const chat = await api.get<{
      chatId: string;
      agentId: string;
      agentName: string;
      agentIcon: string | null;
      runId: string | null;
      sessionId: string | null;
      messages: PersistedMessage[];
    }>(`/chats/${chatId}`);

    setActiveChat({
      agentId: chat.agentId,
      agentName: chat.agentName,
      agentIcon: chat.agentIcon,
      chatId: chat.chatId,
      runId: chat.runId ?? undefined,
      initialMessages: chat.messages,
    });
    setIsChatPanelOpen(true);
  }, []);

  // Close the panel view — does NOT delete the chat (it persists)
  const closeChat = useCallback(() => {
    if (activeChat) {
      // Clean up in-memory session on server (no deletion of persisted data)
      api.delete(
        `/agents/${activeChat.agentId}/chat?chatId=${encodeURIComponent(activeChat.chatId)}`,
      ).catch(() => { /* ignore cleanup errors */ });
    }
    setActiveChat(null);
  }, [activeChat]);

  // For run injection chats — calls DELETE to resume the run
  const endRunChat = useCallback(async () => {
    if (!activeChat?.runId) return;

    try {
      await api.delete(
        `/runs/${activeChat.runId}/chat?chatId=${encodeURIComponent(activeChat.chatId)}`,
      );
    } catch {
      // Ignore cleanup errors
    }

    setActiveChat(null);
  }, [activeChat]);

  const deleteChat = useCallback(async (chatId: string) => {
    try {
      await api.delete(`/chats/${chatId}`);
    } catch {
      // Ignore
    }
    // If this was the active chat, clear it
    setActiveChat((prev) => (prev?.chatId === chatId ? null : prev));
  }, []);

  return (
    <ChatContext.Provider
      value={{
        activeChat,
        isChatPanelOpen,
        toggleChatPanel,
        openChatPanel,
        openChat,
        openRunChat,
        resumeChat,
        closeChat,
        endRunChat,
        deleteChat,
      }}
    >
      {children}
    </ChatContext.Provider>
  );
}

export function useChat() {
  const context = useContext(ChatContext);
  if (!context) throw new Error("useChat must be used within ChatProvider");
  return context;
}
