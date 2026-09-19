/**
 * A minimal PostgreSQL front end for connection tests: it answers
 * SSLRequest (with TLS when given a certificate, otherwise "N"), asks for a
 * cleartext password as RDS Proxy does for IAM tokens, records the password,
 * and then refuses the login so every connection ends there.
 *
 * Also generates throwaway self-signed certificates with the `openssl`
 * binary, so no private key is committed.
 *
 * @module
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { type AddressInfo, type Socket, createServer } from "node:net";
import { join } from "node:path";
import { TLSSocket } from "node:tls";

const SSL_REQUEST_CODE = 80_877_103;

function errorResponse(message: string): Buffer {
  const fields = Buffer.from(`SFATAL\0C28P01\0M${message}\0\0`, "utf8");
  const header = Buffer.alloc(5);
  header.write("E", 0);
  header.writeInt32BE(fields.length + 4, 1);
  return Buffer.concat([header, fields]);
}

type Message = { readonly type: "ssl" | "startup" } | { readonly type: string; body: Buffer };

/** Reads frontend messages; until startup, messages have no type byte. */
function onMessages(socket: Socket | TLSSocket, handle: (message: Message) => void) {
  let buffer = Buffer.alloc(0);
  let startup = true;
  socket.on("data", (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);
    for (;;) {
      const offset = startup ? 0 : 1;
      if (buffer.length < offset + 4) {
        return;
      }
      const length = buffer.readInt32BE(offset);
      if (buffer.length < offset + length) {
        return;
      }
      const body = buffer.subarray(offset + 4, offset + length);
      const type = startup ? "startup" : buffer.toString("utf8", 0, 1);
      buffer = buffer.subarray(offset + length);
      if (startup && body.length === 4 && body.readInt32BE(0) === SSL_REQUEST_CODE) {
        handle({ type: "ssl" });
        continue;
      }
      startup = false;
      handle({ type, body });
    }
  });
}

export interface FakePostgres {
  readonly port: number;
  /** Connections accepted. */
  readonly connections: number;
  /** SSLRequest messages received. */
  readonly sslRequests: number;
  /** TLS handshakes completed. */
  readonly tlsSessions: number;
  /** Passwords received, one per connection that got that far. */
  readonly passwords: readonly string[];
  close(): Promise<void>;
}

export async function startFakePostgres(
  options: { readonly tls?: { readonly key: string; readonly cert: string } } = {},
): Promise<FakePostgres> {
  const passwords: string[] = [];
  const sockets = new Set<Socket>();
  let connections = 0;
  let sslRequests = 0;
  let tlsSessions = 0;

  const authenticate = (socket: Socket | TLSSocket) => (message: Message) => {
    if (message.type === "startup") {
      socket.write(Buffer.from([0x52, 0, 0, 0, 8, 0, 0, 0, 3])); // R: cleartext password
    } else if (message.type === "p" && "body" in message) {
      passwords.push(message.body.toString("utf8").replace(/\0$/, ""));
      socket.end(errorResponse("recorded"));
    }
  };

  const server = createServer((socket) => {
    connections += 1;
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => undefined);
    const plain = authenticate(socket);
    onMessages(socket, (message) => {
      if (message.type !== "ssl") {
        plain(message);
      } else if (options.tls === undefined) {
        sslRequests += 1;
        socket.write("N");
      } else {
        sslRequests += 1;
        socket.removeAllListeners("data");
        socket.write("S");
        const secure = new TLSSocket(socket, { isServer: true, ...options.tls });
        secure.on("error", () => undefined);
        secure.on("secure", () => {
          tlsSessions += 1;
        });
        onMessages(secure, authenticate(secure));
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    port: (server.address() as AddressInfo).port,
    get connections() {
      return connections;
    },
    get sslRequests() {
      return sslRequests;
    },
    get tlsSessions() {
      return tlsSessions;
    },
    passwords,
    close: () =>
      new Promise((resolve) => {
        for (const socket of sockets) {
          socket.destroy();
        }
        server.close(() => resolve());
      }),
  };
}

export interface TestCertificate {
  readonly key: string;
  readonly cert: string;
  readonly certPath: string;
}

/**
 * A self-signed certificate (also usable as its own CA) for `subjectAltName`,
 * for example `DNS:localhost`, valid for one day.
 */
export function createTestCertificate(
  directory: string,
  name: string,
  subjectAltName: string,
): TestCertificate {
  const keyPath = join(directory, `${name}.key.pem`);
  const certPath = join(directory, `${name}.cert.pem`);
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "ec",
      "-pkeyopt",
      "ec_paramgen_curve:prime256v1",
      "-nodes",
      "-days",
      "1",
      "-subj",
      `/CN=${name}`,
      "-addext",
      `subjectAltName=${subjectAltName}`,
      "-keyout",
      keyPath,
      "-out",
      certPath,
    ],
    { stdio: "ignore" },
  );
  return { key: readFileSync(keyPath, "utf8"), cert: readFileSync(certPath, "utf8"), certPath };
}
