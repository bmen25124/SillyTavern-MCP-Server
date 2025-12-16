import { Validator } from 'jsonschema';
import child_process from 'node:child_process';
import fetch from 'node-fetch';
import { EventSource } from 'eventsource';

const JSONRPC_VERSION = '2.0';
const PROTOCOL_VERSION = '2025-06-18';

export enum ErrorCode {
  // SDK error codes
  ConnectionClosed = -32000,
  RequestTimeout = -32001,
  UnsupportedProtocolVersion = -32002,

  // Standard JSON-RPC error codes
  ParseError = -32700,
  InvalidRequest = -32600,
  MethodNotFound = -32601,
  InvalidParams = -32602,
  InternalError = -32603,
}

export type RequestId = string | number;
export type ProgressToken = string | number;

export interface ClientCapabilities {
  experimental?: Record<string, any>;
  sampling?: object;
  roots?: {
    listChanged?: boolean;
  };
  tools?: {
    listChanged?: boolean;
  };
}

export interface ServerCapabilities {
  experimental?: Record<string, any>;
  logging?: object;
  prompts?: {
    listChanged?: boolean;
  };
  resources?: {
    subscribe?: boolean;
    listChanged?: boolean;
  };
  tools?: {
    listChanged?: boolean;
  };
}

export interface Implementation {
  name: string;
  version: string;
}

export interface RequestMetadata {
  progressToken?: ProgressToken;
  [key: string]: unknown;
}

export interface McpRequest {
  jsonrpc: typeof JSONRPC_VERSION;
  id: RequestId;
  method: string;
  params?: {
    _meta?: RequestMetadata;
    [key: string]: unknown;
  };
}

export interface McpResponse {
  jsonrpc: typeof JSONRPC_VERSION;
  id: RequestId;
  result?: {
    _meta?: { [key: string]: unknown };
    [key: string]: unknown;
  };
  error?: {
    code: number;
    message: string;
    data?: any;
  };
}

export interface McpNotification {
  jsonrpc: typeof JSONRPC_VERSION;
  method: string;
  params?: {
    _meta?: { [key: string]: unknown };
    [key: string]: unknown;
  };
}

export interface McpClientConfig {
  // For stdio
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  // For HTTP/SSE
  url?: string;
  transport?: 'stdio' | 'streamableHttp' | 'sse';
  headers?: Record<string, string>;
}

export interface Annotated {
  annotations?: {
    audience?: ('user' | 'assistant')[];
    priority?: number;
  };
}

export class McpError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string,
    public readonly data?: unknown,
  ) {
    super(`MCP error ${code}: ${message}`);
    this.name = 'McpError';
  }
}

export class McpClient {
  private proc?: child_process.ChildProcess;
  private requestId: number = 0;
  private pendingRequests: Map<
    RequestId,
    {
      resolve: Function;
      reject: Function;
      method: string;
    }
  > = new Map();
  private isConnected: boolean = false;
  private capabilities?: ServerCapabilities;
  private initializePromise?: Promise<void>;
  private sessionId?: string;
  private negotiatedProtocolVersion: string = PROTOCOL_VERSION;
  private eventSource?: EventSource;
  private httpEndpoint?: string;
  private postEndpoint?: string;
  private transport: 'stdio' | 'streamableHttp' | 'sse' = 'stdio';

  constructor(
    private config: McpClientConfig,
    private clientInfo: Implementation = {
      name: 'sillytavern-client',
      version: '1.0.0',
    },
    private clientCapabilities: ClientCapabilities = {},
  ) {
    if (config.transport === 'streamableHttp' || config.transport === 'sse' || config.url) {
      if (config.transport) {
        this.transport = config.transport;
      } else if (config.url) {
        if (config.url?.includes('sse')) {
          this.transport = 'sse';
        } else {
          this.transport = 'streamableHttp';
        }
      }
      this.httpEndpoint = config.url;
    }
  }

