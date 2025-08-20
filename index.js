"use strict";

/* ===== Core / Libs ===== */
const fs = require("fs");
const path = require("path");
const express = require("express");
const session = require("express-session");
const bodyParser = require("body-parser");
const multer = require("multer");
require("dotenv").config();

/* ===== Baileys ===== */
const { makeWASocket, useMultiFileAuthState } = require("@whiskeysockets/baileys");

/* ===== Constantes / Rutas ===== */
const PORT = process.env.PORT || 3000;
const AUTH_DIR = process.env.AUTH_DIR || path.join(__dirname, "data", "auth");
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(__dirname, "data", "uploads");
const CONFIG_PATH = path.join(__dirname, "config.json");

/* ===== Helpers de archivos/dirs ===== */
function ensureDir(p) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}
ensureDir(AUTH_DIR);
ensureDir(UPLOAD_DIR);

/* ===== Cargar/guardar config ===== */
function loadConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    fs.writeFileSync(
      CONFIG_PATH,
      JSON.stringify(
        {
          admins: [],
          images: { saludo: "", qr: "", references: [] },
          texts: { greeting: "", menu: [], productIntro: "", hints: "5. 💳 Ir a pagar\n8. 🔁 Volver al menú" },
          currencySymbols: {},
          countries: {}
        },
        null,
        2
      )
    );
  }
  const raw = fs.readFileSync(CONFIG_PATH, "utf8");
  return JSON.parse(raw);
}
function saveConfig(cfg) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
}

/* ===== Estado del bot ===== */
const userState = new Map(); // { jid: { countryKey } }

/* ===== Express ===== */
const app = express();
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(
  session({
    secret: process.env.SESSION_SECRET || "secret",
    resave: false,
    saveUninitialized: false
  })
);
app.use(express.static(path.join(__dirname, "public")));
app.use("/media", express.static(UPLOAD_DIR));

/* ===== Middleware auth panel ===== */
function requireLogin(req, res, next) {
  if (req.session && req.session.logged) return next();
  res.redirect("/login.html");
}

