/**
 * Demo gRPC server with reflection, for trying out the client.
 *
 *   npm run demo-server              # listens on localhost:50051
 *   PORT=6000 HTTP_PORT=9000 npm run demo-server
 *
 * Also starts the demo REST server (http-server.ts) on localhost:8089.
 *
 * Inventory methods require `authorization: Bearer demo-token`.
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import { ReflectionService } from '@grpc/reflection';
import { startDemoHttpServer } from './http-server.js';

const protoDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'protos');
const definition = protoLoader.loadSync([join(protoDir, 'greeter.proto'), join(protoDir, 'inventory.proto')], {
  keepCase: true,
  longs: String,
  enums: String,
  defaults: true,
  oneofs: true,
  includeDirs: [protoDir],
});
const loaded = grpc.loadPackageDefinition(definition) as any;

const GREETINGS: Record<string, string> = {
  LANGUAGE_UNSPECIFIED: 'Hello',
  LANGUAGE_ENGLISH: 'Hello',
  LANGUAGE_SPANISH: 'Hola',
  LANGUAGE_FRENCH: 'Bonjour',
};

const now = () => {
  const ms = Date.now();
  return { seconds: String(Math.floor(ms / 1000)), nanos: (ms % 1000) * 1e6 };
};

const greet = (req: { name?: string; language?: string }) => ({
  message: `${GREETINGS[req.language ?? 'LANGUAGE_UNSPECIFIED'] ?? 'Hello'}, ${req.name || 'stranger'}!`,
  sent_at: now(),
});

const greeter = {
  SayHello(call: grpc.ServerUnaryCall<any, any>, cb: grpc.sendUnaryData<any>) {
    call.sendMetadata(new grpc.Metadata({}));
    const trailer = new grpc.Metadata();
    trailer.set('x-served-by', 'demo-server');
    cb(null, greet(call.request), trailer);
  },
  StreamGreetings(call: grpc.ServerWritableStream<any, any>) {
    const times = Math.min(Math.max(call.request.times || 3, 1), 20);
    let i = 0;
    const timer = setInterval(() => {
      if (call.cancelled) return clearInterval(timer);
      i++;
      call.write({ ...greet(call.request), message: `${greet(call.request).message} (${i}/${times})` });
      if (i >= times) {
        clearInterval(timer);
        call.end();
      }
    }, 300);
  },
  CollectNames(call: grpc.ServerReadableStream<any, any>, cb: grpc.sendUnaryData<any>) {
    const names: string[] = [];
    call.on('data', (req) => names.push(req.name));
    call.on('end', () => cb(null, { message: `Hello, ${names.join(' & ') || 'nobody'}!`, sent_at: now() }));
  },
  Chat(call: grpc.ServerDuplexStream<any, any>) {
    call.on('data', (req) => call.write(greet(req)));
    call.on('end', () => call.end());
  },
};

const items = new Map<string, any>([
  [
    'SKU-001',
    {
      sku: 'SKU-001',
      title: 'Mechanical keyboard',
      quantity: '42',
      price: { currency_code: 'USD', units: '129', nanos: 990000000 },
      tags: ['peripherals', 'keyboards'],
      attributes: { switch: 'brown', layout: 'ANSI' },
      status: 'STATUS_IN_STOCK',
      warehouse: 'WH-EAST-1',
      updated_at: now(),
    },
  ],
  [
    'SKU-002',
    {
      sku: 'SKU-002',
      title: 'USB-C hub',
      quantity: '0',
      price: { currency_code: 'USD', units: '49', nanos: 0 },
      tags: ['peripherals'],
      attributes: { ports: '7' },
      status: 'STATUS_BACKORDERED',
      store_address: { line1: '1 Example Way', city: 'Springfield', country: 'US' },
      updated_at: now(),
    },
  ],
]);

function authorized(call: grpc.ServerSurfaceCall): boolean {
  return call.metadata.get('authorization')[0] === 'Bearer demo-token';
}

const denied = { code: grpc.status.UNAUTHENTICATED, details: 'missing or invalid bearer token (expected "demo-token")' };

const inventory = {
  GetItem(call: grpc.ServerUnaryCall<any, any>, cb: grpc.sendUnaryData<any>) {
    if (!authorized(call)) return cb(denied);
    const item = items.get(call.request.sku);
    if (!item) return cb({ code: grpc.status.NOT_FOUND, details: `item ${call.request.sku} not found` });
    cb(null, item);
  },
  ListItems(call: grpc.ServerUnaryCall<any, any>, cb: grpc.sendUnaryData<any>) {
    if (!authorized(call)) return cb(denied);
    const statuses: string[] = call.request.statuses ?? [];
    const all = [...items.values()].filter((i) => !statuses.length || statuses.includes(i.status));
    cb(null, { items: all.slice(0, call.request.page_size || 50), next_page_token: '' });
  },
  UpdateItem(call: grpc.ServerUnaryCall<any, any>, cb: grpc.sendUnaryData<any>) {
    if (!authorized(call)) return cb(denied);
    const patch = call.request.item ?? {};
    const existing = items.get(patch.sku);
    if (!existing) return cb({ code: grpc.status.NOT_FOUND, details: `item ${patch.sku} not found` });
    const paths: string[] = call.request.update_mask?.paths?.length ? call.request.update_mask.paths : Object.keys(patch);
    for (const p of paths) if (p in patch) existing[p] = patch[p];
    existing.updated_at = now();
    cb(null, existing);
  },
};

/** Starts the demo server; resolves with the bound port. */
export function startDemoServer(port = 0, credentials = grpc.ServerCredentials.createInsecure()): Promise<{ server: grpc.Server; port: number }> {
  const server = new grpc.Server();
  server.addService(loaded.demo.greeter.v1.Greeter.service, greeter);
  server.addService(loaded.demo.inventory.v1.Inventory.service, inventory);
  new ReflectionService(definition).addToServer(server);
  return new Promise((resolve, reject) =>
    server.bindAsync(`0.0.0.0:${port}`, credentials, (err, bound) => (err ? reject(err) : resolve({ server, port: bound }))),
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  Promise.all([startDemoServer(Number(process.env.PORT ?? 50051)), startDemoHttpServer(Number(process.env.HTTP_PORT ?? 8089))])
    .then(([grpcServer, httpServer]) => {
      console.error(`demo gRPC server listening on localhost:${grpcServer.port} (reflection enabled)`);
      console.error(`demo HTTP server listening on http://localhost:${httpServer.port}`);
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
