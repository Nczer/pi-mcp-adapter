import { beforeEach, describe, expect, it, vi } from "vitest";

// direct-tools.ts calls lazyConnect() before touching the connection; mock
// it the same way __tests__/direct-tools-auto-auth.test.ts does so we can
// drive the "already connected" path directly.
const mocks = vi.hoisted(() => ({
  lazyConnect: vi.fn(),
}));

vi.mock("../init.ts", () => ({
  lazyConnect: mocks.lazyConnect,
  getFailureAgeSeconds: vi.fn(() => null),
}));

describe("session recovery — proxy path (proxy-modes.ts executeCall)", () => {
  it("recovers a terminated Streamable HTTP session transparently mid tool-call", async () => {
    const { executeCall } = await import("../proxy-modes.ts");
    const { StreamableHTTPError } = await import("@modelcontextprotocol/sdk/client/streamableHttp.js");

    const stale = {
      status: "connected" as const,
      transport: { sessionId: "session-1" },
      client: {
        callTool: vi.fn().mockRejectedValueOnce(new StreamableHTTPError(404, "Session not found")),
      },
    };
    const fresh = {
      status: "connected" as const,
      transport: { sessionId: "session-2" },
      client: {
        callTool: vi.fn().mockResolvedValue({ isError: false, content: [{ type: "text", text: "ok" }] }),
      },
    };

    const manager = {
      getConnection: vi.fn(() => stale),
      reconnect: vi.fn(async () => fresh),
      getRequestOptions: vi.fn(() => undefined),
      touch: vi.fn(),
      incrementInFlight: vi.fn(),
      decrementInFlight: vi.fn(),
    };

    const state = {
      config: { settings: {}, mcpServers: { demo: { url: "https://api.example.com/mcp" } } },
      manager,
      toolMetadata: new Map([
        ["demo", [{ name: "demo_search", originalName: "search", description: "Search" }]],
      ]),
      failureTracker: new Map(),
      completedUiSessions: [],
    } as any;

    const result = await executeCall(state, "demo_search", { q: "hello" }, "demo");

    expect(stale.client.callTool).toHaveBeenCalledTimes(1);
    expect(fresh.client.callTool).toHaveBeenCalledTimes(1);
    expect(manager.reconnect).toHaveBeenCalledWith("demo", state.config.mcpServers.demo, stale);
    expect(manager.reconnect).toHaveBeenCalledTimes(1);
    expect(result.content[0].text).toContain("ok");
  });

  it("gives up after one reconnect attempt: a second terminated session propagates as call_failed", async () => {
    const { executeCall } = await import("../proxy-modes.ts");
    const { StreamableHTTPError } = await import("@modelcontextprotocol/sdk/client/streamableHttp.js");

    const stale = {
      status: "connected" as const,
      transport: { sessionId: "session-1" },
      client: { callTool: vi.fn().mockRejectedValue(new StreamableHTTPError(404, "Session not found")) },
    };
    const fresh = {
      status: "connected" as const,
      transport: { sessionId: "session-2" },
      client: { callTool: vi.fn().mockRejectedValue(new StreamableHTTPError(404, "Session not found")) },
    };

    const manager = {
      getConnection: vi.fn(() => stale),
      reconnect: vi.fn(async () => fresh),
      getRequestOptions: vi.fn(() => undefined),
      touch: vi.fn(),
      incrementInFlight: vi.fn(),
      decrementInFlight: vi.fn(),
    };

    const state = {
      config: { settings: {}, mcpServers: { demo: { url: "https://api.example.com/mcp" } } },
      manager,
      toolMetadata: new Map([
        ["demo", [{ name: "demo_search", originalName: "search", description: "Search" }]],
      ]),
      failureTracker: new Map(),
      completedUiSessions: [],
    } as any;

    const result = await executeCall(state, "demo_search", {}, "demo");

    expect(stale.client.callTool).toHaveBeenCalledTimes(1);
    expect(fresh.client.callTool).toHaveBeenCalledTimes(1);
    expect(manager.reconnect).toHaveBeenCalledTimes(1);
    expect(result.details).toMatchObject({ mode: "call", error: "call_failed" });
  });
});

