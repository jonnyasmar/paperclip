import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import { Send, Mic, Paperclip, ChevronDown, ChevronRight, Wrench } from "lucide-react";
import { MarkdownBody } from "./MarkdownBody";
import { AgentIcon } from "./AgentIconPicker";
import { Button } from "@/components/ui/button";
import { cn } from "../lib/utils";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ToolCall {
  name: string;
  args: string;
  result?: string;
}

interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  thinking?: string;
  toolCalls?: ToolCall[];
  streaming?: boolean;
  timestamp: Date;
}

interface InitialMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  thinking?: string;
  toolCalls?: ToolCall[];
  timestamp: string;
}

interface ChatViewProps {
  agentId: string;
  agentName: string;
  agentIcon?: string | null;
  chatId: string;
  runId?: string;
  initialMessages?: InitialMessage[];
}

// ---------------------------------------------------------------------------
// SSE message sender
// ---------------------------------------------------------------------------

function useStreamingChat(
  agentId: string,
  chatId: string,
  runId?: string,
  initialMessages?: InitialMessage[],
) {
  const [messages, setMessages] = useState<ChatMessage[]>(() => {
    if (!initialMessages?.length) return [];
    return initialMessages.map((m) => ({
      id: m.id,
      role: m.role,
      content: m.content,
      thinking: m.thinking,
      toolCalls: m.toolCalls,
      streaming: false,
      timestamp: new Date(m.timestamp),
    }));
  });
  const [isStreaming, setIsStreaming] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  const sendMessage = useCallback(
    async (text: string) => {
      // Add user message
      const userMsg: ChatMessage = {
        id: crypto.randomUUID(),
        role: "user",
        content: text,
        timestamp: new Date(),
      };

      const assistantId = crypto.randomUUID();
      const assistantMsg: ChatMessage = {
        id: assistantId,
        role: "assistant",
        content: "",
        thinking: "",
        toolCalls: [],
        streaming: true,
        timestamp: new Date(),
      };

      setMessages((prev) => [...prev, userMsg, assistantMsg]);
      setIsStreaming(true);

      const controller = new AbortController();
      abortRef.current = controller;

      const endpoint = runId
        ? `/api/runs/${runId}/chat/message`
        : `/api/agents/${agentId}/chat/message`;

      try {
        const response = await fetch(endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({ chatId, message: text }),
          signal: controller.signal,
        });

        if (!response.ok || !response.body) {
          throw new Error(`Chat request failed: ${response.status}`);
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";

          for (const line of lines) {
            if (!line.startsWith("data: ")) continue;
            const jsonStr = line.slice(6).trim();
            if (!jsonStr) continue;

            try {
              const event = JSON.parse(jsonStr);
              setMessages((prev) =>
                prev.map((msg) => {
                  if (msg.id !== assistantId) return msg;
                  return applyStreamEvent(msg, event);
                }),
              );
            } catch {
              // Skip malformed JSON
            }
          }
        }
      } catch (err) {
        if ((err as Error).name === "AbortError") return;
        setMessages((prev) =>
          prev.map((msg) =>
            msg.id === assistantId
              ? {
                  ...msg,
                  content:
                    msg.content ||
                    `Error: ${(err as Error).message ?? "Connection failed"}`,
                  streaming: false,
                }
              : msg,
          ),
        );
      } finally {
        setIsStreaming(false);
        abortRef.current = null;
        // Finalize streaming
        setMessages((prev) =>
          prev.map((msg) =>
            msg.id === assistantId ? { ...msg, streaming: false } : msg,
          ),
        );
      }
    },
    [agentId, chatId, runId],
  );

  return { messages, isStreaming, sendMessage };
}

/**
 * Apply a single SSE event to the assistant message being built up.
 */
