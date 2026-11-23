import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { toMcpName, toolsForProfiles, type OutputResponse } from "@tabagent/protocol";
import { BRIDGE_VERSION } from "./version";
import { renderMcp } from "./format";

/** Runs one tool call and returns the response. */
export type CallFn = (tool: string, params: Record<string, unknown>) => Promise<OutputResponse>;

export interface McpOpts {
  call: CallFn;
  profile: string;
  onClientInfo?: (name: string | undefined) => void;
}

export const INSTRUCTIONS =
  "TabAgent drives the user's real Chrome (their sign-ins). Open a tab with tabs (action=new), then nav_goto, nav_back, nav_forward, nav_reload. " +
  "Tools act only on this session's own tabs. On PERMISSION_DENIED tell the user and do not retry in a loop.";

export function buildMcpServer(o: McpOpts): McpServer {
  const server = new McpServer({ name: "tabagent", version: BRIDGE_VERSION }, { instructions: INSTRUCTIONS, capabilities: { tools: {} } });
  server.server.oninitialized = () => {
    o.onClientInfo?.(server.server.getClientVersion()?.name);
  };
  for (const tool of toolsForProfiles(o.profile)) {
    server.registerTool(
      toMcpName(tool.name),
      {
        description: tool.description,
        inputSchema: tool.params.shape,
        // Only non-default hints.
        ...(tool.level === "read" || tool.sensitive ? { annotations: { ...(tool.level === "read" ? { readOnlyHint: true } : {}), ...(tool.sensitive ? { destructiveHint: true } : {}) } } : {}),
      },
      async (args: Record<string, unknown>) => renderMcp(await o.call(tool.name, args ?? {})) as any,
    );
  }
  return server;
}
