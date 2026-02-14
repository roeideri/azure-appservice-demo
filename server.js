const express = require("express");
const http = require("http");
const path = require("path");
const fs = require("fs");
const { Server } = require("socket.io");
const crypto = require("crypto");
const { TableClient } = require("@azure/data-tables");

const app = express();
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 10 * 1024 * 1024 }); // 10MB

const port = process.env.PORT || 3000;

// ---------- uploads (demo) ----------
const uploadsDir = path.join(__dirname, "uploads");
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir);
app.use("/uploads", express.static(uploadsDir));
app.use(express.static(path.join(__dirname, "public")));

app.get("/health", (req, res) => {
  res.json({ status: "ok", time: new Date().toISOString() });
});

// ---------- Table Storage (24h history) ----------
const conn = process.env.AZURE_STORAGE_CONNECTION_STRING;
const tableName = process.env.CHAT_TABLE_NAME || "chatmessages";

let table = null;
if (conn) {
  table = TableClient.fromConnectionString(conn, tableName);
} else {
  console.log("WARNING: AZURE_STORAGE_CONNECTION_STRING not set. History will NOT persist.");
}

const PARTITION = "global";
const HISTORY_HOURS = 24;
const MAX_HISTORY_SEND = 200; // don’t spam users on connect

function isoNow() {
  return new Date().toISOString();
}

function makeRowKey(isoTime) {
  // RowKey must be string. Use time + random suffix to avoid collisions.
  return `${isoTime}_${crypto.randomBytes(6).toString("hex")}`;
}

async function saveEventToTable(evt) {
  if (!table) return;
  const time = evt.time || isoNow();
  const entity = {
    partitionKey: PARTITION,
    rowKey: makeRowKey(time),
    time,
    kind: evt.kind, // "text" or "file"
    name: evt.name || "",
    text: evt.text || "",
    fileName: evt.fileName || "",
    mimeType: evt.mimeType || "",
    url: evt.url || ""
  };
  await table.createEntity(entity);
}

async function loadLast24h() {
  if (!table) return [];
  const since = new Date(Date.now() - HISTORY_HOURS * 60 * 60 * 1000).toISOString();

  // Query only our partition and only last 24h. We store time as ISO so string compare works.
  const filter = `PartitionKey eq '${PARTITION}' and time ge '${since}'`;

  const items = [];
  for await (const e of table.listEntities({ queryOptions: { filter } })) {
    items.push(e);
    if (items.length >= 500) break; // hard safety cap
  }

  // Sort by time
  items.sort((a, b) => String(a.time).localeCompare(String(b.time)));

  // Keep last MAX_HISTORY_SEND
  return items.slice(-MAX_HISTORY_SEND).map(e => ({
    kind: e.kind,
    name: e.name,
    time: e.time,
    text: e.text,
    fileName: e.fileName,
    mimeType: e.mimeType,
    url: e.url
  }));
}

async function cleanupOlderThan24h() {
  if (!table) return;
  const cutoff = new Date(Date.now() - HISTORY_HOURS * 60 * 60 * 1000).toISOString();
  const filter = `PartitionKey eq '${PARTITION}' and time lt '${cutoff}'`;

  let deleted = 0;
  for await (const e of table.listEntities({ queryOptions: { filter } })) {
    try {
      await table.deleteEntity(e.partitionKey, e.rowKey);
      deleted++;
      if (deleted >= 500) break; // avoid long loops
    } catch {}
  }
  if (deleted > 0) console.log(`Cleanup deleted ${deleted} old messages`);
}

// cleanup every 10 minutes
setInterval(() => cleanupOlderThan24h().catch(() => {}), 10 * 60 * 1000);

// ---------- realtime ----------
io.on("connection", async (socket) => {
  // Send history on connect
  try {
    const history = await loadLast24h();
    socket.emit("chat:history", history);
  } catch (e) {
    console.log("History load failed:", e?.message || e);
  }

  socket.on("chat:message", async (msg) => {
    const payload = { kind: "text", name: msg.name, text: msg.text, time: msg.time || isoNow() };
    io.emit("chat:message", payload);
    saveEventToTable(payload).catch(() => {});
  });

  socket.on("chat:file", async (payload, ack) => {
    try {
      const { name, time, fileName, mimeType, data } = payload;

      const safeName = String(fileName || "file").replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120);
      const ext = path.extname(safeName) || "";
      const base = path.basename(safeName, ext);
      const unique = `${Date.now()}_${Math.random().toString(16).slice(2)}`;
      const savedFile = `${base}_${unique}${ext}`;
      const fullPath = path.join(uploadsDir, savedFile);

      fs.writeFileSync(fullPath, Buffer.from(data));
      const url = `/uploads/${savedFile}`;

      const evt = {
        kind: "file",
        name,
        time: time || isoNow(),
        fileName: safeName,
        mimeType: mimeType || "application/octet-stream",
        url
      };

      io.emit("chat:file", evt);
      saveEventToTable(evt).catch(() => {});

      ack && ack({ ok: true, url });
    } catch {
      ack && ack({ ok: false, error: "Upload failed" });
    }
  });
});

server.listen(port, () => console.log(`Server running on port ${port}`));
