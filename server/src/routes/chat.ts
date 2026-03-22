import { Router, type Request, type Response } from "express";
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { Db } from "@paperclipai/db";
import { heartbeatRuns } from "@paperclipai/db";
import { eq } from "drizzle-orm";
import { assertBoard } from "./authz.js";
import { agentService, heartbeatService } from "../services/index.js";
import { runningProcesses } from "../adapters/index.js";
import { notFound, unprocessable } from "../errors.js";
import { logger } from "../middleware/logger.js";
import { parseObject, asString } from "../adapters/utils.js";
import { ensurePathInEnv } from "@paperclipai/adapter-utils/server-utils";
import {
  createPersistedChat,
  readChat,
  appendMessage,
  updateSessionId,
  deletePersistedChat,
  listChats,
  type PersistedMessage,
} from "../services/chat-store.js";

// ---------------------------------------------------------------------------
// Chat session store (in-memory)
// ---------------------------------------------------------------------------

interface ChatSession {
  chatId: string;
  agentId: string;
  companyId?: string;
  agentName: string;
  agentIcon: string | null;
  runId?: string;
  sessionId: string | null;
  createdAt: Date;
  activeChild: ChildProcess | null;
}

const chatSessions = new Map<string, ChatSession>();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getSession(chatId: string): ChatSession {
  const session = chatSessions.get(chatId);
  if (!session) throw notFound("Chat session not found");
  return session;
}

function resolveClaudeBinary(agentConfig: Record<string, unknown>): string {
  return asString(agentConfig.command, "claude");
}

function resolveAgentModel(agentConfig: Record<string, unknown>): string {
  return asString(agentConfig.model, "");
}

function resolveAgentCwd(agentConfig: Record<string, unknown>): string {
  return asString(agentConfig.cwd, "") || process.cwd();
}

function resolveAgentInstructionsPath(agentConfig: Record<string, unknown>): string {
  return asString(agentConfig.instructionsFilePath, "").trim();
}

/**
 * Spawn a `claude -p` process and stream its output as SSE events.
 * Also persists user + assistant messages to the chat JSON file.
 */
