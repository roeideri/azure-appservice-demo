const express = require("express");
const http = require("http");
const path = require("path");
const fs = require("fs");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  maxHttpBufferSize: 10 * 1024 * 1024 // 10 MB per message/file
});

const port = process.env.PORT || 3000;

const uploadsDir = path.join(__dirname, "uploads");
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir);

app.use("/uploads", express.static(uploadsDir));
app.use(express.static(path.join(__dirname, "public")));

app.get("/health", (req, res) => {
  res.json({ status: "ok", time: new Date().toISOString() });
});

// Socket.IO realtime
io.on("connection", (socket) => {
  socket.on("chat:message", (msg) => {
    // msg: { name, text, time }
    io.emit("chat:message", msg);
  });

  // File upload (client sends file as Buffer)
  // based on Socket.IO file upload approach :contentReference[oaicite:4]{index=4}
  socket.on("chat:file", async (payload, ack) => {
    try {
      const { name, time, fileName, mimeType, data } = payload;

      // basic sanitization
      const safeName = String(fileName || "file")
        .replace(/[^a-zA-Z0-9._-]/g, "_")
        .slice(0, 120);

      const ext = path.extname(safeName) || "";
      const base = path.basename(safeName, ext);

      const unique = `${Date.now()}_${Math.random().toString(16).slice(2)}`;
      const savedFile = `${base}_${unique}${ext}`;

      const fullPath = path.join(uploadsDir, savedFile);

      // data is expected to be a Buffer (socket.io will deliver it as Buffer)
      fs.writeFileSync(fullPath, Buffer.from(data));

      const url = `/uploads/${savedFile}`;

      const message = {
        name,
        time,
        type: "file",
        fileName: safeName,
        mimeType: mimeType || "application/octet-stream",
        url
      };

      io.emit("chat:file", message);
      ack && ack({ ok: true, url });
    } catch (e) {
      ack && ack({ ok: false, error: "Upload failed" });
    }
  });
});

server.listen(port, () => {
  console.log(`Listening on ${port}`);
});
