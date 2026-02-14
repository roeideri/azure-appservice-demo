const express = require("express");
const app = express();

const port = process.env.PORT || 3000;

// Basic route
app.get("/", (req, res) => {
  res.send("✅ Hello from Azure App Service!");
});

// Health endpoint (useful for monitoring)
app.get("/health", (req, res) => {
  res.json({ status: "ok", time: new Date().toISOString() });
});

// Route to intentionally throw an error (for testing App Insights + alerts)
app.get("/crash", (req, res) => {
  throw new Error("Intentional crash test");
});

app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});
