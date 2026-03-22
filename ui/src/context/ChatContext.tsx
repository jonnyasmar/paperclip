import {
  createContext,
  useCallback,
  useContext,
  useState,
  type ReactNode,
} from "react";
import { api } from "../api/client";

interface ActiveChat {
  agentId: string;
  agentName: string;
  agentIcon?: string | null;
  chatId: string;
  runId?: string;
  issueTitle?: string;
}

interface ChatContextValue {
  activeChat: ActiveChat | null;
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
  closeChat: () => Promise<void>;
}

const ChatContext = createContext<ChatContextValue | null>(null);

export function ChatProvider({ children }: { children: ReactNode }) {
  const [activeChat, setActiveChat] = useState<ActiveChat | null>(null);

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
    },
    [],
  );

  const closeChat = useCallback(async () => {
    if (!activeChat) return;

    try {
      if (activeChat.runId) {
        await api.delete(
          `/runs/${activeChat.runId}/chat?chatId=${encodeURIComponent(activeChat.chatId)}`,
        );
      } else {
        await api.delete(
          `/agents/${activeChat.agentId}/chat?chatId=${encodeURIComponent(activeChat.chatId)}`,
        );
      }
    } catch {
      // Ignore cleanup errors
    }

    setActiveChat(null);
  }, [activeChat]);

  return (
    <ChatContext.Provider value={{ activeChat, openChat, openRunChat, closeChat }}>
      {children}
    </ChatContext.Provider>
  );
}

export function useChat() {
  const context = useContext(ChatContext);
  if (!context) throw new Error("useChat must be used within ChatProvider");
  return context;
}
