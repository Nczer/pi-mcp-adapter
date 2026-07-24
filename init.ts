import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { McpExtensionState } from "./state.ts";
import type { ToolMetadata } from "./types.ts";
import { existsSync } from "node:fs";
import { loadMcpConfig } from "./config.ts";
import { ConsentManager } from "./consent-manager.ts";
import { McpLifecycleManager } from "./lifecycle.ts";
import {
  computeServerHash,
  getMetadataCachePath,
  isServerCacheValid,
  loadMetadataCache,
  reconstructToolMetadata,
  saveMetadataCache,
  serializeResources,
  serializeTools,
  type ServerCacheEntry,
} from "./metadata-cache.ts";
import { McpServerManager } from "./server-manager.ts";
import { buildToolMetadata, totalToolCount } from "./tool-metadata.ts";
import { UiResourceHandler } from "./ui-resource-handler.ts";
import { openUrl, parallelLimit, sanitizeTerminalText } from "./utils.ts";
import { logger } from "./logger.ts";
import { getMissingConfiguredDirectToolServers } from "./direct-tools.ts";
import { throwIfAborted } from "./abort.ts";
import { getAuthStorageOptions } from "./mcp-auth.ts";

const FAILURE_BACKOFF_MS = 60 * 1000;
const MAX_FAILURE_MESSAGE_CHARS = 8 * 1024;
const failureExpiryTimers = new WeakMap<McpExtensionState, Map<string, ReturnType<typeof setTimeout>>>();

function getFailureExpiryTimers(state: McpExtensionState): Map<string, ReturnType<typeof setTimeout>> {
  let timers = failureExpiryTimers.get(state);
  if (!timers) {
    timers = new Map();
    failureExpiryTimers.set(state, timers);
  }
  return timers;
}

export function clearFailure(state: McpExtensionState, serverName: string): void {
  state.failureTracker.delete(serverName);
  state.failureMessages?.delete(serverName);
  const timers = failureExpiryTimers.get(state);
  const timer = timers?.get(serverName);
  if (timer) clearTimeout(timer);
  timers?.delete(serverName);
}

export function recordFailure(state: McpExtensionState, serverName: string, message: string): void {
  clearFailure(state, serverName);
  const failedAt = Date.now();
  state.failureTracker.set(serverName, failedAt);
  state.failureMessages?.set(serverName, message.slice(0, MAX_FAILURE_MESSAGE_CHARS));
  const timer = setTimeout(() => {
    if (state.failureTracker.get(serverName) === failedAt) {
      state.failureTracker.delete(serverName);
      state.failureMessages?.delete(serverName);
    }
    getFailureExpiryTimers(state).delete(serverName);
  }, FAILURE_BACKOFF_MS);
  timer.unref?.();
  getFailureExpiryTimers(state).set(serverName, timer);
}

export function isTuiMode(ctx: Pick<ExtensionContext, "hasUI" | "mode">): boolean {
  return ctx.hasUI && ctx.mode === "tui";
}

