// session-recovery.ts
//
// Streamable HTTP session recovery.
//
// Per the MCP spec (Streamable HTTP transport):
//   "When a client receives HTTP 404 in response to a request containing an
//   Mcp-Session-Id, it MUST start a new session by sending a new
//   InitializeRequest without a session ID attached."
//
// A 404 for a request that carried a session ID is therefore the spec's own
// definition of "this session no longer exists" (e.g. the remote server
// process restarted and lost its in-memory session table). Because the spec
// requires the server to reject the request *before* processing it, retrying
// the same call against a freshly initialized session cannot double-execute
// the original request.
//
// This module intentionally does NOT:
//   - match on error message text
//   - match on any other HTTP status (in particular 400, which is ambiguous
//     and can mean many things other than "your session is gone")
//   - treat AbortError/cancellation as a session failure
import { StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { logger } from "./logger.ts";
import { throwIfAborted } from "./abort.ts";
import type { McpConfig } from "./types.ts";
import type { McpServerManager, ServerConnection } from "./server-manager.ts";

/**
 * True when `err` is the MCP spec's exact definition of "this Streamable
 * HTTP session no longer exists on the server": a 404 `StreamableHTTPError`
 * for a request that was sent while carrying an `Mcp-Session-Id`.
 *
 * `hadSessionId` must reflect the transport's session id from *before* the
 * call that produced `err` was made. The installed SDK (1.29.0) happens not
 * to clear `transport.sessionId` on a 404 response, so checking it at catch
 * time currently agrees with checking it up front — but callers should
 * capture it before the call rather than rely on that incidental behavior.
 */
export function isTerminatedSession(err: unknown, hadSessionId: boolean): boolean {
  return err instanceof StreamableHTTPError && err.code === 404 && hadSessionId;
}

function hasSessionId(connection: ServerConnection): boolean {
  // Only StreamableHTTPClientTransport exposes `sessionId`; stdio/SSE
  // transports (and test doubles that omit `transport` entirely) simply
  // read as `undefined` here.
  const transport = connection.transport as { sessionId?: string } | undefined;
  return transport?.sessionId != null;
}

export class SessionRecoveryAuthRequiredError extends Error {
  constructor(readonly serverName: string, readonly authMessage?: string) {
    super(authMessage ?? `MCP server "${serverName}" requires OAuth authentication after reconnect.`);
    this.name = "SessionRecoveryAuthRequiredError";
  }
}

export interface SessionRecoveryDeps {
  manager: McpServerManager;
  config: McpConfig;
  signal?: AbortSignal;
  onNeedsAuth?: (serverName: string) => Promise<ServerConnection | undefined>;
}

/**
 * Runs `fn` against the current connection for `serverName`. If it fails
 * with a terminated Streamable HTTP session (see `isTerminatedSession`),
 * reconnects exactly once via `McpServerManager.reconnect` (single-flight,
 * identity-guarded — see server-manager.ts) and retries `fn` exactly once
 * against the fresh connection.
 *
 * Any other failure — including a second failure after reconnecting, or the
 * server having been removed from config in the meantime — propagates
 * unchanged through the caller's existing error handling.
 */
export async function withSessionRecovery<T>(
  deps: SessionRecoveryDeps,
  serverName: string,
  fn: (conn: ServerConnection) => Promise<T>,
): Promise<T> {
  const connection = deps.manager.getConnection(serverName);
  if (!connection) {
    throw new Error(`Server "${serverName}" is not connected`);
  }

  const hadSessionId = hasSessionId(connection);

  try {
    return await fn(connection);
  } catch (err) {
    if (!isTerminatedSession(err, hadSessionId)) {
      throw err;
    }

    // Re-read the live definition rather than reusing the stale
    // connection's definition, in case config changed since connect. If the
    // server was removed from config in the meantime there is nothing to
    // reconnect to, so surface the original error.
    const definition = deps.config.mcpServers[serverName];
    if (!definition) {
      throw err;
    }

    throwIfAborted(deps.signal);
    logger.debug(`MCP session for "${serverName}" expired (404 + Mcp-Session-Id); reconnecting`, {
      server: serverName,
    });
    let freshConnection = deps.signal
      ? await deps.manager.reconnect(serverName, definition, connection, deps.signal)
      : await deps.manager.reconnect(serverName, definition, connection);
    throwIfAborted(deps.signal);

    if (freshConnection.status === "needs-auth") {
      freshConnection = await deps.onNeedsAuth?.(serverName) ?? freshConnection;
      throwIfAborted(deps.signal);
    }

    if (freshConnection.status === "needs-auth") {
      throw new SessionRecoveryAuthRequiredError(serverName);
    }
    if (freshConnection.status !== "connected") {
      throw err;
    }

    return fn(freshConnection);
  }
}
