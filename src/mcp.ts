import fs from 'node:fs';
import path from 'node:path';
import { Router, Response, json } from 'express';
import { sync as writeFileAtomicSync } from 'write-file-atomic';
import { McpClient, Implementation, McpError, ErrorCode } from './McpClient';
import { UserDirectoryList, Request } from './types';

// Extend the Express Request type to include user property

export const jsonParser = json({ limit: '200mb' });

// Define types
interface McpServerEntry {
  name: string;
  command: string;
  args: string[];
  env: Record<string, string>;
  type: string;
  url?: string;
  headers?: Record<string, string>;
}

interface McpServerDictionary {
  mcpServers: Record<string, McpServerEntry>;
  disabledTools: Record<string, string[]>; // Map of server names to their disabled tools
  disabledServers: string[]; // Array of disabled server names
  cachedTools: Record<string, any[]>; // Map of server names to their cached tool data
}

// Map to store MCP clients
const mcpClients: Map<string, McpClient> = new Map();

export const MCP_SETTINGS_FILE = 'mcp_settings.json';

/**
 * Reads MCP settings from the settings file
 */
export function readMcpSettings(directories: UserDirectoryList): McpServerDictionary {
  const filePath = path.join(directories.root, MCP_SETTINGS_FILE);
  if (!fs.existsSync(filePath)) {
    const defaultSettings: McpServerDictionary = {
      mcpServers: {},
      disabledTools: {},
      disabledServers: [],
      cachedTools: {},
    };
    writeFileAtomicSync(filePath, JSON.stringify(defaultSettings, null, 4), 'utf-8');
    return defaultSettings;
  }

  const fileContents = fs.readFileSync(filePath, 'utf-8');
  const settings = JSON.parse(fileContents) as McpServerDictionary;

  // Migration: Add missing fields if they don't exist
  if (!settings.disabledTools) {
    settings.disabledTools = {};
  }
  if (!settings.disabledServers) {
    settings.disabledServers = [];
  }
  if (!settings.cachedTools) {
    settings.cachedTools = {};
  }

  return settings;
}

/**
 * Writes MCP settings to the settings file
 */
export function writeMcpSettings(directories: UserDirectoryList, settings: McpServerDictionary): void {
  const filePath = path.join(directories.root, MCP_SETTINGS_FILE);
  writeFileAtomicSync(filePath, JSON.stringify(settings, null, 4), 'utf-8');
}

/**
 * Creates a client configuration for a server
 */
function createClientInfo(serverName: string): Implementation {
  return {
    name: `sillytavern-${serverName}-client`,
    version: '1.0.0',
  };
}

/**
 * Starts an MCP server process and connects to it using JSON-RPC
 */
async function startMcpServer(serverName: string, config: McpServerEntry) {
  if (mcpClients.has(serverName)) {
    console.warn(`[MCP] Server "${serverName}" is already running`);
    return;
  }

  const transportType = config.type || 'stdio';

  if (transportType === 'stdio') {
    const env = { ...process.env, ...config.env } as Record<string, string>;
    let command = config.command;
    let args = config.args || [];

    // Windows-specific fix: Wrap the command in cmd /C to ensure proper path resolution
    if (process.platform === 'win32' && !command.toLowerCase().includes('cmd')) {
      const originalCommand = command;
      const originalArgs = [...args];
      command = 'cmd';
      args = ['/C', originalCommand, ...originalArgs];
      console.log(`[MCP] Windows detected, wrapping command: cmd /C ${originalCommand} ${originalArgs.join(' ')}`);
    }

    const client = new McpClient(
      {
        command,
        args,
        env,
      },
      createClientInfo(serverName),
      {
        tools: { listChanged: true },
      },
    );

    try {
      await client.connect();
      mcpClients.set(serverName, client);
      console.log(`[MCP] Connected to server "${serverName}" using JSON-RPC with stdio transport`);
    } catch (error: any) {
      throw new McpError(ErrorCode.ConnectionClosed, `Failed to connect to server: ${error.message}`);
    }
  } else if (transportType === 'streamableHttp' || transportType === 'sse') {
    if (!config.url) {
      throw new McpError(
        ErrorCode.InvalidRequest,
        `Server "${serverName}" requires a URL for ${transportType} transport`,
      );
    }
    const client = new McpClient(
      {
        url: config.url,
        env: config.env || {},
        transport: transportType,
        headers: config.headers || {},
      },
      createClientInfo(serverName),
      {
        tools: { listChanged: true },
      },
    );
    try {
      await client.connect();
      mcpClients.set(serverName, client);
      console.log(`[MCP] Connected to server "${serverName}" using JSON-RPC with ${transportType} transport`);
    } catch (error: any) {
      throw new McpError(ErrorCode.ConnectionClosed, `Failed to connect to server: ${error.message}`);
    }
  } else {
    throw new McpError(ErrorCode.InvalidRequest, `Unsupported transport type: ${transportType}`);
  }
}

