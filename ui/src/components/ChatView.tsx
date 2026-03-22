import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import { Send, Mic, Paperclip, ChevronDown, ChevronRight, Wrench, Brain } from "lucide-react";
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

  // stream_event wraps raw API streaming events (from --include-partial-messages)
  // Structure: { type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "..." } } }
  if (type === "stream_event") {
    const inner = event.event as Record<string, unknown> | undefined;
    if (!inner) return msg;

    const innerType = inner.type as string | undefined;

    if (innerType === "content_block_delta") {
      const delta = inner.delta as Record<string, unknown> | undefined;
      if (delta?.type === "text_delta" && typeof delta.text === "string") {
        return { ...msg, content: msg.content + delta.text };
      }
      if (delta?.type === "thinking_delta" && typeof delta.thinking === "string") {
        return { ...msg, thinking: (msg.thinking ?? "") + delta.thinking };
      }
    }

    return msg;
  }

  if (type === "assistant") {
    // Full content snapshot messages (without --include-partial-messages, or final state)
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
          // Only add if we haven't seen this tool call yet
          const args = typeof block.input === "string"
            ? block.input
            : JSON.stringify(block.input ?? {}, null, 2);
          const existing = toolCalls.find((tc) => tc.name === block.name && tc.args === args);
          if (!existing) {
            toolCalls.push({
              name: (block.name as string) ?? "unknown",
              args,
            });
          }
        } else if (block.type === "tool_result") {
          // Tool result — attach to the most recent matching tool call
          const resultContent = typeof block.content === "string"
            ? block.content
            : Array.isArray(block.content)
              ? (block.content as Array<Record<string, unknown>>).map((c) => c.text ?? JSON.stringify(c)).join("\n")
              : JSON.stringify(block.content ?? "");
          // Attach to last tool call without a result
          const lastWithoutResult = [...toolCalls].reverse().find((tc) => !tc.result);
          if (lastWithoutResult) {
            lastWithoutResult.result = resultContent;
          }
        }
      }

      return { ...msg, content, thinking, toolCalls };
    }
    return msg;
  }

  if (type === "content_block_delta") {
    // Top-level delta (fallback for non-stream_event format)
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
    // Final result — use as fallback if no text was streamed
    if (typeof event.result === "string" && event.result && !msg.content) {
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

  useEffect(() => {
    if (streaming && expanded && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [text, streaming, expanded]);

  if (!text) return null;

  return (
    <div className="mb-1">
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-1 text-xs text-purple-400/70 hover:text-purple-400 transition-colors"
      >
        <Brain className="h-3 w-3" />
        <span className="italic">Thinking{streaming ? "..." : ""}</span>
        {expanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
      </button>
      {expanded && (
        <div
          ref={scrollRef}
          className="max-h-32 overflow-y-auto text-xs text-muted-foreground/60 italic whitespace-pre-wrap leading-relaxed pl-4"
        >
          {text}
        </div>
      )}
    </div>
  );
}

function ToolCallBlock({ toolCall }: { toolCall: ToolCall }) {
  const [expanded, setExpanded] = useState(true);

  return (
    <div className="mb-1">
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-1 text-xs text-blue-400/70 hover:text-blue-400 transition-colors"
      >
        <Wrench className="h-3 w-3" />
        <span className="font-mono">{toolCall.name}</span>
        {toolCall.result && <span className="text-green-500/70 text-[10px]">✓</span>}
        {expanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
      </button>
      {expanded && (
        <div className="pl-4 mt-0.5">
          <pre className="text-[11px] text-muted-foreground/60 overflow-x-auto max-h-32 overflow-y-auto whitespace-pre-wrap">
            {toolCall.args}
          </pre>
          {toolCall.result && (
            <pre className="text-[11px] text-muted-foreground/60 overflow-x-auto max-h-32 overflow-y-auto whitespace-pre-wrap mt-1 pt-1 border-t border-muted-foreground/15">
              {toolCall.result}
            </pre>
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
  const timestamp = message.timestamp
    ? new Date(message.timestamp).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
    : "";

  if (message.role === "user") {
    return (
      <div className="flex justify-end mb-4">
        <div className="max-w-[80%]">
          <div className="rounded-2xl rounded-br-md bg-blue-600 text-white px-4 py-2.5 text-sm shadow-sm">
            <p className="whitespace-pre-wrap">{message.content}</p>
          </div>
          {timestamp && (
            <div className="text-[10px] text-muted-foreground/40 text-right mt-1 mr-1">{timestamp}</div>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="mb-4">
      <div className="flex items-center gap-2 mb-1.5">
        <div className="h-5 w-5 rounded-full bg-muted flex items-center justify-center">
          <AgentIcon icon={agentIcon} className="h-3 w-3 text-muted-foreground" />
        </div>
        <span className="text-xs font-medium text-muted-foreground">{agentName}</span>
        {timestamp && (
          <span className="text-[10px] text-muted-foreground/40">{timestamp}</span>
        )}
      </div>

      {message.thinking && <ThinkingBlock text={message.thinking} streaming={message.streaming} />}

      {message.toolCalls && message.toolCalls.length > 0 && (
        <div className="space-y-1.5 mb-2">
          {message.toolCalls.map((tc, i) => (
            <ToolCallBlock key={i} toolCall={tc} />
          ))}
        </div>
      )}

      {message.content ? (
        <div className="text-sm">
          <MarkdownBody>{message.content}</MarkdownBody>
        </div>
      ) : message.streaming ? (
        <span className="inline-flex gap-1 items-center text-sm text-muted-foreground">
          <span className="relative flex h-2 w-2">
            <span className="animate-pulse absolute inline-flex h-full w-full rounded-full bg-blue-400 opacity-75" />
            <span className="relative inline-flex rounded-full h-2 w-2 bg-blue-500" />
          </span>
        </span>
      ) : null}
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
      <div className="border-t border-border p-3 bg-background" style={{ paddingBottom: "max(0.75rem, env(safe-area-inset-bottom))" }}>
        <div className="flex items-center gap-2">
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
                "w-full resize-none overflow-hidden rounded-lg border border-border bg-muted/30 px-3 py-[7px] text-sm leading-snug",
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
