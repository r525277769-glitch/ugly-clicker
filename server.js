const express = require("express");
const { Pool } = require("pg");

const app = express();
app.use(express.json());
app.use(express.static("public"));

const PORT = process.env.PORT || 3000;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL
    ? { rejectUnauthorized: false }
    : false
});

app.get("/", (req, res) => {
  res.send("UGLY CLICKER SERVER ONLINE");
});

app.get("/health", (req, res) => {
  res.json({ status: "online", game: "UGLY CLICKER" });
});

app.listen(PORT, () => {
  console.log(`UGLY CLICKER running on port ${PORT}`);
});
