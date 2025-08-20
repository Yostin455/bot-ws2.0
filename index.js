"use strict";

/* ===== Core ===== */
const fs = require("fs");
const path = require("path");
const express = require("express");
const session = require("express-session");
const bodyParser = require("body-parser");
const multer = require("multer");
const qrcode = require("qrcode");
const qrcTerm = require("qrcode-terminal");
require("dotenv").config();

/* ===== Baileys ===== */
const { makeWASocket, useMultiFileAuthState, DisconnectReason } = require("@whiskeysockets/baileys");

/* ===== Constantes / Rutas ===== */
const PORT = process.env.PORT || 3000;
const AUTH_DIR = process.env.AUTH_DIR || path.join(__dirname, "data", "auth");
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(__dirname, "data", "uploads");
const PUBLIC_DIR = path.join(__dirname, "public");
const CONFIG_PATH = path.join(__dirname, "config.json");

/* ===== Helpers ===== */
function ensureDir(p) { if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true }); }
ensureDir(AUTH_DIR);
ensureDir(UPLOAD_DIR);
ensureDir(PUBLIC_DIR);

function loadConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify({
      admins: [],
      images: { saludo: "", qr: "", references: [] },
      texts: { greeting: "", menu: [], productIntro: "" },
      currencySymbols: {},
      countries: {}
    }, null, 2));
  }
  return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
}
function saveConfig(cfg) { fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2)); }

/* ===== Estado de usuarios ===== */
const userState = new Map(); // { jid -> { countryKey } }

/* ===== Web server ===== */
const app = express();
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(session({
  secret: process.env.SESSION_SECRET || "secret",
  resave: false,
  saveUninitialized: false
}));
app.use(express.static(PUBLIC_DIR));
app.use("/media", express.static(UPLOAD_DIR));

function requireLogin(req, res, next) {
  if (req.session && req.session.logged) return next();
  res.redirect("/login.html");
}

/* --- Login --- */
app.post("/api/login", (req, res) => {
  const { user, pass } = req.body || {};
  if ((user || "") === (process.env.ADMIN_USER || "admin") &&
      (pass || "") === (process.env.ADMIN_PASS || "1234")) {
    req.session.logged = true;
    return res.json({ ok: true });
  }
  res.status(401).json({ ok: false, error: "Credenciales inválidas" });
});
app.post("/api/logout", (req, res) => req.session.destroy(() => res.json({ ok: true })));

/* --- Config lectura --- */
app.get("/api/config", requireLogin, (req, res) => res.json(loadConfig()));

/* --- Textos --- */
app.post("/api/texts", requireLogin, (req, res) => {
  const cfg = loadConfig();
  const { greeting, menu, productIntro } = req.body || {};
  if (typeof greeting === "string") cfg.texts.greeting = greeting;
  if (Array.isArray(menu)) cfg.texts.menu = menu;
  if (typeof productIntro === "string") cfg.texts.productIntro = productIntro;
  saveConfig(cfg);
  res.json({ ok: true });
});

/* --- Países CRUD --- */
app.get("/api/countries", requireLogin, (req, res) => {
  const cfg = loadConfig();
  const q = (req.query.q || "").toString().toLowerCase();
  const items = Object.entries(cfg.countries).map(([key, data]) => ({ key, ...data }));
  const filtered = q
    ? items.filter(i => i.key.includes(q) || (i.label||"").toLowerCase().includes(q) || (i.currency||"").toLowerCase().includes(q))
    : items;
  res.json({ ok: true, items: filtered });
});

