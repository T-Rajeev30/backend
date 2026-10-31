declare module 'ws' {
  export class WebSocket {
    static OPEN: number;
    readyState: number;
    send(data: string | Buffer): void;
    close(code?: number, reason?: string): void;
    on(event: string, listener: (...args: any[]) => void): this;
  }
  export class WebSocketServer {
    constructor(options: Record<string, unknown>);
    handleUpgrade(request: unknown, socket: unknown, head: Buffer, callback: (client: WebSocket) => void): void;
  }
}