  public async connect(): Promise<void> {
    if (this.isConnected) {
      return;
    }

    if (this.initializePromise) {
      return this.initializePromise;
    }

    if (this.transport === 'stdio') {
      this.initializePromise = new Promise((resolve, reject) => {
        const { command, args = [], env } = this.config;

        this.proc = child_process.spawn(command!, args, {
          env: { ...process.env, ...env },
          stdio: ['pipe', 'pipe', 'pipe'],
        });

        this.proc.stdout?.on('data', (data) => {
          const lines = data.toString().split('\n');
          for (const line of lines) {
            if (!line) continue;
            try {
              const message = JSON.parse(line);
              this.handleMessage(message);
            } catch (error) {
              const mcpError = new McpError(ErrorCode.ParseError, 'Failed to parse message');
              console.error('Failed to parse MCP message:', mcpError);
            }
          }
        });

        this.proc.stderr?.on('data', (data) => {
          // Log as info since these are usually initialization messages, not errors
          console.log(`[MCP Server] ${data}`);
        });

        this.proc.on('error', (error) => {
          this.isConnected = false;
          this.initializePromise = undefined;
          reject(new McpError(ErrorCode.ConnectionClosed, error.message));
        });

        this.proc.on('close', (code) => {
          this.isConnected = false;
          this.initializePromise = undefined;
        });

        this.proc.on('exit', (code, signal) => {
          this.isConnected = false;
          this.initializePromise = undefined;
          if (!this.proc?.killed) {
            reject(
              new McpError(
                ErrorCode.ConnectionClosed,
                `Process exited with code ${code}${signal ? ` and signal ${signal}` : ''}`,
              ),
            );
          }
        });

        setTimeout(async () => {
          try {
            if (!this.proc?.stdin) {
              throw new McpError(ErrorCode.ConnectionClosed, 'Failed to start MCP server process');
            }

            // Initialize connection
            const result = await this.sendRequest('initialize', {
              protocolVersion: PROTOCOL_VERSION,
              capabilities: this.clientCapabilities,
              clientInfo: this.clientInfo,
            });

            // Verify protocol version compatibility
            if (!this.isProtocolVersionSupported(result.protocolVersion)) {
              throw new McpError(
                ErrorCode.UnsupportedProtocolVersion,
                `Server protocol version ${result.protocolVersion} is not supported`,
              );
            }

            this.capabilities = result.capabilities;
            this.isConnected = true;

            // Send initialized notification
            this.sendNotification('notifications/initialized');

            resolve();
          } catch (error) {
            reject(error);
          }
        }, 100); // Wait 100ms for process to start
      });

      return this.initializePromise;
    } else if (this.transport === 'sse') {
      this.initializePromise = new Promise(async (resolve, reject) => {
        try {
          if (!this.httpEndpoint) {
            reject(new McpError(ErrorCode.InvalidRequest, 'No SSE endpoint URL provided'));
            return;
          }
          const es = new EventSource(this.httpEndpoint);
          this.eventSource = es;
          es.onmessage = (event: MessageEvent) => {
            try {
              const msg = JSON.parse((event as any).data);
              this.handleMessage(msg);
            } catch (e) {
              console.error('Failed to parse SSE event:', e);
            }
          };
          es.addEventListener('endpoint', async (event: { data: string }) => {
            try {
              const httpUrl = new URL(this.httpEndpoint!);
              const baseUrl = httpUrl.origin + httpUrl.pathname;

              const newUrl = new URL(event.data, baseUrl); // /messages?sessionId=123
              const sessionId = newUrl.searchParams.get('sessionId');
              if (sessionId) {
                this.sessionId = sessionId;
                const newUrlWithoutSessionId = new URL(event.data, baseUrl);
                newUrlWithoutSessionId.searchParams.delete('sessionId');
                this.postEndpoint = newUrlWithoutSessionId.href;

                this.isConnected = true;
                this.negotiatedProtocolVersion = PROTOCOL_VERSION; // For SSE, we assume the server supports the latest version
                await this.sendNotification('notifications/initialized');
                resolve();
              } else {
                reject(new McpError(ErrorCode.InvalidRequest, 'No sessionId found in endpoint event data'));
              }
            } catch (e) {
              reject(new McpError(ErrorCode.ParseError, 'Failed to parse endpoint event data'));
            }
          });
          es.onerror = (err: any) => {
            console.error('SSE connection error:', err);
          };
        } catch (err) {
          reject(err);
        }
      });
      return this.initializePromise;
    } else if (this.transport === 'streamableHttp') {
      this.initializePromise = new Promise(async (resolve, reject) => {
        try {
          // POST initialize
          const headers: any = {
            'Content-Type': 'application/json',
            Accept: 'application/json, text/event-stream',
            'MCP-Protocol-Version': PROTOCOL_VERSION,
            ...this.config.headers,
          };
          if (this.sessionId) {
            headers['Mcp-Session-Id'] = this.sessionId;
          }
          const res = await fetch(this.httpEndpoint!, {
            method: 'POST',
            headers,
            body: JSON.stringify({
              jsonrpc: JSONRPC_VERSION,
              id: ++this.requestId,
              method: 'initialize',
              params: {
                protocolVersion: PROTOCOL_VERSION,
                capabilities: this.clientCapabilities,
                clientInfo: this.clientInfo,
              },
            }),
          });
          if (!res.ok) {
            const errorText = await res.text();
            reject(new McpError(ErrorCode.ConnectionClosed, `HTTP error: ${res.status} - ${errorText}`));
            return;
          }
          // Get session id if present
          const sessionId = res.headers.get('mcp-session-id');
          if (sessionId) {
            this.sessionId = sessionId;
          }
          const restText = await res.text();
          let result: any;
          try {
            result = JSON.parse(restText);
          } catch (e) {
            // Try to parse as SSE event: event: message\ndata: {...}
            const match = restText.match(/data: (\{[\s\S]*\})/);
            if (match) {
              try {
                result = JSON.parse(match[1]);
              } catch (e2) {
                reject(new McpError(ErrorCode.ParseError, 'Failed to parse SSE data as JSON'));
                return;
              }
            } else {
              reject(new McpError(ErrorCode.ParseError, 'Failed to parse initialization response as JSON or SSE'));
              return;
            }
          }
          if (!this.isProtocolVersionSupported(result.result?.protocolVersion)) {
            reject(
              new McpError(
                ErrorCode.UnsupportedProtocolVersion,
                `Server protocol version ${result.result?.protocolVersion} is not supported`,
              ),
            );
            return;
          }
          this.capabilities = result.result?.capabilities;
          this.isConnected = true;
          this.negotiatedProtocolVersion = result.result?.protocolVersion || PROTOCOL_VERSION;
          // Send initialized notification
          await this.sendNotification('notifications/initialized');
          resolve();
        } catch (err) {
          reject(err);
        }
      });
      return this.initializePromise;
    }
  }