/**
 * Reloads tool cache for a specific server
 */
async function reloadToolCache(
  serverName: string,
  settings: McpServerDictionary,
  directories: UserDirectoryList,
): Promise<{ tools: any[]; error?: any }> {
  const wasRunning = mcpClients.has(serverName);

  try {
    if (!mcpClients.has(serverName)) {
      // Try to start server temporarily
      await startMcpServer(serverName, settings.mcpServers[serverName]);
    }

    const client = mcpClients.get(serverName);
    console.log(`[MCP] Reloading tool cache from server "${serverName}"`);

    const tools = await client?.listTools();

    // Cache tools
    settings.cachedTools[serverName] = tools?.tools || [];
    writeMcpSettings(directories, settings);

    if (!wasRunning) {
      // Stop the server if we started it temporarily
      await stopMcpServer(serverName);
    }

    return { tools: tools?.tools || [] };
  } catch (error: any) {
    try {
      if (!wasRunning && mcpClients.has(serverName)) {
        // Stop the server if we started it temporarily
        await stopMcpServer(serverName);
      }
    } catch (error) {
      // Ignore error during cleanup
    }

    console.error('[MCP] Error reloading tool cache:', error);
    return { error, tools: [] };
  }
}

/**
 * Stops an MCP server process
 */
async function stopMcpServer(serverName: string) {
  if (!mcpClients.has(serverName)) {
    console.warn(`[MCP] Server "${serverName}" is not running`);
    return;
  }

  const client = mcpClients.get(serverName);
  await client?.close();
  mcpClients.delete(serverName);
  console.log(`[MCP] Disconnected from server "${serverName}"`);
}

