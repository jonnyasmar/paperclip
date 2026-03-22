import { useState } from "react";
import {
  X,
  LogOut,
  MessageSquare,
  ChevronLeft,
  Plus,
  Trash2,
} from "lucide-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Sheet,
  SheetContent,
} from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { AgentIcon } from "./AgentIconPicker";
import { ChatView } from "./ChatView";
import { useChat, type ChatSummary } from "../context/ChatContext";
import { useCompany } from "../context/CompanyContext";
import { agentsApi } from "../api/agents";
import { api } from "../api/client";
import { queryKeys } from "../lib/queryKeys";
import { timeAgo } from "../lib/timeAgo";
import { cn } from "../lib/utils";
import type { Agent } from "@paperclipai/shared";

// ---------------------------------------------------------------------------
// Sub-views
// ---------------------------------------------------------------------------

type PanelView = "list" | "picker";

function ChatListView({
  onNewChat,
  onResumeChat,
  onDeleteChat,
}: {
  onNewChat: () => void;
  onResumeChat: (chatId: string) => void;
  onDeleteChat: (chatId: string) => void;
}) {
  const { data: chats, isLoading } = useQuery({
    queryKey: ["chats"],
    queryFn: () => api.get<ChatSummary[]>("/chats"),
    refetchInterval: 30_000,
  });

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center gap-3 px-4 py-3 border-b border-border shrink-0">
        <MessageSquare className="h-4 w-4 text-muted-foreground shrink-0" />
        <span className="font-medium text-sm flex-1">Chats</span>
        <Button
          variant="ghost"
          size="icon-sm"
          className="text-muted-foreground shrink-0"
          onClick={onNewChat}
          title="New chat"
        >
          <Plus className="h-4 w-4" />
        </Button>
      </div>

      {/* Chat list */}
      <div className="flex-1 overflow-y-auto">
        {isLoading && (
          <div className="flex items-center justify-center h-32 text-sm text-muted-foreground">
            Loading...
          </div>
        )}

        {!isLoading && (!chats || chats.length === 0) && (
          <div className="flex flex-col items-center justify-center h-full text-center text-muted-foreground px-6">
            <MessageSquare className="h-10 w-10 text-muted-foreground/30 mb-3" />
            <p className="text-sm font-medium">No chats yet</p>
            <p className="text-xs mt-1 mb-4">
              Start a conversation with an agent.
            </p>
            <Button variant="outline" size="sm" onClick={onNewChat}>
              <Plus className="h-3.5 w-3.5 mr-1.5" />
              New Chat
            </Button>
          </div>
        )}

        {chats?.map((chat) => (
          <ChatListItem
            key={chat.chatId}
            chat={chat}
            onResume={() => onResumeChat(chat.chatId)}
            onDelete={() => onDeleteChat(chat.chatId)}
          />
        ))}
      </div>
    </div>
  );
}

function ChatListItem({
  chat,
  onResume,
  onDelete,
}: {
  chat: ChatSummary;
  onResume: () => void;
  onDelete: () => void;
}) {
  return (
    <div
      className="group/chat flex items-start gap-3 px-4 py-3 hover:bg-accent/50 cursor-pointer border-b border-border/50 transition-colors"
      onClick={onResume}
    >
      <div className="h-8 w-8 rounded-full bg-muted flex items-center justify-center shrink-0 mt-0.5">
        <AgentIcon
          icon={chat.agentIcon}
          className="h-4 w-4 text-muted-foreground"
        />
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium truncate">
            {chat.agentName}
          </span>
          <span className="text-[10px] text-muted-foreground/60 shrink-0">
            {timeAgo(chat.updatedAt)}
          </span>
        </div>
        <p className="text-xs text-muted-foreground truncate mt-0.5">
          {chat.lastMessage || "No messages yet"}
        </p>
        <span className="text-[10px] text-muted-foreground/50 mt-0.5">
          {chat.messageCount} message{chat.messageCount !== 1 ? "s" : ""}
        </span>
      </div>
      <Button
        variant="ghost"
        size="icon-sm"
        className="opacity-0 group-hover/chat:opacity-100 transition-opacity text-muted-foreground/50 hover:text-destructive shrink-0 mt-0.5"
        onClick={(e) => {
          e.stopPropagation();
          onDelete();
        }}
        title="Delete chat"
      >
        <Trash2 className="h-3.5 w-3.5" />
      </Button>
    </div>
  );
}

