/**
 * Minimal MCP stdio client, for driving the server the way a real client does.
 *
 * Every call goes over the actual JSON-RPC wire rather than through an internal
 * import, so this exercises the transport, the schema validation and the tool
 * registration -- not just the handler functions.
 *
 * Usage:
 *   import { McpClient } from './mcp-client.mjs';
 *   const c = await McpClient.start();
 *   const res = await c.call('list_courses', {});
 *   await c.stop();
 */

import { spawn } from 'node:child_process';

export class McpClient {
  constructor(child) {
    this.child = child;
    this.nextId = 1;
    this.pending = new Map();
    this.buffer = '';
    this.stdoutViolations = [];

    child.stdout.on('data', (data) => {
      this.buffer += data.toString();
      let index;
      while ((index = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, index).trim();
        this.buffer = this.buffer.slice(index + 1);
        if (!line) continue;
        let message;
        try {
          message = JSON.parse(line);
        } catch {
          // stdout is the protocol channel; anything unparseable here is a bug.
          this.stdoutViolations.push(line.slice(0, 200));
          continue;
        }
        const resolver = this.pending.get(message.id);
        if (resolver) {
          this.pending.delete(message.id);
          resolver(message);
        }
      }
    });
  }

  static async start(cwd = process.cwd()) {
    const child = spawn('npx', ['tsx', 'src/mcp/server.ts'], {
      cwd,
      shell: process.platform === 'win32',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    child.stderr.on('data', () => {});

    const client = new McpClient(child);
    const init = await client.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'test-client', version: '1.0.0' },
    });
    client.notify('notifications/initialized');
    client.serverInfo = init.result?.serverInfo;
    client.instructions = init.result?.instructions ?? '';
    return client;
  }

  request(method, params) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timed out waiting for ${method}`));
      }, 300_000);
      this.pending.set(id, (message) => {
        clearTimeout(timer);
        resolve(message);
      });
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  }

  notify(method, params) {
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
  }

  async listTools() {
    const res = await this.request('tools/list', {});
    return res.result?.tools ?? [];
  }

  /** Calls a tool and returns its parsed JSON payload plus an isError flag. */
  async call(name, args = {}) {
    const res = await this.request('tools/call', { name, arguments: args });
    if (res.error) return { __isError: true, message: res.error.message, __protocolError: true };
    const text = res.result?.content?.[0]?.text ?? '{}';
    let payload;
    try {
      payload = JSON.parse(text);
    } catch {
      payload = { raw: text };
    }
    return { ...payload, __isError: res.result?.isError ?? false };
  }

  async stop() {
    this.child.kill();
  }
}