export async function initializeMcp(
  pi: ExtensionAPI,
  ctx: ExtensionContext
): Promise<McpExtensionState> {
  const configPath = pi.getFlag("mcp-config") as string | undefined;
  const config = loadMcpConfig(configPath, ctx.cwd);
  const authStorageOptions = getAuthStorageOptions(config.settings?.oauthDir, ctx.cwd);

  const manager = new McpServerManager(ctx.cwd);
  manager.setDefaultRequestTimeoutMs(config.settings?.requestTimeoutMs);
  manager.setAuthStorageOptions(authStorageOptions);
  const samplingAutoApprove = config.settings?.samplingAutoApprove === true;
  if (config.settings?.sampling !== false && (ctx.hasUI || samplingAutoApprove)) {
    manager.setSamplingConfig({
      autoApprove: samplingAutoApprove,
      ui: ctx.hasUI ? ctx.ui : undefined,
      modelRegistry: ctx.modelRegistry,
      getCurrentModel: () => ctx.model,
      getSignal: () => ctx.signal,
    });
  }
  const elicitationEnabled = config.settings?.elicitation !== false && ctx.hasUI;
  if (elicitationEnabled) {
    manager.setElicitationConfig({
      ui: ctx.ui,
      allowUrl: isTuiMode(ctx),
    });
  }
  const lifecycle = new McpLifecycleManager(manager);
  const toolMetadata = new Map<string, ToolMetadata[]>();
  const serverInstructions = new Map<string, string>();
  const failureTracker = new Map<string, number>();
  const failureMessages = new Map<string, string>();
  const uiResourceHandler = new UiResourceHandler(manager, config);
  const consentManager = new ConsentManager("once-per-server");
  const ui = ctx.hasUI ? ctx.ui : undefined;
  const state: McpExtensionState = {
    manager,
    lifecycle,
    toolMetadata,
    serverInstructions,
    config,
    authStorageOptions,
    failureTracker,
    failureMessages,
    uiResourceHandler,
    consentManager,
    uiServer: null,
    completedUiSessions: [],
    openBrowser: (url: string) => openUrl(pi, url, process.env.BROWSER),
    ui,
    sendMessage: (message, options) => pi.sendMessage(message as unknown as Parameters<typeof pi.sendMessage>[0], options),
  };

  const serverEntries = Object.entries(config.mcpServers);
  if (serverEntries.length === 0) {
    return state;
  }

  const idleSetting = typeof config.settings?.idleTimeout === "number" ? config.settings.idleTimeout : 10;
  lifecycle.setGlobalIdleTimeout(idleSetting);

  const cachePath = getMetadataCachePath();
  const cacheFileExists = existsSync(cachePath);
  let cache = loadMetadataCache();
  let bootstrapAll = false;

  if (!cacheFileExists) {
    bootstrapAll = true;
    saveMetadataCache({ version: 1, servers: {} });
  } else if (!cache) {
    cache = { version: 1, servers: {} };
    saveMetadataCache(cache);
  }

  const prefix = config.settings?.toolPrefix ?? "server";

  for (const [name, definition] of serverEntries) {
    const lifecycleMode = definition.lifecycle ?? "lazy";
    const persistsAfterFirstSpawn = lifecycleMode === "eager" || lifecycleMode === "lazy-keep-alive";
    const idleOverride = definition.idleTimeout ?? (persistsAfterFirstSpawn ? 0 : undefined);
    lifecycle.registerServer(
      name,
      definition,
      idleOverride !== undefined ? { idleTimeout: idleOverride } : undefined
    );
    if (lifecycleMode === "keep-alive") {
      lifecycle.markKeepAlive(name, definition);
    }

    const cachedEntry = cache?.servers?.[name];
    if (cachedEntry && isServerCacheValid(cachedEntry, definition)) {
      const metadata = reconstructToolMetadata(name, cachedEntry, prefix, definition);
      toolMetadata.set(name, metadata);
      if (cachedEntry.instructions) {
        serverInstructions.set(name, cachedEntry.instructions);
      }
    }
  }

  const startupServers = bootstrapAll
    ? serverEntries
    : serverEntries.filter(([, definition]) => {
        const mode = definition.lifecycle ?? "lazy";
        return mode === "keep-alive" || mode === "eager";
      });

  if (ctx.hasUI && startupServers.length > 0) {
    ctx.ui.setStatus("mcp", `MCP: connecting to ${startupServers.length} servers...`);
  }

  const results = await parallelLimit(startupServers, 10, async ([name, definition]) => {
    try {
      const connection = await manager.connect(name, definition, ctx.signal);
      if (connection.status === "needs-auth") {
        return { name, definition, connection: null, error: `OAuth authentication required. Run /mcp-auth ${name}.` };
      }
      return { name, definition, connection, error: null };
    } catch (error) {
      if (ctx.signal?.aborted) {
        return { name, definition, connection: null, error: null };
      }
      const message = error instanceof Error ? error.message : String(error);
      return { name, definition, connection: null, error: message };
    }
  });

  try {
    void ctx.hasUI;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes("extension ctx is stale after session replacement or reload")) {
      throw error;
    }
    // Session torn down while the eager/keep-alive connect(s) above were still
    // in flight — abandon quietly instead of touching a dead ctx below.
    return state;
  }

  for (const { name, definition, connection, error } of results) {
    if (error || !connection) {
      if (ctx.signal?.aborted) continue;
      if (error) recordFailure(state, name, error);
      const displayError = sanitizeTerminalText(error ?? "Unknown connection failure");
      if (ctx.hasUI) {
        ctx.ui.notify(`MCP: Failed to connect to ${name}: ${displayError}`, "error");
      }
      console.error(`MCP: Failed to connect to ${name}: ${displayError}`);
      continue;
    }

    const { metadata, failedTools } = buildToolMetadata(connection.tools, connection.resources, definition, name, prefix);
    toolMetadata.set(name, metadata);
    if (connection.instructions) {
      serverInstructions.set(name, connection.instructions);
    } else {
      serverInstructions.delete(name);
    }
    updateMetadataCache(state, name);
    markKeepAliveAfterConnect(state, name);

    if (failedTools.length > 0 && ctx.hasUI) {
      ctx.ui.notify(
        `MCP: ${name} - ${failedTools.length} tools skipped`,
        "warning"
      );
    }
  }

  const connectedCount = results.filter(r => r.connection).length;
  const failedCount = results.filter(r => r.error).length;
  if (ctx.hasUI && connectedCount > 0) {
    const totalTools = totalToolCount(state);
    const msg = failedCount > 0
      ? `MCP: ${connectedCount}/${startupServers.length} servers connected (${totalTools} tools)`
      : `MCP: ${connectedCount} servers connected (${totalTools} tools)`;
    ctx.ui.notify(msg, "info");
  }

  const envDirect = process.env.MCP_DIRECT_TOOLS;
  if (envDirect !== "__none__") {
    const currentCache = loadMetadataCache();
    const missingCacheServers = getMissingConfiguredDirectToolServers(config, currentCache);

    if (missingCacheServers.length > 0) {
      const bootstrapResults = await parallelLimit(
        missingCacheServers.filter(name => !results.some(r => r.name === name && r.connection)),
        10,
        async (name) => {
          const definition = config.mcpServers[name];
          try {
            const connection = await manager.connect(name, definition, ctx.signal);
            if (connection.status === "needs-auth") {
              return { name, ok: false };
            }
            updateServerMetadata(state, name);
            updateMetadataCache(state, name);
            markKeepAliveAfterConnect(state, name);
            clearFailure(state, name);
            return { name, ok: true };
          } catch (error) {
            if (ctx.signal?.aborted) return { name, ok: false };
            const message = error instanceof Error ? error.message : String(error);
            recordFailure(state, name, message);
            logger.debug(`MCP: direct-tools bootstrap failed for ${name}: ${sanitizeTerminalText(message)}`);
            return { name, ok: false };
          }
        },
      );
      const bootstrapped = bootstrapResults.filter(r => r.ok).map(r => r.name);
      if (bootstrapped.length > 0 && ctx.hasUI) {
        ctx.ui.notify(`MCP: direct tools for ${bootstrapped.join(", ")} will be available after restart`, "info");
      }
    }
  }

  lifecycle.setReconnectCallback((serverName) => {
    updateServerMetadata(state, serverName);
    updateMetadataCache(state, serverName);
    clearFailure(state, serverName);
    updateStatusBar(state);
  });

  lifecycle.setReconnectFailureCallback((serverName, error) => {
    const message = error instanceof Error ? error.message : String(error);
    recordFailure(state, serverName, message);
    updateStatusBar(state);
  });

  lifecycle.setIdleShutdownCallback((serverName) => {
    const idleMinutes = getEffectiveIdleTimeoutMinutes(state, serverName);
    logger.debug(`${serverName} shut down (idle ${idleMinutes}m)`);
    updateStatusBar(state);
  });

  lifecycle.startHealthChecks();

  return state;
}

