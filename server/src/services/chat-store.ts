import fs from "node:fs";
import path from "node:path";
import { resolveDefaultChatsDir } from "../home-paths.js";
import { logger } from "../middleware/logger.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PersistedMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  thinking?: string;
  toolCalls?: Array<{ name: string; args: string; result?: string }>;
  timestamp: string; // ISO
}

export interface PersistedChat {
  chatId: string;
  agentId: string;
  agentName: string;
  agentIcon: string | null;
  runId: string | null;
  sessionId: string | null;
  createdAt: string; // ISO
  updatedAt: string; // ISO
  messages: PersistedMessage[];
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

// ---------------------------------------------------------------------------
// Directory management
// ---------------------------------------------------------------------------

let chatsDir: string | null = null;

function getChatsDir(): string {
  if (!chatsDir) {
    chatsDir = resolveDefaultChatsDir();
    fs.mkdirSync(chatsDir, { recursive: true });
  }
  return chatsDir;
}

function chatFilePath(chatId: string): string {
  // Sanitize chatId to prevent path traversal
  const safe = chatId.replace(/[^a-zA-Z0-9_-]/g, "");
  return path.join(getChatsDir(), `${safe}.json`);
}

// ---------------------------------------------------------------------------
// CRUD operations
// ---------------------------------------------------------------------------

export function createPersistedChat(opts: {
  chatId: string;
  agentId: string;
  agentName: string;
  agentIcon: string | null;
  runId?: string;
  sessionId: string | null;
}): PersistedChat {
  const now = new Date().toISOString();
  const chat: PersistedChat = {
    chatId: opts.chatId,
    agentId: opts.agentId,
    agentName: opts.agentName,
    agentIcon: opts.agentIcon ?? null,
    runId: opts.runId ?? null,
    sessionId: opts.sessionId,
    createdAt: now,
    updatedAt: now,
    messages: [],
  };
  writeChat(chat);
  return chat;
}

export function readChat(chatId: string): PersistedChat | null {
  const filePath = chatFilePath(chatId);
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    return JSON.parse(raw) as PersistedChat;
  } catch {
    return null;
  }
}

function writeChat(chat: PersistedChat): void {
  const filePath = chatFilePath(chat.chatId);
  try {
    fs.writeFileSync(filePath, JSON.stringify(chat, null, 2), "utf-8");
  } catch (err) {
    logger.error({ err, chatId: chat.chatId }, "chat-store: failed to write chat file");
  }
}

export function appendMessage(chatId: string, message: PersistedMessage): void {
  const chat = readChat(chatId);
  if (!chat) return;
  chat.messages.push(message);
  chat.updatedAt = new Date().toISOString();
  writeChat(chat);
}

export function updateSessionId(chatId: string, sessionId: string): void {
  const chat = readChat(chatId);
  if (!chat) return;
  chat.sessionId = sessionId;
  chat.updatedAt = new Date().toISOString();
  writeChat(chat);
}

export function deletePersistedChat(chatId: string): boolean {
  const filePath = chatFilePath(chatId);
  try {
    fs.unlinkSync(filePath);
    return true;
  } catch {
    return false;
  }
}

export function listChats(): ChatSummary[] {
  const dir = getChatsDir();
  let files: string[];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }

  const summaries: ChatSummary[] = [];
  for (const file of files) {
    try {
      const raw = fs.readFileSync(path.join(dir, file), "utf-8");
      const chat = JSON.parse(raw) as PersistedChat;
      const lastMsg = chat.messages[chat.messages.length - 1];
      summaries.push({
        chatId: chat.chatId,
        agentId: chat.agentId,
        agentName: chat.agentName,
        agentIcon: chat.agentIcon,
        runId: chat.runId,
        lastMessage: lastMsg?.content?.slice(0, 200) ?? "",
        messageCount: chat.messages.length,
        createdAt: chat.createdAt,
        updatedAt: chat.updatedAt,
      });
    } catch {
      // Skip corrupt files
    }
  }

  // Sort by updatedAt descending
  summaries.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return summaries;
}