function spawnChatMessage(
  session: ChatSession,
  message: string,
  agentConfig: Record<string, unknown>,
  res: Response,
) {
  const command = resolveClaudeBinary(agentConfig);
  const model = resolveAgentModel(agentConfig);
  const cwd = resolveAgentCwd(agentConfig);
  const instructionsFilePath = resolveAgentInstructionsPath(agentConfig);

  const isFirstMessage = !session.sessionId;

  // Build args
  const args: string[] = ["-p"];

  // Build prompt
  let prompt = message;
  if (isFirstMessage) {
    prompt =
      "You are in a live chat with the board (Jonny). This is not a task — just a conversation. Be yourself.\n\n" +
      message;
  }
  args.push(prompt);

  if (session.sessionId) {
    args.push("--resume", session.sessionId);
  }

  if (instructionsFilePath) {
    args.push("--append-system-prompt-file", instructionsFilePath);
  }

  args.push("--output-format", "stream-json", "--include-partial-messages", "--dangerously-skip-permissions");

  if (model) {
    args.push("--model", model);
  }

  // Build env (inherit process env, add agent's configured env vars)
  const envConfig = parseObject(agentConfig.env);
  const envOverrides: Record<string, string> = {};
  for (const [key, value] of Object.entries(envConfig)) {
    if (typeof value === "string") {
      envOverrides[key] = value;
    } else if (typeof value === "object" && value !== null && "value" in (value as Record<string, unknown>)) {
      // Handle {"type": "plain", "value": "..."} format
      const v = (value as Record<string, unknown>).value;
      if (typeof v === "string") envOverrides[key] = v;
    }
  }
  const env = ensurePathInEnv({
    ...process.env,
    ...envOverrides,
    PAPERCLIP_AGENT_ID: session.agentId,
    PAPERCLIP_COMPANY_ID: session.companyId ?? "",
    PAPERCLIP_API_URL: process.env.PAPERCLIP_API_URL ?? `http://127.0.0.1:${process.env.PORT ?? "3100"}`,
  }) as Record<string, string>;

  // Persist user message
  const userMsgId = randomUUID();
  const userMsg: PersistedMessage = {
    id: userMsgId,
    role: "user",
    content: message,
    timestamp: new Date().toISOString(),
  };
  appendMessage(session.chatId, userMsg);

  // SSE headers
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });

  const envKeys = Object.keys(envOverrides);
  logger.info(
    { chatId: session.chatId, command, args: args.slice(0, 4), cwd, envOverrideKeys: envKeys },
    "chat: spawning claude process",
  );

  const child = spawn(command, args, {
    cwd,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });

  session.activeChild = child;

  let capturedSessionId: string | null = null;
  let stdoutBuffer = "";

  // Accumulate assistant response for persistence
  let assistantContent = "";
  let assistantThinking = "";
  const assistantToolCalls: Array<{ name: string; args: string; result?: string }> = [];

  child.stdout!.on("data", (chunk: Buffer) => {
    stdoutBuffer += chunk.toString();
    const lines = stdoutBuffer.split("\n");
    // Keep the last (possibly incomplete) line in the buffer
    stdoutBuffer = lines.pop() ?? "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const event = JSON.parse(trimmed);
        // Extract session_id from stream events
        if (event.session_id && typeof event.session_id === "string") {
          capturedSessionId = event.session_id;
        }
        // Accumulate assistant content for persistence
        accumulateAssistantContent(event, {
          onText: (t) => { assistantContent = t; },
          onTextDelta: (d) => { assistantContent += d; },
          onThinking: (t) => { assistantThinking = t; },
          onThinkingDelta: (d) => { assistantThinking += d; },
          onToolUse: (tc) => { assistantToolCalls.push(tc); },
          onResult: (r) => { assistantContent = r; },
        });
        res.write(`data: ${JSON.stringify(event)}\n\n`);
      } catch {
        // Not JSON — skip
      }
    }
  });

  child.stderr!.on("data", (chunk: Buffer) => {
    const text = chunk.toString().trim();
    if (text) {
      logger.warn({ chatId: session.chatId, stderr: text }, "chat: claude stderr");
    }
  });

  child.on("error", (err) => {
    logger.error({ err, chatId: session.chatId }, "chat: claude process error");
    try {
      res.write(
        `data: ${JSON.stringify({ type: "error", error: err.message })}\n\n`,
      );
      res.end();
    } catch {
      // Response may already be closed
    }
    session.activeChild = null;
  });

  child.on("close", (code) => {
    // Process any remaining buffered data
    if (stdoutBuffer.trim()) {
      try {
        const event = JSON.parse(stdoutBuffer.trim());
        if (event.session_id && typeof event.session_id === "string") {
          capturedSessionId = event.session_id;
        }
        accumulateAssistantContent(event, {
          onText: (t) => { assistantContent = t; },
          onTextDelta: (d) => { assistantContent += d; },
          onThinking: (t) => { assistantThinking = t; },
          onThinkingDelta: (d) => { assistantThinking += d; },
          onToolUse: (tc) => { assistantToolCalls.push(tc); },
          onResult: (r) => { assistantContent = r; },
        });
        res.write(`data: ${JSON.stringify(event)}\n\n`);
      } catch {
        // Not JSON — skip
      }
    }

    // Save session ID
    if (capturedSessionId) {
      session.sessionId = capturedSessionId;
      updateSessionId(session.chatId, capturedSessionId);
    }

    // Persist assistant message
    if (assistantContent || assistantThinking || assistantToolCalls.length > 0) {
      const assistantMsg: PersistedMessage = {
        id: randomUUID(),
        role: "assistant",
        content: assistantContent,
        timestamp: new Date().toISOString(),
      };
      if (assistantThinking) assistantMsg.thinking = assistantThinking;
      if (assistantToolCalls.length > 0) assistantMsg.toolCalls = assistantToolCalls;
      appendMessage(session.chatId, assistantMsg);
    }

    try {
      res.write(
        `data: ${JSON.stringify({
          type: "done",
          exitCode: code,
          sessionId: session.sessionId,
        })}\n\n`,
      );
      res.end();
    } catch {
      // Response may already be closed
    }
    session.activeChild = null;
  });

  // If the client disconnects, kill the child
  res.on("close", () => {
    if (!child.killed) {
      child.kill("SIGTERM");
    }
    session.activeChild = null;
  });
}

/**
 * Extract content from stream events for persistence accumulation.
 */
function accumulateAssistantContent(
  event: Record<string, unknown>,
  handlers: {
    onText: (text: string) => void;
    onTextDelta: (delta: string) => void;
    onThinking: (text: string) => void;
    onThinkingDelta: (delta: string) => void;
    onToolUse: (tc: { name: string; args: string }) => void;
    onResult: (result: string) => void;
  },
) {
  const type = event.type as string | undefined;

  if (type === "assistant") {
    const message = event.message as { content?: Array<Record<string, unknown>> } | undefined;
    if (message?.content) {
      for (const block of message.content) {
        if (block.type === "text" && typeof block.text === "string") {
          handlers.onText(block.text);
        } else if (block.type === "thinking" && typeof block.thinking === "string") {
          handlers.onThinking(block.thinking);
        } else if (block.type === "tool_use") {
          handlers.onToolUse({
            name: (block.name as string) ?? "unknown",
            args: typeof block.input === "string"
              ? block.input
              : JSON.stringify(block.input ?? {}, null, 2),
          });
        }
      }
    }
  }

  if (type === "content_block_delta") {
    const delta = event.delta as Record<string, unknown> | undefined;
    if (delta?.type === "text_delta" && typeof delta.text === "string") {
      handlers.onTextDelta(delta.text);
    }
    if (delta?.type === "thinking_delta" && typeof delta.thinking === "string") {
      handlers.onThinkingDelta(delta.thinking);
    }
  }

  if (type === "result") {
    if (typeof event.result === "string" && event.result) {
      handlers.onResult(event.result);
    }
  }
}

