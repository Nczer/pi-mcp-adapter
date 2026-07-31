import { describe, expect, it, vi } from "vitest";
import { updateStatusBar } from "../init.ts";
import { formatMcpStatus } from "../utils.ts";
import type { McpSettings } from "../types.ts";

function createState(ui: unknown, settings: Partial<McpSettings> = {}) {
  return {
    ui,
    config: { settings, mcpServers: { demo: { command: "demo" } } },
    manager: { getAllConnections: vi.fn(() => new Map()) },
  } as any;
}

describe("formatMcpStatus", () => {
  it("returns undefined when the MCP footer is off", () => {
    expect(formatMcpStatus({ settings: { mcpFooterStatus: "off" } }, "connecting...")).toBeUndefined();
  });
});

describe("updateStatusBar", () => {
  it("shows connected/total servers as the status", () => {
    const setStatus = vi.fn();
    const state = createState({ setStatus });

    updateStatusBar(state);

    // Custom branch: plain "MCP:" prefix, simple connected/total count.
    expect(setStatus).toHaveBeenCalledWith("mcp", "MCP: 0/1 servers");
  });

  it("counts tracked connections (incl. needs-auth) toward the connected count", () => {
    const setStatus = vi.fn();
    const state = createState({ setStatus });
    state.manager.getAllConnections.mockReturnValue(new Map([["demo", { status: "needs-auth" }]]));

    updateStatusBar(state);

    expect(setStatus).toHaveBeenCalledWith("mcp", "MCP: 1/1 servers");
  });

  it("shows connected servers as the count", () => {
    const setStatus = vi.fn();
    const state = createState({ setStatus });
    state.manager.getAllConnections.mockReturnValue(new Map([["demo", { status: "connected" }]]));

    updateStatusBar(state);

    expect(setStatus).toHaveBeenCalledWith("mcp", "MCP: 1/1 servers");
  });

  it("uses the dim/accent themed status when a theme is available", () => {
    const setStatus = vi.fn();
    const state = createState({
      setStatus,
      theme: { fg: vi.fn((_name: string, text: string) => `styled:${text}`) },
    });

    updateStatusBar(state);

    expect(setStatus).toHaveBeenCalledWith("mcp", "styled:· styled:MCP: styled:0/1 servers");
  });

  it("ignores the showStatusIcon opt-out (custom prefix always wins)", () => {
    const setStatus = vi.fn();
    updateStatusBar(createState({ setStatus }, { showStatusIcon: true }));

    expect(setStatus).toHaveBeenCalledWith("mcp", "MCP: 0/1 servers");
  });

  it("keeps themed dim/accent formatting with disabled servers in the total", () => {
    const setStatus = vi.fn();
    const state = createState({
      setStatus,
      theme: { fg: vi.fn((_name: string, text: string) => `styled:${text}`) },
    }, { showStatusIcon: false });
    state.config.mcpServers.disabled = { command: "disabled", disabled: true };
    state.manager.getAllConnections.mockReturnValue(new Map([[
      "demo", { status: "connected" },
    ]]));

    updateStatusBar(state);

    expect(setStatus).toHaveBeenCalledWith("mcp", "styled:· styled:MCP: styled:1/2 servers");
  });

  it("can show a compact connected/enabled footer", () => {
    const setStatus = vi.fn();
    const state = createState({ setStatus }, { mcpFooterStatus: "compact" });
    state.manager.getAllConnections.mockReturnValue(new Map([["demo", { status: "connected" }]]));

    updateStatusBar(state);

    expect(setStatus).toHaveBeenCalledWith("mcp", "MCP 1/1");
  });

  it("can clear the MCP footer status", () => {
    const setStatus = vi.fn();
    updateStatusBar(createState({ setStatus }, { mcpFooterStatus: "off" }));

    expect(setStatus).toHaveBeenCalledWith("mcp", undefined);
  });
});