  private isProtocolVersionSupported(version: string): boolean {
    // For now, we only support exact match
    // In the future, we could implement semver comparison
    return true;
  }

  public async close(): Promise<void> {
    if (!this.isConnected) return;
    if (this.transport === 'stdio') {
      return new Promise((resolve) => {
        if (!this.proc) {
          resolve();
          return;
        }

        this.proc.on('close', () => {
          this.isConnected = false;
          this.initializePromise = undefined;
          resolve();
        });

        if (this.proc) {
          this.proc.kill();
        }
      });
    } else if (this.transport === 'streamableHttp' || this.transport === 'sse') {
      if (this.eventSource) {
        this.eventSource.close();
        this.eventSource = undefined;
      }
      this.isConnected = false;
      this.initializePromise = undefined;
    }
  }

  public async listTools(): Promise<any> {
    return this.sendRequest('tools/list', {});
  }

  public async callTool(params: { name: string; arguments: any }, schema: any): Promise<any> {
    new Validator().validate(params.arguments, schema, { throwError: true });
    return this.sendRequest('tools/call', params);
  }

  private async sendRequest(method: string, params: any, progressToken?: ProgressToken): Promise<any> {
    if (this.transport === 'stdio') {
      // For initialization requests, we don't want to check isConnected
      if (method !== 'initialize' && (!this.isConnected || !this.proc?.stdin)) {
        throw new McpError(ErrorCode.ConnectionClosed, 'MCP client is not connected');
      }

      return new Promise((resolve, reject) => {
        const id = ++this.requestId;
        const request: McpRequest = {
          jsonrpc: JSONRPC_VERSION,
          id,
          method,
          params: {
            ...params,
            _meta: progressToken ? { progressToken } : undefined,
          },
        };

        this.pendingRequests.set(id, { resolve, reject, method });

        if (!this.proc?.stdin) {
          throw new McpError(ErrorCode.ConnectionClosed, 'Process stdin is not available');
        }
        this.proc.stdin.write(JSON.stringify(request) + '\n');
      });
    } else if (this.transport === 'sse') {
      if (!this.isConnected) {
        throw new McpError(ErrorCode.ConnectionClosed, 'MCP client is not connected');
      }
      return new Promise(async (resolve, reject) => {
        const id = ++this.requestId;
        const request: McpRequest = {
          jsonrpc: JSONRPC_VERSION,
          id,
          method,
          params: {
            ...params,
            _meta: progressToken ? { progressToken } : undefined,
          },
        };
        this.pendingRequests.set(id, { resolve, reject, method });
        const headers: any = {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          'MCP-Protocol-Version': this.negotiatedProtocolVersion,
          ...this.config.headers,
        };
        // For sse transport, POST to postEndpoint (or httpEndpoint) with sessionId as query param
        let postUrl = this.postEndpoint || this.httpEndpoint;
        if (!postUrl) {
          reject(new McpError(ErrorCode.ConnectionClosed, 'No POST endpoint configured for SSE transport'));
          return;
        }
        const urlObj = new URL(postUrl);
        if (this.sessionId) {
          // Add sessionId as query param
          urlObj.searchParams.set('sessionId', this.sessionId);
        }
        try {
          const res = await fetch(urlObj.href, {
            method: 'POST',
            headers,
            body: JSON.stringify(request),
          });
          if (!res.ok) {
            const errorText = await res.text();
            reject(new McpError(ErrorCode.ConnectionClosed, `HTTP error: ${res.status} - ${errorText}`));
            return;
          }
        } catch (err) {
          reject(err);
        }
      });
    } else if (this.transport === 'streamableHttp') {
      if (!this.isConnected) {
        throw new McpError(ErrorCode.ConnectionClosed, 'MCP client is not connected');
      }
      return new Promise(async (resolve, reject) => {
        const id = ++this.requestId;
        const request: McpRequest = {
          jsonrpc: JSONRPC_VERSION,
          id,
          method,
          params: {
            ...params,
            _meta: progressToken ? { progressToken } : undefined,
          },
        };
        this.pendingRequests.set(id, { resolve, reject, method });
        const headers: any = {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          'MCP-Protocol-Version': this.negotiatedProtocolVersion,
          ...this.config.headers,
        };
        if (this.sessionId) {
          headers['Mcp-Session-Id'] = this.sessionId;
        }
        let res;
        try {
          res = await fetch(this.httpEndpoint!, {
            method: 'POST',
            headers,
            body: JSON.stringify(request),
          });
        } catch (err) {
          reject(new McpError(ErrorCode.ConnectionClosed, 'Network error: ' + (err as Error).message));
          return;
        }
        // Handle session expired (404) per spec
        if (res.status === 404 && this.sessionId) {
          // Session expired, clear and re-initialize
          this.sessionId = undefined;
          this.isConnected = false;
          this.initializePromise = undefined;
          try {
            await this.connect();
            // Retry the request after re-initialization
            resolve(await this.sendRequest(method, params, progressToken));
          } catch (e) {
            reject(new McpError(ErrorCode.ConnectionClosed, 'Session expired and re-initialization failed'));
          }
          return;
        }

        const contentType = res.headers.get('content-type') || '';
        if (contentType.includes('application/json')) {
          const result: any = await res.json();
          this.handleMessage(result);
        } else if (contentType.includes('text/event-stream')) {
          // Parse SSE stream directly from POST response body
          const body = res.body;
          if (!body || typeof body[Symbol.asyncIterator] !== 'function') {
            reject(new McpError(ErrorCode.ConnectionClosed, 'No stream available for SSE response'));
            return;
          }
          let buffer = '';
          for await (const chunk of body as AsyncIterable<Buffer | string>) {
            const text = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : chunk;
            buffer += text;
            let lines = buffer.split('\n');
            buffer = lines.pop() || '';
            for (const line of lines) {
              const trimmed = line.trim();
              if (trimmed.startsWith('data:')) {
                try {
                  const json = JSON.parse(trimmed.slice(5).trim());
                  this.handleMessage(json);
                } catch (e) {
                  console.error('Failed to parse SSE data:', e);
                }
              }
            }
          }
          resolve(undefined);
        } else {
          reject(new McpError(ErrorCode.ConnectionClosed, `Unexpected content-type: ${contentType}`));
        }
      });
    }
  }