export function markKeepAliveAfterConnect(state: McpExtensionState, serverName: string): void {
  const definition = state.config.mcpServers[serverName];
  if ((definition?.lifecycle ?? "lazy") === "lazy-keep-alive") {
    state.lifecycle.markKeepAlive(serverName, definition);
  }
}

export function updateServerMetadata(state: McpExtensionState, serverName: string): void {
  const connection = state.manager.getConnection(serverName);
  if (!connection || connection.status !== "connected") return;

  const definition = state.config.mcpServers[serverName];
  if (!definition) return;

  const prefix = state.config.settings?.toolPrefix ?? "server";

  const { metadata } = buildToolMetadata(connection.tools, connection.resources, definition, serverName, prefix);
  state.toolMetadata.set(serverName, metadata);
  if (connection.instructions) {
    state.serverInstructions.set(serverName, connection.instructions);
  } else {
    state.serverInstructions.delete(serverName);
  }
}

export function updateMetadataCache(state: McpExtensionState, serverName: string): void {
  const connection = state.manager.getConnection(serverName);
  if (!connection || connection.status !== "connected") return;

  const definition = state.config.mcpServers[serverName];
  if (!definition) return;

  const configHash = computeServerHash(definition);
  const existing = loadMetadataCache();
  const existingEntry = existing?.servers?.[serverName];

  const tools = serializeTools(connection.tools);
  let resources = definition.exposeResources === false ? [] : serializeResources(connection.resources);

  if (
    definition.exposeResources !== false &&
    resources.length === 0 &&
    existingEntry?.resources?.length &&
    existingEntry.configHash === configHash
  ) {
    resources = existingEntry.resources;
  }

  const entry: ServerCacheEntry = {
    configHash,
    tools,
    resources,
    instructions: connection.instructions,
    cachedAt: Date.now(),
  };

  saveMetadataCache({ version: 1, servers: { [serverName]: entry } });
}