function AgentPickerView({
  onBack,
  onSelectAgent,
}: {
  onBack: () => void;
  onSelectAgent: (agent: Agent) => void;
}) {
  const { selectedCompanyId } = useCompany();
  const { data: agents } = useQuery({
    queryKey: queryKeys.agents.list(selectedCompanyId!),
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const activeAgents = (agents ?? []).filter(
    (a) => a.status !== "terminated",
  );

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center gap-3 px-4 py-3 border-b border-border shrink-0">
        <Button
          variant="ghost"
          size="icon-sm"
          className="text-muted-foreground shrink-0"
          onClick={onBack}
        >
          <ChevronLeft className="h-4 w-4" />
        </Button>
        <span className="font-medium text-sm flex-1">New Chat</span>
      </div>

      {/* Agent list */}
      <div className="flex-1 overflow-y-auto">
        <p className="text-xs text-muted-foreground px-4 py-2">
          Select an agent to chat with:
        </p>
        {activeAgents.map((agent) => (
          <button
            key={agent.id}
            type="button"
            className="flex items-center gap-3 w-full px-4 py-2.5 hover:bg-accent/50 transition-colors text-left"
            onClick={() => onSelectAgent(agent)}
          >
            <div className="h-8 w-8 rounded-full bg-muted flex items-center justify-center shrink-0">
              <AgentIcon
                icon={agent.icon}
                className="h-4 w-4 text-muted-foreground"
              />
            </div>
            <div className="flex-1 min-w-0">
              <span className="text-sm font-medium block truncate">
                {agent.name}
              </span>
              {agent.title && (
                <span className="text-xs text-muted-foreground/60 block truncate">
                  {agent.title}
                </span>
              )}
            </div>
            <MessageSquare className="h-3.5 w-3.5 text-muted-foreground/40 shrink-0" />
          </button>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main ChatPanel
// ---------------------------------------------------------------------------

export function ChatPanel() {
  const {
    activeChat,
    isChatPanelOpen,
    toggleChatPanel,
    openChat,
    resumeChat,
    closeChat,
    endRunChat,
    deleteChat,
  } = useChat();
  const queryClient = useQueryClient();

  const [panelView, setPanelView] = useState<PanelView>("list");

  const isRunInjection = !!activeChat?.runId;

  const handleClose = () => {
    if (activeChat) {
      if (isRunInjection) {
        void endRunChat();
      } else {
        closeChat();
      }
    } else {
      toggleChatPanel();
    }
  };

  const handleBackToList = () => {
    closeChat();
    setPanelView("list");
  };

  const handleNewChat = () => {
    setPanelView("picker");
  };

  const handleSelectAgent = async (agent: Agent) => {
    await openChat({ id: agent.id, name: agent.name, icon: agent.icon });
    setPanelView("list");
  };

  const handleResumeChat = async (chatId: string) => {
    await resumeChat(chatId);
    setPanelView("list");
  };

  const handleDeleteChat = async (chatId: string) => {
    await deleteChat(chatId);
    void queryClient.invalidateQueries({ queryKey: ["chats"] });
  };

  return (
    <Sheet
      open={isChatPanelOpen}
      onOpenChange={(open) => {
        if (!open) handleClose();
      }}
    >
      <SheetContent
        side="right"
        showCloseButton={false}
        className="w-full sm:max-w-lg p-0 flex flex-col"
      >
        {activeChat ? (
          <>
            {/* Active chat header */}
            <div className="flex items-center gap-3 px-4 py-3 border-b border-border shrink-0">
              {/* Back button */}
              <Button
                variant="ghost"
                size="icon-sm"
                className="text-muted-foreground shrink-0"
                onClick={handleBackToList}
                title="Back to chat list"
              >
                <ChevronLeft className="h-4 w-4" />
              </Button>

              <div className="h-8 w-8 rounded-full bg-muted flex items-center justify-center shrink-0">
                <AgentIcon
                  icon={activeChat.agentIcon}
                  className="h-5 w-5 text-muted-foreground"
                />
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <MessageSquare className="h-3.5 w-3.5 text-blue-500 shrink-0" />
                  <span className="font-medium text-sm truncate">
                    {activeChat.agentName}
                  </span>
                </div>
                {isRunInjection && activeChat.issueTitle && (
                  <p className="text-xs text-muted-foreground truncate mt-0.5">
                    Chatting on: {activeChat.issueTitle}
                  </p>
                )}
              </div>

              {/* Action button */}
              {isRunInjection ? (
                <Button
                  variant="outline"
                  size="sm"
                  className="shrink-0 text-xs gap-1.5"
                  onClick={() => void endRunChat()}
                >
                  <LogOut className="h-3 w-3" />
                  Exit &amp; Resume
                </Button>
              ) : null}

              <Button
                variant="ghost"
                size="icon-sm"
                className="text-muted-foreground shrink-0 ml-auto"
                onClick={handleClose}
                title="Close panel"
              >
                <X className="h-4 w-4" />
              </Button>
            </div>

            {/* Chat view */}
            <div className="flex-1 min-h-0">
              <ChatView
                agentId={activeChat.agentId}
                agentName={activeChat.agentName}
                agentIcon={activeChat.agentIcon}
                chatId={activeChat.chatId}
                runId={activeChat.runId}
                initialMessages={activeChat.initialMessages}
              />
            </div>
          </>
        ) : panelView === "picker" ? (
          <AgentPickerView
            onBack={() => setPanelView("list")}
            onSelectAgent={(agent) => void handleSelectAgent(agent)}
          />
        ) : (
          <>
            <ChatListView
              onNewChat={handleNewChat}
              onResumeChat={(chatId) => void handleResumeChat(chatId)}
              onDeleteChat={(chatId) => void handleDeleteChat(chatId)}
            />
            {/* Close button at top right */}
            <Button
              variant="ghost"
              size="icon-sm"
              className="absolute top-3 right-3 text-muted-foreground"
              onClick={() => toggleChatPanel()}
            >
              <X className="h-4 w-4" />
            </Button>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}
