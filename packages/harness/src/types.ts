import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js';

export type ToolOutcome = CallToolResult & { denied?: boolean; reason?: string };
export interface ToolDescriptor {
  readonly canonicalName: string;
  readonly description: string;
  readonly inputSchema: Tool['inputSchema'];
}
export interface PlannerGateway {
  readonly instructions: string;
  readonly tools: readonly ToolDescriptor[];
  invoke(name: string, input: unknown, signal?: AbortSignal): Promise<ToolOutcome>;
  close(): Promise<void>;
}
/** Transport seam for deterministic tests; executors never escape the gateway. */
export interface Connection {
  listTools(): Promise<Tool[]>;
  callTool(name: string, input: Record<string, unknown>, signal: AbortSignal): Promise<CallToolResult>;
  close(): Promise<void>;
}
export interface GuardAudit {
  time: string; host: 'pi'; runId: string; canonicalName: string; deal: string;
  allow: boolean; rules: string[]; reason: string;
}
