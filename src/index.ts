import { Router } from 'express';
import { MCP_SETTINGS_FILE, mcpInit, readMcpSettings, Request } from './mcp';
import path from 'node:path';
import { exec } from 'child_process';

const ID = 'mcp';

async function init(router: Router): Promise<void> {
	console.log('<<<< [MCP-BACKEND-PATCH] v1.1 LOADED >>>>'); // <-- ADD THIS LINE
  mcpInit(router);
  // @ts-ignore
  router.post('/open-settings', (request: Request, response) => {
    // Make sure file is exist
    readMcpSettings(request.user.directories);

    // Open in explorer
    const platform = process.platform;
    const filePath = path.join(request.user.directories.root, MCP_SETTINGS_FILE);

    let command;
    switch (platform) {
      case 'darwin': // macOS
        command = `open -R "${filePath}"`;
        break;
      case 'win32': // Windows
        command = `explorer /select,"${filePath}"`;
        break;
      default: // Linux and others
        command = `xdg-open "${filePath.replace(/[^/]*$/, '')}"`;
        break;
    }

    exec(command, (_error: Error | null) => {
      response.send({});
    });
  });
}

interface PluginInfo {
  id: string;
  name: string;
  description: string;
}

export default {
  init,
  exit: (): void => {},
  info: {
    id: ID,
    name: 'MCP Server',
    description: 'Allows you to connect to an MCP server and execute tools',
  } as PluginInfo,
};