export function flushMetadataCache(state: McpExtensionState): void {
  for (const [name, connection] of state.manager.getAllConnections()) {
    if (connection.status === "connected") {
      updateMetadataCache(state, name);
    }
  }
}

export function updateStatusBar(state: McpExtensionState): void {
  const ui = state.ui;
  if (!ui) return;
  const total = Object.keys(state.config.mcpServers).length;
  if (total === 0) {
    ui.setStatus("mcp", undefined);
    return;
  }
  const connectedCount = state.manager.getAllConnections().size;
  const status = `MCP: ${connectedCount}/${total} servers`;
  ui.setStatus("mcp", ui.theme ? ui.theme.fg("accent", status) : status);
}

export function getFailureAgeSeconds(state: McpExtensionState, serverName: string): number | null {
  const failedAt = state.failureTracker.get(serverName);
  if (!failedAt) return null;
  const ageMs = Date.now() - failedAt;
  if (ageMs > FAILURE_BACKOFF_MS) return null;
  return Math.round(ageMs / 1000);
}

export function getFailureMessage(state: McpExtensionState, serverName: string): string | null {
  if (getFailureAgeSeconds(state, serverName) === null) return null;
  return state.failureMessages?.get(serverName) ?? null;
}

export async function lazyConnect(state: McpExtensionState, serverName: string, signal?: AbortSignal): Promise<boolean> {
  const connection = state.manager.getConnection(serverName);
  if (connection?.status === "needs-auth") {
    return false;
  }
  if (connection?.status === "connected") {
    updateServerMetadata(state, serverName);
    markKeepAliveAfterConnect(state, serverName);
    return true;
  }

  const failedAgo = getFailureAgeSeconds(state, serverName);
  if (failedAgo !== null) return false;

  const definition = state.config.mcpServers[serverName];
  if (!definition) return false;

  try {
    if (state.ui) {
      state.ui.setStatus("mcp", `MCP: connecting to ${serverName}...`);
    }
    const newConnection = await state.manager.connect(serverName, definition, signal);
    if (newConnection.status === "needs-auth") {
      return false;
    }
    clearFailure(state, serverName);
    updateServerMetadata(state, serverName);
    updateMetadataCache(state, serverName);
    markKeepAliveAfterConnect(state, serverName);
    updateStatusBar(state);
    return true;
  } catch (error) {
    if (signal?.aborted) {
      throwIfAborted(signal);
    }
    const message = error instanceof Error ? error.message : String(error);
    recordFailure(state, serverName, message);
    logger.debug(`MCP: lazy connect failed for ${serverName}: ${sanitizeTerminalText(message)}`);
    updateStatusBar(state);
    return false;
  }
}

function getEffectiveIdleTimeoutMinutes(state: McpExtensionState, serverName: string): number {
  const definition = state.config.mcpServers[serverName];
  if (!definition) {
    return typeof state.config.settings?.idleTimeout === "number" ? state.config.settings.idleTimeout : 10;
  }
  if (typeof definition.idleTimeout === "number") return definition.idleTimeout;
  const mode = definition.lifecycle ?? "lazy";
  if (mode === "eager" || mode === "lazy-keep-alive") return 0;
  return typeof state.config.settings?.idleTimeout === "number" ? state.config.settings.idleTimeout : 10;
}
