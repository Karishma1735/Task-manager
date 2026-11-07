// Local stand-in for viaSocket flow webhooks. Used only by the e2e run; never talks to the internet.
import http from "node:http";

const PORT = Number(process.env.MOCK_PORT ?? 3101);
const TOKEN = process.env.MOCK_EXPECTED_TOKEN ?? "";
const received = [];
let failing = false;

const server = http.createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const send = (code, body) => {
      res.writeHead(code, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    const url = new URL(req.url, `http://localhost:${PORT}`);
    if (url.pathname === "/__log") return send(200, received);
    if (url.pathname === "/__mode" && req.method === "POST") {
      failing = JSON.parse(Buffer.concat(chunks).toString() || "{}").fail === true;
      return send(200, { failing });
    }
    if (url.pathname === "/__ready") return send(200, { ok: true });
    const m = /^\/hook\/(\w+)$/.exec(url.pathname);
    if (m && req.method === "POST") {
      let body = {};
      try { body = JSON.parse(Buffer.concat(chunks).toString()); } catch { /* ignore */ }
      const tokenOk = body.token === TOKEN;
      const { token, ...rest } = body; // never keep the token
      void token;
      received.push({ hook: m[1], tokenOk, failed: failing, body: rest });
      return failing || !tokenOk ? send(failing ? 500 : 401, { ok: false }) : send(200, { ok: true });
    }
    send(404, { error: "not found" });
  });
});
server.listen(PORT, () => console.log(`mock webhook on ${PORT}`));
