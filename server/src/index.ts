#!/usr/bin/env node

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { Node } from './node.js';
import { Election } from './election.js';
import { registerTools } from './tools.js';
import { registerAdvancedTools } from './advanced-tools.js';
import { VERSION } from './version.js';

const DEFAULT_PORT = 29194;

function configuredPort(): number {
  const raw = process.env.FIGMOON_CONNECT_PORT;
  const port = raw === undefined ? DEFAULT_PORT : Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65_535)
    throw new Error('FIGMOON_CONNECT_PORT must be an integer from 1 to 65535.');
  return port;
}

async function main(): Promise<void> {
  process.on('unhandledRejection', (reason) => {
    console.error('Unhandled rejection:', reason);
  });

  const port = configuredPort();
  const node = new Node(port);
  const election = new Election(port, node);
  await election.start();

  // Graceful shutdown
  const shutdown = () => {
    console.error('Shutting down...');
    election.stop();
    node.stop();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  process.on('uncaughtException', (err) => {
    console.error('Uncaught exception:', err);
    shutdown();
  });

  // Create MCP server (stdio transport)
  const server = new McpServer({
    name: 'figmoon',
    version: VERSION,
  });

  registerTools(server, node, port);
  registerAdvancedTools(server, node);

  console.error(`Starting MCP server (role: ${node.roleName})`);

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
