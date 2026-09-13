import http from "node:http";

const PORT = parseInt(process.env.PORT || "3000", 10);
const HOST = process.env.HOST || "127.0.0.1";

const server = http.createServer((req, res) => {
  if (req.url === "/health" || req.url === "/") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        status: "ok",
        role: "Outside_Orchestrator",
        tier: "Tier 1 Edge/Control Plane",
        version: "0.1.0",
        node: process.env.HOSTNAME || "srv719637",
        timestamp: new Date().toISOString()
      })
    );
    return;
  }

  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "not_found" }));
});

server.listen(PORT, HOST, () => {
  console.log(`Outside Orchestrator listening on http://${HOST}:${PORT}`);
});