/* ===== Login ===== */
app.post("/api/login", (req, res) => {
  const { user, pass } = req.body || {};
  const U = process.env.ADMIN_USER || "admin";
  const P = process.env.ADMIN_PASS || "1234";
  if (user === U && pass === P) {
    req.session.logged = true;
    return res.json({ ok: true });
  }
  return res.status(401).json({ ok: false, error: "Credenciales inválidas" });
});
app.post("/api/logout", (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

/* ===== API: leer config ===== */
app.get("/api/config", requireLogin, (req, res) => res.json(loadConfig()));

/* ===== API: textos ===== */
app.post("/api/texts", requireLogin, (req, res) => {
  const cfg = loadConfig();
  const { greeting, menu, productIntro, hints } = req.body || {};
  if (typeof greeting === "string") cfg.texts.greeting = greeting;
  if (Array.isArray(menu)) cfg.texts.menu = menu;
  if (typeof productIntro === "string") cfg.texts.productIntro = productIntro;
  if (typeof hints === "string") cfg.texts.hints = hints;
  saveConfig(cfg);
  res.json({ ok: true });
});

/* ===== API: países CRUD ===== */
app.get("/api/countries", requireLogin, (req, res) => {
  const cfg = loadConfig();
  const q = (req.query.q || "").toString().toLowerCase();
  const items = Object.entries(cfg.countries).map(([key, data]) => ({ key, ...data }));
  const filtered = q
    ? items.filter(
        (e) =>
          e.key.includes(q) ||
          (e.label || "").toLowerCase().includes(q) ||
          (e.currency || "").toLowerCase().includes(q)
      )
    : items;
  res.json({ ok: true, items: filtered });
});

app.post("/api/countries", requireLogin, (req, res) => {
  const cfg = loadConfig();
  const { key, label, currency, payment, prices } = req.body || {};
  if (!key || !label || !currency) return res.status(400).json({ ok: false, error: "key, label y currency requeridos" });
  cfg.countries[key.toLowerCase()] = {
    label,
    currency,
    payment: {
      bank: payment?.bank || "",
      account: payment?.account || "",
      owner: payment?.owner || "",
      qr: payment?.qr || ""
    },
    prices: prices || { shared1: {}, shared2: {}, individual: {} }
  };
  saveConfig(cfg);
  res.json({ ok: true });
});

app.delete("/api/countries/:key", requireLogin, (req, res) => {
  const cfg = loadConfig();
  const k = req.params.key.toLowerCase();
  if (!cfg.countries[k]) return res.status(404).json({ ok: false, error: "No existe" });
  delete cfg.countries[k];
  saveConfig(cfg);
  res.json({ ok: true });
});

/* ===== Upload imágenes ===== */
const upload = multer({ dest: UPLOAD_DIR });
app.post("/api/upload", requireLogin, upload.single("file"), (req, res) => {
  if (!req.file) return res.status(400).json({ ok: false, error: "Sin archivo" });
  const ext = path.extname(req.file.originalname) || ".jpg";
  const final = req.file.filename + ext;
  fs.renameSync(req.file.path, path.join(UPLOAD_DIR, final));
  res.json({ ok: true, path: "/media/" + final });
});
app.post("/api/images", requireLogin, (req, res) => {
  const { field, value } = req.body || {};
  const cfg = loadConfig();
  if (field === "saludo") cfg.images.saludo = value || "";
  else if (field === "qr") cfg.images.qr = value || "";
  else if (field === "references:add") {
    cfg.images.references = cfg.images.references || [];
    if (value) cfg.images.references.push(value);
  } else if (field === "references:clear") cfg.images.references = [];
  saveConfig(cfg);
  res.json({ ok: true });
});

/* ===== Proteger /admin.html ===== */
app.get("/admin.html", requireLogin, (req, res) => {
  res.sendFile(path.join(__dirname, "public", "admin.html"));
});

/* ===== BOT ===== */
let sock;
async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  sock = makeWASocket({ auth: state, printQRInTerminal: true });
  sock.ev.on("creds.update", saveCreds);

  // Anti-spam del prompt de país
  const lastPrompt = new Map(); // { jid: timestamp }

  sock.ev.on("messages.upsert", async ({ messages }) => {
    const m = messages?.[0];
    if (!m) return;

    // Ignorar mensajes del propio bot y status
    if (m.key?.fromMe) return;
    if (m.key?.remoteJid === "status@broadcast") return;

    const from = m.key.remoteJid;
    const body =
      (m.message?.conversation ||
        m.message?.extendedTextMessage?.text ||
        m.message?.imageMessage?.caption ||
        "").trim();

    if (!from || !body) return;

    const cfg = loadConfig();
    let st = userState.get(from) || { countryKey: null };
    const hints = () => "\n\n" + (cfg.texts?.hints || "5. 💳 Ir a pagar\n8. 🔁 Volver al menú");

    // Si no tiene país elegido
    if (!st.countryKey) {
      const pairs = Object.entries(cfg.countries);
      const list = pairs.map(([k, v], i) => `• *${i + 1}* ${v.label}`);

      const n = parseInt(body, 10);
      if (Number.isInteger(n) && n >= 1 && n <= list.length) {
        const chosenKey = pairs[n - 1][0];
        st.countryKey = chosenKey;
        userState.set(from, st);

        await sock.sendMessage(from, {
          text: `¡Listo! Guardé tu país ✅\n\n${cfg.texts.greeting}\n\n${cfg.texts.menu.join("\n")}`
        });
        return;
      }

      // Debounce 60s
      const now = Date.now();
      const last = lastPrompt.get(from) || 0;
      if (now - last < 60000) return;
      lastPrompt.set(from, now);

      const prompt = ["Hola… soy *Samantha*.", "", "Indica tu país (solo una vez):", ...list].join("\n");
      await sock.sendMessage(from, { text: prompt });
      return;
    }

    // Menú
    if (body === "8") {
      await sock.sendMessage(from, { text: `${cfg.texts.greeting}\n\n${cfg.texts.menu.join("\n")}` });
      return;
    }

    if (body === "1") {
      const c = cfg.countries[st.countryKey];
      const sym = cfg.currencySymbols[c.currency] || c.currency;
      const lines = [cfg.texts.productIntro, ""];
      const block = (title, obj) => {
        const keys = Object.keys(obj || {});
        if (!keys.length) return;
        lines.push(`*${title}*`);
        keys.forEach((k) => lines.push(`• ${k}: ${obj[k]} ${sym}`));
        lines.push("");
      };
      block("Plan Compartido 1", c.prices.shared1);
      block("Plan Compartido 2", c.prices.shared2);
      block("Plan Individual", c.prices.individual);
      lines.push(hints());
      await sock.sendMessage(from, { text: lines.join("\n") });
      return;
    }

    if (body === "5") {
      const c = cfg.countries[st.countryKey];
      const sym = cfg.currencySymbols[c.currency] || c.currency;
      const pay = c.payment || {};
      const msg =
        ["*Pago*", `Banco: ${pay.bank || "-"}`, `Cuenta: ${pay.account || "-"}`, `Titular: ${pay.owner || "-"}`, `Moneda: ${c.currency} (${sym})`].join("\n") +
        hints();
      await sock.sendMessage(from, { text: msg });
      if (pay.qr) await sock.sendMessage(from, { image: { url: pay.qr }, caption: "QR de pago" });
      return;
    }

    if (body === "2") {
      await sock.sendMessage(from, { text: "ChatGPT PLUS te ofrece más velocidad, mejores respuestas y herramientas extra." + hints() });
      return;
    }

    if (body === "3") {
      const refs = cfg.images.references || [];
      if (!refs.length) {
        await sock.sendMessage(from, { text: "Por ahora no hay referencias cargadas." + hints() });
        return;
      }
      for (const r of refs) await sock.sendMessage(from, { image: { url: r } });
      await sock.sendMessage(from, { text: hints() });
      return;
    }

    if (body === "4") {
      const admins = cfg.admins || [];
      const join = admins.map((a) => `• ${a}`).join("\n") || "No hay vendedores configurados.";
      await sock.sendMessage(from, { text: `Te conecto con un vendedor:\n${join}` + hints() });
      return;
    }

    // Fallback menú
    await sock.sendMessage(from, { text: `${cfg.texts.greeting}\n\n${cfg.texts.menu.join("\n")}` });
  });
}

startBot().catch((e) => console.error("Error bot:", e));

/* ===== HTTP listen ===== */
app.listen(PORT, () => console.log(`Panel admin: http://localhost:${PORT}/login.html`));