// ---------------------------------------------------------------------------
// Route factory
// ---------------------------------------------------------------------------

export function chatRoutes(db: Db) {
  const router = Router();
  const agents = agentService(db);
  const heartbeat = heartbeatService(db);

  // =========================================================================
  // Chat Persistence — List / Get / Delete
  // =========================================================================

  // GET /chats — List all persisted chats (summaries)
  router.get("/chats", async (req: Request, res: Response) => {
    assertBoard(req);
    const summaries = listChats();
    res.json(summaries);
  });

  // GET /chats/:chatId — Get a specific chat with all messages
  router.get("/chats/:chatId", async (req: Request, res: Response) => {
    assertBoard(req);
    const chatId = req.params.chatId as string;
    const chat = readChat(chatId);
    if (!chat) throw notFound("Chat not found");
    res.json(chat);
  });

  // DELETE /chats/:chatId — Delete a persisted chat
  router.delete("/chats/:chatId", async (req: Request, res: Response) => {
    assertBoard(req);
    const chatId = req.params.chatId as string;

    // Also clean up in-memory session if active
    const session = chatSessions.get(chatId);
    if (session) {
      if (session.activeChild && !session.activeChild.killed) {
        session.activeChild.kill("SIGTERM");
      }
      chatSessions.delete(chatId);
    }

    deletePersistedChat(chatId);
    res.json({ ok: true });
  });

  // =========================================================================
  // Free Chat
  // =========================================================================

  // POST /agents/:agentId/chat — Start a new chat session
  router.post("/agents/:agentId/chat", async (req: Request, res: Response) => {
    assertBoard(req);
    const agentId = req.params.agentId as string;
    const agent = await agents.getById(agentId);
    if (!agent) throw notFound("Agent not found");

    const chatId = randomUUID();
    const session: ChatSession = {
      chatId,
      agentId: agent.id,
      companyId: agent.companyId,
      agentName: agent.name,
      agentIcon: (agent.icon as string) ?? null,
      sessionId: null,
      createdAt: new Date(),
      activeChild: null,
    };
    chatSessions.set(chatId, session);

    // Persist to file
    createPersistedChat({
      chatId,
      agentId: agent.id,
      agentName: agent.name,
      agentIcon: (agent.icon as string) ?? null,
      sessionId: null,
    });

    res.json({ chatId, sessionId: null });
  });

  // POST /agents/:agentId/chat/message — Send a message
  router.post(
    "/agents/:agentId/chat/message",
    async (req: Request, res: Response) => {
      assertBoard(req);
      const agentId = req.params.agentId as string;
      const { chatId, message } = req.body as {
        chatId: string;
        message: string;
      };

      if (!chatId || !message) {
        throw unprocessable("chatId and message are required");
      }

      // Try in-memory session first, otherwise restore from disk
      let session = chatSessions.get(chatId);
      if (!session) {
        const persisted = readChat(chatId);
        if (persisted && persisted.agentId === agentId) {
          session = {
            chatId: persisted.chatId,
            agentId: persisted.agentId,
            agentName: persisted.agentName,
            agentIcon: persisted.agentIcon,
            runId: persisted.runId ?? undefined,
            sessionId: persisted.sessionId,
            createdAt: new Date(persisted.createdAt),
            activeChild: null,
          };
          chatSessions.set(chatId, session);
        } else {
          throw notFound("Chat session not found");
        }
      }

      if (session.agentId !== agentId) {
        throw unprocessable("Chat session does not belong to this agent");
      }

      const agent = await agents.getById(agentId);
      if (!agent) throw notFound("Agent not found");

      const agentConfig = parseObject(agent.adapterConfig);
      spawnChatMessage(session, message, agentConfig, res);
    },
  );

  // DELETE /agents/:agentId/chat?chatId=... — End the chat session (in-memory only, preserves persistence)
  router.delete(
    "/agents/:agentId/chat",
    async (req: Request, res: Response) => {
      assertBoard(req);
      const chatId = (req.query.chatId as string | undefined) ?? (req.body as { chatId?: string })?.chatId ?? "";
      if (!chatId) throw unprocessable("chatId is required");

      const session = chatSessions.get(chatId);
      if (session) {
        if (session.activeChild && !session.activeChild.killed) {
          session.activeChild.kill("SIGTERM");
        }
        chatSessions.delete(chatId);
      }

      res.json({ ok: true });
    },
  );

  // =========================================================================
  // Run Injection
  // =========================================================================

  // POST /runs/:runId/chat — Interrupt a run and open a chat
  router.post("/runs/:runId/chat", async (req: Request, res: Response) => {
    assertBoard(req);
    const runId = req.params.runId as string;

    // Get the running process info
    const runningProcess = runningProcesses.get(runId);
    if (!runningProcess) {
      throw notFound("No running process found for this run");
    }

    // Get the run from DB to find agent + session
    const [run] = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runId))
      .limit(1);
    if (!run) throw notFound("Run not found");

    // Kill the running process (same as hot-restart)
    runningProcess.child.kill("SIGTERM");
    const graceMs = Math.max(1, runningProcess.graceSec) * 1000;
    setTimeout(() => {
      if (!runningProcess.child.killed) {
        runningProcess.child.kill("SIGKILL");
      }
    }, graceMs);

    // Extract session ID from the run
    const sessionIdAfter = run.sessionIdAfter ?? null;

    // Get agent info for persistence
    const agent = await agents.getById(run.agentId);

    const chatId = randomUUID();
    const session: ChatSession = {
      chatId,
      agentId: run.agentId,
      agentName: agent?.name ?? "Unknown",
      agentIcon: (agent?.icon as string) ?? null,
      runId,
      sessionId: sessionIdAfter,
      createdAt: new Date(),
      activeChild: null,
    };
    chatSessions.set(chatId, session);

    // Persist to file
    createPersistedChat({
      chatId,
      agentId: run.agentId,
      agentName: agent?.name ?? "Unknown",
      agentIcon: (agent?.icon as string) ?? null,
      runId,
      sessionId: sessionIdAfter,
    });

    res.json({ chatId, sessionId: sessionIdAfter, runId });
  });

  // POST /runs/:runId/chat/message — Send a message in injected chat
  router.post(
    "/runs/:runId/chat/message",
    async (req: Request, res: Response) => {
      assertBoard(req);
      const runId = req.params.runId as string;
      const { chatId, message } = req.body as {
        chatId: string;
        message: string;
      };

      if (!chatId || !message) {
        throw unprocessable("chatId and message are required");
      }

      // Try in-memory session first, otherwise restore from disk
      let session = chatSessions.get(chatId);
      if (!session) {
        const persisted = readChat(chatId);
        if (persisted && persisted.runId === runId) {
          session = {
            chatId: persisted.chatId,
            agentId: persisted.agentId,
            agentName: persisted.agentName,
            agentIcon: persisted.agentIcon,
            runId: persisted.runId ?? undefined,
            sessionId: persisted.sessionId,
            createdAt: new Date(persisted.createdAt),
            activeChild: null,
          };
          chatSessions.set(chatId, session);
        } else {
          throw notFound("Chat session not found");
        }
      }

      if (session.runId !== runId) {
        throw unprocessable("Chat session does not belong to this run");
      }

      const agent = await agents.getById(session.agentId);
      if (!agent) throw notFound("Agent not found");

      const agentConfig = parseObject(agent.adapterConfig);
      spawnChatMessage(session, message, agentConfig, res);
    },
  );

  // DELETE /runs/:runId/chat?chatId=... — Exit injection and resume the run
  router.delete(
    "/runs/:runId/chat",
    async (req: Request, res: Response) => {
      assertBoard(req);
      const runId = req.params.runId as string;
      const chatId = (req.query.chatId as string | undefined) ?? (req.body as { chatId?: string })?.chatId ?? "";
      if (!chatId) throw unprocessable("chatId is required");

      const session = getSession(chatId);
      if (session.runId !== runId) {
        throw unprocessable("Chat session does not belong to this run");
      }

      // Kill any active child
      if (session.activeChild && !session.activeChild.killed) {
        session.activeChild.kill("SIGTERM");
      }

      // Resume the run via heartbeat wakeup with the chat session ID
      // so it resumes with full context of the chat
      const [run] = await db
        .select()
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, runId))
        .limit(1);
      const contextSnapshot = (run?.contextSnapshot as Record<string, unknown>) ?? {};

      await heartbeat.wakeup(session.agentId, {
        source: "on_demand",
        triggerDetail: "system",
        reason: "chat_injection_resume",
        contextSnapshot: {
          ...contextSnapshot,
          wakeReason: "chat_injection_resume",
          resumeSessionId: session.sessionId,
        },
      });

      chatSessions.delete(chatId);

      // Delete persisted chat for run injection chats (they are temporary)
      deletePersistedChat(chatId);

      res.json({ ok: true, resumedRunId: runId });
    },
  );

  return router;
}
