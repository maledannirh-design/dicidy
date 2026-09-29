import http from "node:http";
import fs from "node:fs";
import path from "node:path";

const PORT = Number(process.env.DICIDY_BRIDGE_PORT || 8787);
const ROOT = path.resolve(process.cwd());
const RESULT_FILE = path.join(ROOT, "bridge-diagnostic.json");

function send(res, status, body) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*"
  });
  res.end(JSON.stringify(body, null, 2));
}

const server = http.createServer((req, res) => {
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS"
    });
    return res.end();
  }

  if (req.method === "GET" && req.url === "/api/health") {
    return send(res, 200, {
      ok: true,
      service: "DICIDY Flow Automation Bridge",
      port: PORT
    });
  }

  if (req.method === "POST" && req.url === "/api/diagnostic") {
    let raw = "";

    req.on("data", chunk => {
      raw += chunk;
      if (raw.length > 1_000_000) req.destroy();
    });

    req.on("end", () => {
      try {
        const result = JSON.parse(raw || "{}");
        fs.writeFileSync(RESULT_FILE, JSON.stringify(result, null, 2), "utf8");
        console.log("\n[DICIDY BRIDGE] Diagnostic received.");
        console.log(JSON.stringify(result, null, 2));
        send(res, 200, { ok: true });
      } catch (error) {
        send(res, 400, { ok: false, error: error.message });
      }
    });

    return;
  }

  send(res, 404, { ok: false, error: "Not found" });
});

server.listen(PORT, "127.0.0.1", () => {
  console.log("[DICIDY BRIDGE] Local server running.");
  console.log(`[DICIDY BRIDGE] http://127.0.0.1:${PORT}`);
  console.log("[DICIDY BRIDGE] Start this server before pressing TEST EXISTING CHROME.");
  console.log("[DICIDY BRIDGE] The first phase is diagnostic only; it will not type prompts or generate videos.");
});