app.post("/api/countries", requireLogin, (req, res) => {
  const cfg = loadConfig();
  const { key, label, currency, payment, prices } = req.body || {};
  if (!key || !label || !currency) return res.status(400).json({ ok: false, error: "key, label, currency requeridos" });
  cfg.countries[key.toLowerCase()] = {
    label, currency,
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
  const k = (req.params.key || "").toLowerCase();
  if (!cfg.countries[k]) return res.status(404).json({ ok: false, error: "No existe" });
  delete cfg.countries[k];
  saveConfig(cfg);
  res.json({ ok: true });
});

/* --- Imágenes --- */
const upload = multer({ dest: UPLOAD_DIR });
app.post("/api/upload", requireLogin, upload.single("file"), (req, res) => {
  if (!req.file) return res.status(400).json({ ok: false, error: "Sin archivo" });
  const ext = path.extname(req.file.originalname) || ".jpg";
  const final = req.file.filename + ext;
  fs.renameSync(req.file.path, path.join(UPLOAD_DIR, final));
  res.json({ ok: true, path: "/media/" + final });
});
app.post("/api/images", requireLogin, (req, res) => {
  const cfg = loadConfig();
  const { field, value } = req.body || {};
  if (field === "saludo") cfg.images.saludo = value || "";
  else if (field === "qr") cfg.images.qr = value || "";
  else if (field === "references:add") { cfg.images.references ||= []; if (value) cfg.images.references.push(value); }
  else if (field === "references:clear") cfg.images.references = [];
  saveConfig(cfg);
  res.json({ ok: true });
});

/* --- Proteger admin.html --- */
app.get("/admin.html", requireLogin, (req, res) => res.sendFile(path.join(PUBLIC_DIR, "admin.html")));

/* ===== QR público (Render) ===== */
const QR_IMG_PATH = path.join(PUBLIC_DIR, "qr-login.png");
app.get("/qr", (req, res) => {
  if (fs.existsSync(QR_IMG_PATH)) return res.sendFile(QR_IMG_PATH);
  res.status(404).send("QR no generado aún, espera unos segundos…");
});

/* ===== Bot ===== */
let sock;

async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);

  sock = makeWASocket({
    auth: state,
    printQRInTerminal: false, // manejamos nosotros el QR
    browser: ["SamanthaBot","Chrome","121"]
  });

  sock.ev.on("creds.update", saveCreds);

  // QR & conexión
  sock.ev.on("connection.update", async (u) => {
    const { qr, connection, lastDisconnect } = u;

    if (qr) {
      // PNG para Render (y consola ASCII)
      await qrcode.toFile(QR_IMG_PATH, qr, { width: 320 });
      try { qrcTerm.generate(qr, { small: true }); } catch {}
      console.log(`QR actualizado. Abre: /qr`);
    }

    if (connection === "close") {
      const shouldReconnect = (lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut);
      console.log("Conexión cerrada. Reintentar:", shouldReconnect);
      if (shouldReconnect) setTimeout(startBot, 3000);
    }
    if (connection === "open") {
      console.log("Conectado a WhatsApp ✅");
      if (fs.existsSync(QR_IMG_PATH)) try { fs.unlinkSync(QR_IMG_PATH); } catch {}
    }
  });

  // Mensajes
  sock.ev.on("messages.upsert", async ({ messages }) => {
    const m = messages?.[0];
    if (!m || !m.key?.remoteJid) return;
    const from = m.key.remoteJid;
    const text = (m.message?.conversation || m.message?.extendedTextMessage?.text || "").trim();
    if (!text) return;

    const cfg = loadConfig();
    let stateUser = userState.get(from) || { countryKey: null };

    // si no hay país elegido
    if (!stateUser.countryKey) {
      const list = Object.entries(cfg.countries).map(([k, v], i) => `• *${i + 1}* ${v.label}`);
      const n = parseInt(text, 10);
      if (Number.isInteger(n) && n >= 1 && n <= list.length) {
        stateUser.countryKey = Object.keys(cfg.countries)[n - 1];
        userState.set(from, stateUser);
        const menu = cfg.texts.menu.join("\n");
        await sock.sendMessage(from, { text: `¡Listo! Guardé tu país ✅\n\n${cfg.texts.greeting}\n\n${menu}` });
        return;
      }
      const prompt = ["Hola… soy *Samantha*.", "", "Indica tu país (solo una vez):", ...list].join("\n");
      await sock.sendMessage(from, { text: prompt });
      return;
    }

    // opciones del menú
    if (text === "8") {
      const menu = cfg.texts.menu.join("\n");
      await sock.sendMessage(from, { text: `${cfg.texts.greeting}\n\n${menu}` });
      return;
    }

    if (text === "1") {
      const c = cfg.countries[stateUser.countryKey];
      const sym = cfg.currencySymbols[c.currency] || c.currency;
      const lines = [cfg.texts.productIntro, ""];
      const block = (title, obj) => {
        const ks = Object.keys(obj || {});
        if (!ks.length) return;
        lines.push(`*${title}*`);
        ks.forEach(k => lines.push(`• ${k}: ${obj[k]} ${sym}`));
        lines.push("");
      };
      block("Plan Compartido 1", c.prices.shared1);
      block("Plan Compartido 2", c.prices.shared2);
      block("Plan Individual", c.prices.individual);
      // botones “Ir a pagar / Volver”
      lines.push("5. 💳 Ir a pagar");
      lines.push("8. 🔁 Volver al menú");
      await sock.sendMessage(from, { text: lines.join("\n") });
      return;
    }

    if (text === "5") {
      const c = loadConfig().countries[stateUser.countryKey];
      const pay = c.payment || {};
      const sym = loadConfig().currencySymbols[c.currency] || c.currency;
      const payMsg = [
        "*Pago*",
        `Banco: ${pay.bank || "-"}`,
        `Cuenta: ${pay.account || "-"}`,
        `Titular: ${pay.owner || "-"}`,
        `Moneda: ${c.currency} (${sym})`,
        pay.qr ? "Te envío el QR a continuación." : "",
        "",
        "8. 🔁 Volver al menú"
      ].join("\n");
      await sock.sendMessage(from, { text: payMsg });
      if (pay.qr) await sock.sendMessage(from, { image: { url: pay.qr }, caption: "QR de pago" });
      return;
    }

    if (text === "2") {
      await sock.sendMessage(from, { text: "ChatGPT PLUS te ofrece más velocidad, mejores respuestas y herramientas extra.\n\n5. 💳 Ir a pagar\n8. 🔁 Volver al menú" });
      return;
    }

    if (text === "3") {
      const refs = cfg.images.references || [];
      if (!refs.length) {
        await sock.sendMessage(from, { text: "Por ahora no hay referencias cargadas.\n\n8. 🔁 Volver al menú" });
      } else {
        for (const r of refs) await sock.sendMessage(from, { image: { url: r } });
        await sock.sendMessage(from, { text: "8. 🔁 Volver al menú" });
      }
      return;
    }

    if (text === "4") {
      const admins = cfg.admins || [];
      const join = admins.map(a => `• ${a}`).join("\n");
      await sock.sendMessage(from, { text: `Te conecto con un vendedor:\n${join || "No hay vendedores configurados."}\n\n8. 🔁 Volver al menú` });
      return;
    }

    // fallback -> menú
    const menu = cfg.texts.menu.join("\n");
    await sock.sendMessage(from, { text: `${cfg.texts.greeting}\n\n${menu}` });
  });
}

startBot().catch(e => console.error("Fallo al iniciar bot:", e));

/* ===== HTTP ===== */
app.listen(PORT, () => console.log(`Panel admin: http://localhost:${PORT}/login.html  |  QR: /qr`));