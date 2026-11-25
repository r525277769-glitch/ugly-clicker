econstx express = require("express");
const crypto = require("crypto");
const { Pool } = require("pg");

const app = express();
app.use(express.json());
app.use(express.static("public"));

const PORT = process.env.PORT || 3000;
const BOT_TOKEN = process.env.BOT_TOKEN;
const DATABASE_URL = process.env.DATABASE_URL;

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: DATABASE_URL ? { rejectUnauthorized: false } : false
});

const catalog = {
  house: [
    { name: "Маленький дом", price: 100000 },
    { name: "Особняк", price: 1000000 },
    { name: "Роскошная вилла", price: 10000000 },
    { name: "Дворец", price: 50000000 }
  ],
  car: [
    { name: "Спортивный автомобиль", price: 50000 },
    { name: "Премиум автомобиль", price: 500000 },
    { name: "Суперкар", price: 5000000 },
    { name: "Гиперкар", price: 10000000 }
  ],
  watch: [
    { name: "Классические часы", price: 10000 },
    { name: "Золотые часы", price: 250000 },
    { name: "Люксовые часы", price: 5000000 }
  ],
  painting: [
    { name: "Картина", price: 5000 },
    { name: "Редкая картина", price: 250000 },
    { name: "Шедевр", price: 2000000 }
  ],
  yacht: [
    { name: "Малая яхта", price: 5000000 },
    { name: "Суперъяхта", price: 50000000 },
    { name: "Мегаъяхта", price: 100000000 }
  ],
  island: [
    { name: "Небольшой остров", price: 50000000 },
    { name: "Тропический остров", price: 250000000 },
    { name: "Частный архипелаг", price: 1000000000 }
  ]
};

async function initDatabase() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS players (
      telegram_id BIGINT PRIMARY KEY,
      username TEXT,
      balance BIGINT NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS inventory (
      id BIGSERIAL PRIMARY KEY,
      telegram_id BIGINT REFERENCES players(telegram_id),
      category TEXT NOT NULL,
      item_name TEXT NOT NULL,
      purchase_price BIGINT NOT NULL,
      purchased_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);
}

function authenticate(initData) {
  if (!BOT_TOKEN || !initData) {
    throw new Error("Telegram authentication is not configured");
  }

  const params = new URLSearchParams(initData);
  const hash = params.get("hash");

  if (!hash) throw new Error("Invalid Telegram data");

  params.delete("hash");

  const authDate = Number(params.get("auth_date"));
  if (!authDate || Date.now() / 1000 - authDate > 86400) {
    throw new Error("Telegram session expired");
  }

  const dataCheckString = [...params.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");

  const secretKey = crypto
    .createHmac("sha256", "WebAppData")
    .update(BOT_TOKEN)
    .digest();

  const calculatedHash = crypto
    .createHmac("sha256", secretKey)
    .update(dataCheckString)
    .digest("hex");

  const a = Buffer.from(hash, "hex");
  const b = Buffer.from(calculatedHash, "hex");

  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    throw new Error("Telegram authentication failed");
  }

  const user = JSON.parse(params.get("user") || "{}");

  if (!user.id) throw new Error("Player not found");

  return user;
}

async function authMiddleware(req, res, next) {
  try {
    const initData = req.headers["x-telegram-init-data"];
    req.player = authenticate(initData);

    await pool.query(
      `INSERT INTO players (telegram_id, username)
       VALUES ($1, $2)
       ON CONFLICT (telegram_id)
       DO UPDATE SET username = EXCLUDED.username`,
      [req.player.id, req.player.username || null]
    );

    next();
  } catch (error) {
    res.status(401).json({ error: error.message });
  }
}

app.get("/health", (req, res) => {
  res.json({ status: "online", game: "UGLY CLICKER" });
});

app.get("/api/catalog", (req, res) => {
  res.json(catalog);
});

app.get("/api/state", authMiddleware, async (req, res) => {
  try {
    const playerId = req.player.id;

    const player = await pool.query(
      "SELECT balance FROM players WHERE telegram_id = $1",
      [playerId]
    );

    const items = await pool.query(
      `SELECT id, category, item_name, purchase_price, purchased_at
       FROM inventory
       WHERE telegram_id = $1
       ORDER BY purchased_at DESC`,
      [playerId]
    );

    res.json({
      balance: Number(player.rows[0].balance),
      inventory: items.rows
    });
  } catch {
    res.status(500).json({ error: "Could not load game data" });
  }
});

app.post("/api/click", authMiddleware, async (req, res) => {
  try {
    const result = await pool.query(
      `UPDATE players
       SET balance = balance + 1
       WHERE telegram_id = $1
       RETURNING balance`,
      [req.player.id]
    );

    res.json({ balance: Number(result.rows[0].balance) });
  } catch {
    res.status(500).json({ error: "Click failed" });
  }
});

app.post("/api/shop/buy", authMiddleware, async (req, res) => {
  const { category, index } = req.body;

  if (!catalog[category] ||
      !Number.isInteger(index) ||
      !catalog[category][index]) {
    return res.status(400).json({ error: "Invalid item" });
  }

  const item = catalog[category][index];
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const player = await client.query(
      `SELECT balance FROM players
       WHERE telegram_id = $1 FOR UPDATE`,
      [req.player.id]
    );

    if (!player.rows.length ||
        Number(player.rows[0].balance) < item.price) {
      throw new Error("Недостаточно денег");
    }

    await client.query(
      `UPDATE players
       SET balance = balance - $1
       WHERE telegram_id = $2`,
      [item.price, req.player.id]
    );

    await client.query(
      `INSERT INTO inventory
       (telegram_id, category, item_name, purchase_price)
       VALUES ($1, $2, $3, $4)`,
      [req.player.id, category, item.name, item.price]
    );

    await client.query("COMMIT");

    const updated = await client.query(
      "SELECT balance FROM players WHERE telegram_id = $1",
      [req.player.id]
    );

    res.json({
      success: true,
      message: "Покупка успешна",
      balance: Number(updated.rows[0].balance)
    });
  } catch (error) {
    await client.query("ROLLBACK");
    res.status(400).json({ error: error.message });
  } finally {
    client.release();
  }
});

app.post("/api/shop/sell", authMiddleware, async (req, res) => {
  const itemId = Number(req.body.itemId);

  if (!Number.isSafeInteger(itemId) || itemId <= 0) {
    return res.status(400).json({ error: "Invalid item" });
  }

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const item = await client.query(
      `SELECT id, purchase_price
       FROM inventory
       WHERE id = $1 AND telegram_id = $2
       FOR UPDATE`,
      [itemId, req.player.id]
    );

    if (!item.rows.length) {
      throw new Error("Предмет не найден");
    }

    const refund = Math.floor(
      Number(item.rows[0].purchase_price) * 0.70
    );

    await client.query(
      "DELETE FROM inventory WHERE id = $1",
      [itemId]
    );

    await client.query(
      `UPDATE players
       SET balance = balance + $1
       WHERE telegram_id = $2`,
      [refund, req.player.id]
    );

    await client.query("COMMIT");

    const updated = await client.query(
      "SELECT balance FROM players WHERE telegram_id = $1",
      [req.player.id]
    );

    res.json({
      success: true,
      refund,
      balance: Number(updated.rows[0].balance)
    });
  } catch (error) {
    await client.query("ROLLBACK");
    res.status(400).json({ error: error.message });
  } finally {
    client.release();
  }
});

initDatabase()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`UGLY CLICKER running on port ${PORT}`);
    });
  })
  .catch(error => {
    console.error("Database initialization failed:", error);
    process.exit(1);
  });