describe("session recovery — direct-tools path (direct-tools.ts createDirectToolExecutor)", () => {
  beforeEach(() => {
    vi.resetModules();
    mocks.lazyConnect.mockReset().mockResolvedValue(true);
  });

  it("recovers a terminated Streamable HTTP session transparently for a direct tool call", async () => {
    const { createDirectToolExecutor } = await import("../direct-tools.ts");
    const { StreamableHTTPError } = await import("@modelcontextprotocol/sdk/client/streamableHttp.js");

    const stale = {
      status: "connected" as const,
      transport: { sessionId: "session-1" },
      client: {
        callTool: vi.fn().mockRejectedValueOnce(new StreamableHTTPError(404, "Session not found")),
      },
    };
    const fresh = {
      status: "connected" as const,
      transport: { sessionId: "session-2" },
      client: {
        callTool: vi.fn().mockResolvedValue({ isError: false, content: [{ type: "text", text: "ok" }] }),
      },
    };

    const manager = {
      getConnection: vi.fn(() => stale),
      reconnect: vi.fn(async () => fresh),
      getRequestOptions: vi.fn(() => undefined),
      touch: vi.fn(),
      incrementInFlight: vi.fn(),
      decrementInFlight: vi.fn(),
    };

    const state = {
      config: { settings: {}, mcpServers: { demo: { url: "https://api.example.com/mcp" } } },
      manager,
      failureTracker: new Map(),
      completedUiSessions: [],
    } as any;

    const executor = createDirectToolExecutor(() => state, () => null, {
      serverName: "demo",
      originalName: "search",
      prefixedName: "demo_search",
      description: "Search",
    });

    const result = await executor("id", { q: "hello" }, undefined, undefined, undefined as any);

    expect(stale.client.callTool).toHaveBeenCalledTimes(1);
    expect(fresh.client.callTool).toHaveBeenCalledTimes(1);
    expect(manager.reconnect).toHaveBeenCalledWith("demo", state.config.mcpServers.demo, stale);
    expect(manager.reconnect).toHaveBeenCalledTimes(1);
    expect(result.content[0].text).toContain("ok");
  });

  it("gives up after one reconnect attempt: a second terminated session propagates as call_failed", async () => {
    const { createDirectToolExecutor } = await import("../direct-tools.ts");
    const { StreamableHTTPError } = await import("@modelcontextprotocol/sdk/client/streamableHttp.js");

    const stale = {
      status: "connected" as const,
      transport: { sessionId: "session-1" },
      client: { callTool: vi.fn().mockRejectedValue(new StreamableHTTPError(404, "Session not found")) },
    };
    const fresh = {
      status: "connected" as const,
      transport: { sessionId: "session-2" },
      client: { callTool: vi.fn().mockRejectedValue(new StreamableHTTPError(404, "Session not found")) },
    };

    const manager = {
      getConnection: vi.fn(() => stale),
      reconnect: vi.fn(async () => fresh),
      getRequestOptions: vi.fn(() => undefined),
      touch: vi.fn(),
      incrementInFlight: vi.fn(),
      decrementInFlight: vi.fn(),
    };

    const state = {
      config: { settings: {}, mcpServers: { demo: { url: "https://api.example.com/mcp" } } },
      manager,
      failureTracker: new Map(),
      completedUiSessions: [],
    } as any;

    const executor = createDirectToolExecutor(() => state, () => null, {
      serverName: "demo",
      originalName: "search",
      prefixedName: "demo_search",
      description: "Search",
    });

    const result = await executor("id", {}, undefined, undefined, undefined as any);

    expect(stale.client.callTool).toHaveBeenCalledTimes(1);
    expect(fresh.client.callTool).toHaveBeenCalledTimes(1);
    expect(manager.reconnect).toHaveBeenCalledTimes(1);
    expect(result.details).toMatchObject({ error: "call_failed", server: "demo" });
  });
});
