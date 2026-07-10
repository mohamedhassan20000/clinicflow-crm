import { createServer } from "node:http";

const port = Number(process.env.RATE_LIMIT_MOCK_PORT ?? 3011);
const server = createServer((request, response) => {
  response.setHeader("content-type", "application/json");
  if (request.url === "/health") {
    response.end(JSON.stringify({ ok: true }));
    return;
  }
  response.end(JSON.stringify({ result: [1, 1, Date.now()] }));
});

server.listen(port, "127.0.0.1");

function close() {
  server.close(() => process.exit(0));
}
process.on("SIGTERM", close);
process.on("SIGINT", close);

