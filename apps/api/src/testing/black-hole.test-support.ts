import { once } from "node:events";
import { type Socket, createServer } from "node:net";

/**
 * A TCP server that accepts connections and never replies: a database that is
 * "up" at the network level but does not answer. `close()` destroys every
 * accepted socket.
 */
export interface BlackHole {
  readonly port: number;
  /** Connections accepted so far (each one a client stuck connecting). */
  accepted(): number;
  close(): Promise<void>;
}

export async function startBlackHole(): Promise<BlackHole> {
  const sockets = new Set<Socket>();
  let accepted = 0;
  const server = createServer((socket) => {
    accepted += 1;
    sockets.add(socket);
    socket.on("error", () => undefined);
    socket.on("close", () => sockets.delete(socket));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("black hole has no port");
  }
  return {
    port: address.port,
    accepted: () => accepted,
    async close() {
      for (const socket of sockets) {
        socket.destroy();
      }
      server.close();
      await once(server, "close");
    },
  };
}
