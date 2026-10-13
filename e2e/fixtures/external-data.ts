import { createServer, type IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';
export async function startExternalData() {
  const requests: { host: string; path: string; headers: IncomingHttpHeaders }[] = [];
  let values = [2, 4, 8];
  const server = createServer((request, response) => {
    requests.push({ host: request.headers.host ?? '', path: request.url ?? '', headers: { ...request.headers } });
    response.setHeader('Access-Control-Allow-Origin', 'null');
    response.setHeader('Cache-Control', 'no-store');
    if (request.url === '/redirect') {
      response.writeHead(302, { Location: `http://blocked.lab-test.invalid:${(server.address() as AddressInfo).port}/observations.json` });
      response.end();
    } else if (request.url === '/observations.json') {
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify({ values }));
    } else if (request.url === '/module.js' || request.url === '/worker.js') {
      response.setHeader('Content-Type', 'text/javascript');
      response.end('globalThis.externalCodeExecuted = true;');
    } else { response.writeHead(404); response.end(); }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    allowed: `http://data.lab-test.invalid:${port}`,
    blocked: `http://blocked.lab-test.invalid:${port}`,
    requests,
    setValues(next: number[]) { values = [...next]; },
    close: () => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())),
  };
}
