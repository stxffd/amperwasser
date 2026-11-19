// Minimaler statischer Server für die lokale Vorschau: node scripts/serve.mjs [port]
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { SITE_DIR } from "./config.mjs";

const port = +(process.argv[2] || 8080);
const types = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml" };
http
  .createServer((req, res) => {
    const url = decodeURIComponent(req.url.split("?")[0]);
    let file = path.normalize(path.join(SITE_DIR, url.endsWith("/") ? url + "index.html" : url));
    if (!file.startsWith(SITE_DIR) || !fs.existsSync(file)) { res.writeHead(404); return res.end("404"); }
    res.writeHead(200, { "Content-Type": types[path.extname(file)] || "application/octet-stream", "Cache-Control": "no-cache" });
    fs.createReadStream(file).pipe(res);
  })
  .listen(port, () => console.log(`http://localhost:${port}/`));