function applyStreamEvent(msg: ChatMessage, event: Record<string, unknown>): ChatMessage {
  const type = event.type as string | undefined;

  if (type === "assistant") {
    // Content block messages
    const message = event.message as { content?: Array<Record<string, unknown>> } | undefined;
    if (message?.content) {
      let content = msg.content;
      let thinking = msg.thinking ?? "";
      const toolCalls = [...(msg.toolCalls ?? [])];

      for (const block of message.content) {
        if (block.type === "text" && typeof block.text === "string") {
          content = block.text;
        } else if (block.type === "thinking" && typeof block.thinking === "string") {
          thinking = block.thinking;
        } else if (block.type === "tool_use") {
          toolCalls.push({
            name: (block.name as string) ?? "unknown",
            args: typeof block.input === "string"
              ? block.input
              : JSON.stringify(block.input ?? {}, null, 2),
          });
        }
      }

      return { ...msg, content, thinking, toolCalls };
    }
    return msg;
  }

  if (type === "content_block_delta") {
    const delta = event.delta as Record<string, unknown> | undefined;
    if (delta?.type === "text_delta" && typeof delta.text === "string") {
      return { ...msg, content: msg.content + delta.text };
    }
    if (delta?.type === "thinking_delta" && typeof delta.thinking === "string") {
      return { ...msg, thinking: (msg.thinking ?? "") + delta.thinking };
    }
    return msg;
  }

  if (type === "result") {
    // Final result — may include the full text
    if (typeof event.result === "string" && event.result) {
      return { ...msg, content: event.result };
    }
    return msg;
  }

  return msg;
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function ThinkingBlock({ text, streaming }: { text: string; streaming?: boolean }) {
  const [expanded, setExpanded] = useState(true);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Auto-scroll thinking card while streaming
  useEffect(() => {
    if (streaming && expanded && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [text, streaming, expanded]);

  if (!text) return null;

  return (
    <div className="mt-2 mb-2 rounded-lg border border-muted-foreground/15 bg-muted/20 overflow-hidden">
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-1.5 w-full px-3 py-1.5 text-xs text-muted-foreground/60 hover:text-muted-foreground hover:bg-muted/30 transition-colors"
      >
        {expanded ? (
          <ChevronDown className="h-3 w-3 shrink-0" />
        ) : (
          <ChevronRight className="h-3 w-3 shrink-0" />
        )}
        <span className="italic">Thinking{streaming ? "..." : ""}</span>
        {!expanded && (
          <span className="ml-auto text-[10px] text-muted-foreground/40 truncate max-w-[200px]">
            {text.slice(0, 60)}...
          </span>
        )}
      </button>
      {expanded && (
        <div
          ref={scrollRef}
          className="px-3 pb-2 max-h-48 overflow-y-auto text-xs text-muted-foreground/60 italic whitespace-pre-wrap leading-relaxed"
        >
          {text}
        </div>
      )}
    </div>
  );
}

function ToolCallBlock({ toolCall }: { toolCall: ToolCall }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="mt-1.5 rounded-lg border border-muted-foreground/15 bg-muted/20 overflow-hidden">
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-1.5 w-full px-3 py-1.5 text-xs text-muted-foreground/70 hover:text-muted-foreground hover:bg-muted/30 transition-colors"
      >
        <Wrench className="h-3 w-3 shrink-0 text-blue-400/70" />
        <span className="font-mono font-medium">{toolCall.name}</span>
        {toolCall.result && (
          <span className="ml-1 text-[10px] text-green-400/60">✓</span>
        )}
        <span className="ml-auto">
          {expanded ? (
            <ChevronDown className="h-3 w-3" />
          ) : (
            <ChevronRight className="h-3 w-3" />
          )}
        </span>
      </button>
      {expanded && (
        <div className="border-t border-muted-foreground/10">
          <div className="px-3 py-1.5">
            <div className="text-[10px] uppercase tracking-wide text-muted-foreground/40 mb-1">Input</div>
            <pre className="p-2 rounded-md bg-black/20 text-[11px] text-muted-foreground overflow-x-auto max-h-40 overflow-y-auto">
              {toolCall.args}
            </pre>
          </div>
          {toolCall.result && (
            <div className="px-3 py-1.5 border-t border-muted-foreground/10">
              <div className="text-[10px] uppercase tracking-wide text-muted-foreground/40 mb-1">Output</div>
              <pre className="p-2 rounded-md bg-black/20 text-[11px] text-muted-foreground overflow-x-auto max-h-40 overflow-y-auto">
                {toolCall.result}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function MessageBubble({
  message,
  agentName,
  agentIcon,
}: {
  message: ChatMessage;
  agentName: string;
  agentIcon?: string | null;
}) {
  if (message.role === "user") {
    return (
      <div className="flex justify-end mb-3">
        <div className="max-w-[80%] rounded-2xl rounded-br-md bg-blue-600 text-white px-4 py-2.5 text-sm shadow-sm">
          <p className="whitespace-pre-wrap">{message.content}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex gap-2.5 mb-3">
      <div className="shrink-0 mt-1">
        <div className="h-7 w-7 rounded-full bg-muted flex items-center justify-center">
          <AgentIcon icon={agentIcon} className="h-4 w-4 text-muted-foreground" />
        </div>
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-xs font-medium text-muted-foreground mb-1">
          {agentName}
        </div>

        {message.thinking && <ThinkingBlock text={message.thinking} streaming={message.streaming} />}

        {message.toolCalls?.map((tc, i) => (
          <ToolCallBlock key={i} toolCall={tc} />
        ))}

        {message.content ? (
          <div className="rounded-2xl rounded-tl-md bg-card border border-border px-4 py-2.5 shadow-sm">
            <MarkdownBody className="text-sm">{message.content}</MarkdownBody>
          </div>
        ) : message.streaming ? (
          <div className="rounded-2xl rounded-tl-md bg-card border border-border px-4 py-2.5 shadow-sm">
            <span className="inline-flex gap-1 items-center text-sm text-muted-foreground">
              <span className="relative flex h-2 w-2">
                <span className="animate-pulse absolute inline-flex h-full w-full rounded-full bg-blue-400 opacity-75" />
                <span className="relative inline-flex rounded-full h-2 w-2 bg-blue-500" />
              </span>
              Thinking...
            </span>
          </div>
        ) : null}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function ChatView({
  agentId,
  agentName,
  agentIcon,
  chatId,
  runId,
  initialMessages,
}: ChatViewProps) {
  const { messages, isStreaming, sendMessage } = useStreamingChat(
    agentId,
    chatId,
    runId,
    initialMessages,
  );
  const [inputValue, setInputValue] = useState("");
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);

  // Scroll to bottom when new messages arrive
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // Auto-resize textarea
  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = "auto";
    textarea.style.height = `${Math.min(textarea.scrollHeight, 160)}px`;
  }, [inputValue]);

  const handleSend = useCallback(() => {
    const text = inputValue.trim();
    if (!text || isStreaming) return;
    setInputValue("");
    void sendMessage(text);
  }, [inputValue, isStreaming, sendMessage]);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
        e.preventDefault();
        handleSend();
      }
    },
    [handleSend],
  );

  // Voice-to-text (browser API, if available)
  const handleVoice = useCallback(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const SpeechRecognitionCtor =
      (window as any).webkitSpeechRecognition ?? (window as any).SpeechRecognition;
    if (!SpeechRecognitionCtor) return;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const recognition = new SpeechRecognitionCtor() as any;
    recognition.interimResults = false;
    recognition.lang = "en-US";
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    recognition.onresult = (event: any) => {
      const transcript = event.results?.[0]?.[0]?.transcript as string | undefined;
      if (transcript) {
        setInputValue((prev) => (prev ? `${prev} ${transcript}` : transcript));
      }
    };
    recognition.start();
  }, []);

  const hasSpeechAPI =
    typeof window !== "undefined" &&
    ("webkitSpeechRecognition" in window || "SpeechRecognition" in window);

  return (
    <div className="flex flex-col h-full">
      {/* Messages area */}
      <div
        ref={scrollContainerRef}
        className="flex-1 overflow-y-auto px-4 py-4"
      >
        {messages.length === 0 && (
          <div className="flex flex-col items-center justify-center h-full text-center text-muted-foreground">
            <AgentIcon
              icon={agentIcon}
              className="h-10 w-10 text-muted-foreground/40 mb-3"
            />
            <p className="text-sm font-medium">Chat with {agentName}</p>
            <p className="text-xs mt-1">Send a message to start the conversation.</p>
          </div>
        )}

        {messages.map((msg) => (
          <MessageBubble
            key={msg.id}
            message={msg}
            agentName={agentName}
            agentIcon={agentIcon}
          />
        ))}
        <div ref={messagesEndRef} />
      </div>

      {/* Input bar */}
      <div className="border-t border-border p-3 bg-background">
        <div className="flex items-end gap-2">
          {/* Attachment button (skeleton, disabled) */}
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className="text-muted-foreground/40 shrink-0"
            disabled
            title="File attachments (coming soon)"
          >
            <Paperclip className="h-4 w-4" />
          </Button>

          <div className="flex-1 min-w-0 relative">
            <textarea
              ref={textareaRef}
              value={inputValue}
              onChange={(e) => setInputValue(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Type a message... (Cmd+Enter to send)"
              rows={1}
              className={cn(
                "w-full resize-none overflow-hidden rounded-lg border border-border bg-muted/30 px-3 py-2 text-sm",
                "placeholder:text-muted-foreground/50",
                "focus:outline-none focus:ring-2 focus:ring-ring focus:border-transparent",
                "max-h-40 scrollbar-thin",
              )}
            />
          </div>

          {/* Voice button */}
          {hasSpeechAPI && (
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              className="text-muted-foreground/60 hover:text-foreground shrink-0"
              onClick={handleVoice}
              title="Voice input"
            >
              <Mic className="h-4 w-4" />
            </Button>
          )}

          {/* Send button */}
          <Button
            type="button"
            size="icon-sm"
            className="shrink-0"
            disabled={!inputValue.trim() || isStreaming}
            onClick={handleSend}
            title="Send message"
          >
            <Send className="h-4 w-4" />
          </Button>
        </div>
      </div>
    </div>
  );
}
