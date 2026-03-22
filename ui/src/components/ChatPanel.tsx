import { X, LogOut, MessageSquare } from "lucide-react";
import {
  Sheet,
  SheetContent,
} from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { AgentIcon } from "./AgentIconPicker";
import { ChatView } from "./ChatView";
import { useChat } from "../context/ChatContext";

export function ChatPanel() {
  const { activeChat, closeChat } = useChat();
  const isOpen = activeChat !== null;
  const isRunInjection = !!activeChat?.runId;

  return (
    <Sheet
      open={isOpen}
      onOpenChange={(open) => {
        if (!open) void closeChat();
      }}
    >
      <SheetContent
        side="right"
        showCloseButton={false}
        className="w-full sm:max-w-lg p-0 flex flex-col"
      >
        {activeChat && (
          <>
            {/* Header */}
            <div className="flex items-center gap-3 px-4 py-3 border-b border-border shrink-0">
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
                  onClick={() => void closeChat()}
                >
                  <LogOut className="h-3 w-3" />
                  Exit &amp; Resume
                </Button>
              ) : (
                <Button
                  variant="ghost"
                  size="sm"
                  className="shrink-0 text-xs text-muted-foreground gap-1.5"
                  onClick={() => void closeChat()}
                >
                  End Chat
                </Button>
              )}

              <Button
                variant="ghost"
                size="icon-sm"
                className="text-muted-foreground shrink-0"
                onClick={() => void closeChat()}
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
              />
            </div>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}