  private async sendNotification(method: string, params?: any): Promise<void> {
    if (!this.isConnected) {
      throw new McpError(ErrorCode.ConnectionClosed, 'MCP client is not connected');
    }

    const notification: McpNotification = {
      jsonrpc: JSONRPC_VERSION,
      method,
      params: params
        ? {
            ...params,
            _meta: {},
          }
        : undefined,
    };

    if (this.transport === 'stdio') {
      if (!this.proc?.stdin) {
        throw new McpError(ErrorCode.ConnectionClosed, 'Process stdin is not available');
      }
      this.proc.stdin.write(JSON.stringify(notification) + '\n');
    } else if (this.transport === 'streamableHttp') {
      const headers: any = {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        'MCP-Protocol-Version': this.negotiatedProtocolVersion,
      };
      if (this.sessionId) {
        headers['Mcp-Session-Id'] = this.sessionId;
      }
      await fetch(this.httpEndpoint!, {
        method: 'POST',
        headers,
        body: JSON.stringify(notification),
      });
    }
  }

  private handleMessage(message: McpResponse | McpNotification): void {
    // Handle notifications
    if (!('id' in message)) {
      // We don't handle notifications currently
      console.debug('[MCP] Received notification:', message);
      return;
    }

    const pending = this.pendingRequests.get(message.id);
    if (!pending) {
      console.warn('Received response for unknown request:', message);
      return;
    }

    this.pendingRequests.delete(message.id);

    // Handle tool call responses specially
    if ('result' in message && pending.method === 'tools/call') {
      // For example, MemoryMesh wraps their response with `toolResults`.
      function findContentLevel(obj: any): any {
        if (obj?.content === undefined) {
          // Check if there is only one property
          if (Object.keys(obj).length === 1) {
            return findContentLevel(obj[Object.keys(obj)[0]]);
          }
          return obj;
        }
        return obj;
      }

      const result = findContentLevel(message.result);
      if (result?.isError) {
        pending.reject(new McpError(ErrorCode.InternalError, result.content?.[0]?.text || 'Tool call failed', result));
        return;
      }

      pending.resolve(result);
      return;
    }

    if ('error' in message && message.error) {
      pending.reject(new McpError(message.error.code, message.error.message, message.error.data));
    } else {
      pending.resolve(message.result);
    }
  }

  public getCapabilities(): ServerCapabilities | undefined {
    return this.capabilities;
  }
}