export async function mcpInit(router: Router): Promise<void> {
  // Get all MCP servers
  // @ts-ignore
  router.get('/servers', (request: Request, response: Response) => {
    try {
      const settings = readMcpSettings(request.user.directories);
      const servers = Object.entries(settings.mcpServers || {}).map(([name, config]) => {
        const client = mcpClients.get(name);
        return {
          name,
          isRunning: mcpClients.has(name),
          config: {
            command: config.command,
            args: config.args,
            // Don't send environment variables for security
          },
          capabilities: client?.getCapabilities(),
          disabledTools: settings.disabledTools[name] || [],
          enabled: !settings.disabledServers.includes(name),
          cachedTools: settings.cachedTools[name] || [],
        };
      });

      response.json(servers);
    } catch (error: any) {
      console.error('[MCP] Error getting servers:', error);
      response.status(500).json({ error: error?.message || 'Failed to get MCP servers' });
    }
  });

  // Add or update an MCP server
  // @ts-ignore
  router.post('/servers', jsonParser, (request: Request, response: Response) => {
    try {
      const { name, config } = request.body;

      if (!name || typeof name !== 'string') {
        return response.status(400).json({ error: 'Server name is required' });
      }

      if (!config || typeof config !== 'object') {
        return response.status(400).json({ error: 'Server configuration is required' });
      }

      // Validate based on transport type
      const transportType = config.type || 'stdio';
      if (transportType === 'stdio') {
        if (!config.command || typeof config.command !== 'string') {
          return response.status(400).json({
            error: 'Server command is required for stdio transport',
          });
        }
      } else if (transportType === 'streamableHttp' || transportType === 'sse') {
        if (!config.url || typeof config.url !== 'string') {
          return response.status(400).json({
            error: `Server URL is required for ${transportType} transport`,
          });
        }
      } else {
        return response.status(400).json({ error: `Unsupported transport type: ${transportType}` });
      }

      const settings = readMcpSettings(request.user.directories);

      if (!settings.mcpServers) {
        settings.mcpServers = {};
      }

      if (settings.mcpServers[name]) {
        response.status(409).json({ error: `Server "${name}" already exists` });
      }

      settings.mcpServers[name] = config;
      writeMcpSettings(request.user.directories, settings);

      response.json({});
    } catch (error: any) {
      console.error('[MCP] Error adding/updating server:', error);
      response.status(500).json({ error: error?.message || 'Failed to add/update MCP server' });
    }
  });

  // Delete an MCP server
  // @ts-ignore
  router.delete('/servers/:name', (request: Request, response: Response) => {
    try {
      const { name } = request.params;

      if (mcpClients.has(name)) {
        stopMcpServer(name);
      }

      const settings = readMcpSettings(request.user.directories);

      if (settings.mcpServers && settings.mcpServers[name]) {
        delete settings.mcpServers[name];
        delete settings.disabledTools[name];
        delete settings.cachedTools[name];
        writeMcpSettings(request.user.directories, settings);
      }

      response.json({});
    } catch (error: any) {
      console.error('[MCP] Error deleting server:', error);
      response.status(500).json({ error: error?.message || 'Failed to delete MCP server' });
    }
  });

  // Update disabled servers
  // @ts-ignore
  router.post('/servers/disabled', jsonParser, (request: Request, response: Response) => {
    try {
      const { disabledServers } = request.body;

      if (!Array.isArray(disabledServers)) {
        return response.status(400).json({
          error: 'disabledServers must be an array of server names',
        });
      }

      const settings = readMcpSettings(request.user.directories);

      // Update disabled servers
      settings.disabledServers = disabledServers;
      writeMcpSettings(request.user.directories, settings);

      response.json({});
    } catch (error: any) {
      console.error('[MCP] Error updating disabled servers:', error);
      response.status(500).json({
        error: error?.message || 'Failed to update disabled MCP servers',
      });
    }
  });

  // Start an MCP server
  // @ts-ignore
  router.post('/servers/:name/start', async (request: Request, response: Response) => {
    try {
      const { name } = request.params;
      const settings = readMcpSettings(request.user.directories);

      if (!settings.mcpServers || !settings.mcpServers[name]) {
        return response.status(404).json({ error: 'Server not found' });
      }

      if (settings.disabledServers.includes(name)) {
        return response.status(403).json({ error: 'Server is disabled' });
      }

      const config = settings.mcpServers[name];

      await startMcpServer(name, config);
      response.json({});
    } catch (error: any) {
      console.error('[MCP] Error starting server:', error);
      response.status(500).json({ error: error?.message || 'Failed to start MCP server' });
    }
  });

  // Stop an MCP server
  // @ts-ignore
  router.post('/servers/:name/stop', async (request: Request, response: Response) => {
    try {
      const { name } = request.params;

      if (!mcpClients.has(name)) {
        return response.status(400).json({ error: 'Server is not running' });
      }

      await stopMcpServer(name);
      response.json({});
    } catch (error: any) {
      console.error('[MCP] Error stopping server:', error);
      response.status(500).json({ error: error?.message || 'Failed to stop MCP server' });
    }
  });

  // List tools from an MCP server
  // @ts-ignore
  router.get('/servers/:name/list-tools', async (request: Request, response: Response) => {
    try {
      const { name } = request.params;
      const settings = readMcpSettings(request.user.directories);

      if (!settings.mcpServers || !settings.mcpServers[name]) {
        return response.status(404).json({ error: 'Server not found' });
      }

      const disabledTools = settings.disabledTools[name] || [];
      const cachedTools = settings.cachedTools[name] || [];

      // If we have cached tools, use them
      if (cachedTools.length > 0) {
        const toolsWithStatus = cachedTools.map((tool) => ({
          ...tool,
          _enabled: !disabledTools.includes(tool.name),
        }));
        return response.json(toolsWithStatus);
      }

      // Try to reload tool cache
      const { tools: reloadedTools } = await reloadToolCache(name, settings, request.user.directories);

      const toolsWithStatus = reloadedTools.map((tool: { name: string }) => ({
        ...tool,
        _enabled: !disabledTools.includes(tool.name),
      }));

      response.json(toolsWithStatus || []);
    } catch (error: any) {
      console.error('[MCP] Error listing tools:', error);
      response.status(500).json({ error: error?.message || 'Failed to list tools' });
    }
  });

  // Update disabled tools for a server
  // @ts-ignore
  router.post('/servers/:name/disabled-tools', jsonParser, async (request: Request, response: Response) => {
    try {
      const { name } = request.params;
      const { disabledTools } = request.body;

      if (!Array.isArray(disabledTools)) {
        return response.status(400).json({ error: 'disabledTools must be an array of tool names' });
      }

      const settings = readMcpSettings(request.user.directories);

      if (!settings.mcpServers || !settings.mcpServers[name]) {
        return response.status(404).json({ error: 'Server not found' });
      }

      // Update disabled tools
      settings.disabledTools[name] = disabledTools;
      writeMcpSettings(request.user.directories, settings);

      response.json({});
    } catch (error: any) {
      console.error('[MCP] Error updating disabled tools:', error);
      response.status(500).json({ error: error?.message || 'Failed to update disabled tools' });
    }
  });

  // Reload tool cache for a server
  // @ts-ignore
  router.post('/servers/:name/reload-tools', async (request: Request, response: Response) => {
    try {
      const { name } = request.params;
      const settings = readMcpSettings(request.user.directories);

      if (!settings.mcpServers || !settings.mcpServers[name]) {
        return response.status(404).json({ error: 'Server not found' });
      }

      const { tools } = await reloadToolCache(name, settings, request.user.directories);

      const disabledTools = settings.disabledTools[name] || [];
      const toolsWithStatus = tools.map((tool: { name: string }) => ({
        ...tool,
        _enabled: !disabledTools.includes(tool.name),
      }));

      response.json(toolsWithStatus);
    } catch (error: any) {
      console.error('[MCP] Error reloading tool cache:', error);
      response.status(500).json({ error: error?.message || 'Failed to reload tool cache' });
    }
  });

  // Call a tool on an MCP server
  // @ts-ignore
  router.post('/servers/:name/call-tool', jsonParser, async (request: Request, response: Response) => {
    try {
      const { name } = request.params;
      const { toolName, arguments: toolArgs } = request.body;

      if (!mcpClients.has(name)) {
        return response.status(400).json({ error: 'Server is not running' });
      }

      if (!toolName || typeof toolName !== 'string') {
        return response.status(400).json({ error: 'Tool name is required' });
      }

      if (!toolArgs || typeof toolArgs !== 'object') {
        return response.status(400).json({ error: 'Tool arguments must be an object' });
      }

      // Check if the tool is enabled
      const settings = readMcpSettings(request.user.directories);
      const disabledTools = settings.disabledTools[name] || [];

      if (disabledTools.includes(toolName)) {
        return response.status(403).json({ error: 'This tool is disabled' });
      }

      const client = mcpClients.get(name);
      const tool = settings.cachedTools[name]?.find((t) => t.name === toolName);

      if (!tool) {
        return response.status(404).json({ error: 'Tool not found' });
      }

      const schema = tool.inputSchema;
      console.log(`[MCP] Calling tool "${toolName}" on server "${name}" with arguments:`, toolArgs);

      try {
        const result = await client?.callTool(
          {
            name: toolName,
            arguments: toolArgs,
          },
          schema,
        );

        response.json({
          result: {
            toolName,
            status: 'executed',
            data: result,
          },
        });
      } catch (error: any) {
        if (error instanceof McpError) {
          response.status(500).json({
            error: error.message,
            code: error.code,
            data: error.data,
          });
        } else {
          response.status(500).json({
            error: error?.message || 'Failed to execute tool',
            code: ErrorCode.InternalError,
          });
        }
      }
    } catch (error: any) {
      console.error('[MCP] Error calling tool:', error);
      response.status(500).json({ error: error?.message || 'Failed to call tool' });
    }
  });
}
