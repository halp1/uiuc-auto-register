// Throwaway preview server for the UI without the backend. Open http://localhost:3999/?mock=1
import index from "../index.html";

const server = Bun.serve({
  port: Number(process.env.MOCK_PORT ?? 3999),
  development: true,
  routes: {
    "/": index,
    "/search": index,
    "/course/*": index,
    "/activity": index,
    "/settings": index,
  },
  fetch() {
    return new Response("Not found", { status: 404 });
  },
});

console.log(`Mock UI at ${server.url}?mock=1`);
