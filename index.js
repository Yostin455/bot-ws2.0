"use strict";

/* ===== Core / Libs ===== */
const fs = require("fs");
const path = require("path");
const express = require("express");
const session = require("express-session");
const bodyParser = require("body-parser");
const multer = require("multer");
const QRCode = require("qrcode");
require("dotenv").config();

/* ===== Baileys ===== */
const { makeWASocket, useMultiFileAuthState } = require("@whiskeysockets/baileys");

/* ===== Constantes / Rutas ===== */
const PORT = process.env.PORT || 3000;
const AUTH_DIR = process.env.AUTH_DIR || path.join(__dirname, "data", "auth");
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(__dirname, "data", "uploads");
const CONFIG_PATH = path.join(__dirname, "config.json");

/* ===== Helpers de archivos/dirs ===== */
function ensureDir(p) { if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true }); }
ensureDir(path.dirname(CONFIG_PATH));
ensureDir(AUTH_DIR);
ensureDir(UPLOAD_DIR);

/* ===== Cargar/guardar config ===== */
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
function saveConfig(conf) { fs.writeFileSync(CONFIG_PATH, JSON.stringify(conf, null, 2)); }

/* ===== Estado del bot por usuario ===== */
const userState = new Map(); // key: jid, value: { countryKey }

/* ===== Express ===== */
const app = express();
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(session({
  secret: process.env.SESSION_SECRET || "secret",
  resave: false,
  saveUninitialized: false
}));
app.use(express.static(path.join(__dirname, "public")));
app.use("/media", express.static(UPLOAD_DIR));

/* ===== Middleware auth panel ===== */
function requireLogin(req, res, next) {
  if (req.session && req.session.logged) return next();
  return res.redirect("/login.html");
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
app.post("/api/logout", (req, res) => req.session.destroy(() => res.json({ ok: true })));
app.get("/admin.html", requireLogin, (req, res) => {
  res.sendFile(path.join(__dirname, "public", "admin.html"));
});

/* ===== API config lectura ===== */
app.get("/api/config", requireLogin, (req, res) => res.json(loadConfig()));

/* ===== API textos ===== */
app.post("/api/texts", requireLogin, (req, res) => {
  const cfg = loadConfig();
  const { greeting, menu, productIntro } = req.body;
  if (typeof greeting === "string") cfg.texts.greeting = greeting;
  if (Array.isArray(menu)) cfg.texts.menu = menu;
  if (typeof productIntro === "string") cfg.texts.productIntro = productIntro;
  saveConfig(cfg);
  res.json({ ok: true });
});

/* ===== API países CRUD ===== */
app.get("/api/countries", requireLogin, (req, res) => {
  const cfg = loadConfig();
  const q = (req.query.q || "").toString().toLowerCase();
  const items = Object.entries(cfg.countries).map(([key, data]) => ({ key, ...data }));
  const filtered = q
    ? items.filter(e =>
        e.key.includes(q) ||
        (e.label || "").toLowerCase().includes(q) ||
        (e.currency || "").toLowerCase().includes(q))
    : items;
  res.json({ ok: true, items: filtered });
});

app.post("/api/countries", requireLogin, (req, res) => {
  const cfg = loadConfig();
  const { key, label, currency, payment, prices } = req.body || {};
  if (!key || !label || !currency)
    return res.status(400).json({ ok: false, error: "key, label y currency son requeridos" });
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
  const finalName = req.file.filename + ext;
  const finalPath = path.join(UPLOAD_DIR, finalName);
  fs.renameSync(req.file.path, finalPath);
  const rel = "/media/" + finalName;
  res.json({ ok: true, path: rel });
});

/* ===== Guardar imágenes en config ===== */
app.post("/api/images", requireLogin, (req, res) => {
  const { field, value } = req.body || {};
  const cfg = loadConfig();
  if (field === "saludo") cfg.images.saludo = value || "";
  else if (field === "qr") cfg.images.qr = value || "";
  else if (field === "references:add") {
    if (!cfg.images.references) cfg.images.references = [];
    if (value) cfg.images.references.push(value);
  } else if (field === "references:clear") {
    cfg.images.references = [];
  }
  saveConfig(cfg);
  res.json({ ok: true });
});

/* ===== QR como imagen: endpoint público ===== */
let latestQRDataURL = null; // data:image/png;base64,...
app.get("/qr", (req, res) => {
  if (!latestQRDataURL) return res.send("⏳ Espera a que se genere el QR...");
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  const html = `
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <h2>Escanea este QR con WhatsApp</h2>
    <img src="${latestQRDataURL}" style="width:320px;image-rendering:pixelated" />
    <p>Si expira, recarga la página.</p>`;
  res.send(html);
});

/* ===== BOT ===== */
let sock;
async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  sock = makeWASocket({ auth: state }); // sin printQRInTerminal

  sock.ev.on("creds.update", saveCreds);

  // Generar PNG del QR y servirlo por /qr
  sock.ev.on("connection.update", async (update) => {
    const { qr, connection, lastDisconnect } = update;

    if (qr) {
      try {
        latestQRDataURL = await QRCode.toDataURL(qr, { margin: 1, width: 512 });
        // Guarda un archivo PNG por si lo quieres descargar
        const pngPath = path.join(UPLOAD_DIR, "qr-login.png");
        const base64 = latestQRDataURL.split(",")[1];
        fs.writeFileSync(pngPath, Buffer.from(base64, "base64"));
        console.log(`🔗 QR listo: abre /qr   |   PNG guardado: ${pngPath}`);
      } catch (e) {
        console.error("Error generando PNG del QR:", e);
      }
    }

    if (connection === "open") {
      console.log("✅ Conectado a WhatsApp");
      latestQRDataURL = null; // ya no mostrar QR
    }

    if (connection === "close") {
      console.log("❌ Conexión cerrada:", lastDisconnect?.error?.message);
    }
  });

  // Mensajería
  sock.ev.on("messages.upsert", async ({ messages }) => {
    const m = messages?.[0];
    if (!m || !m.key?.remoteJid) return;
    const from = m.key.remoteJid;
    const text = (m.message?.conversation || m.message?.extendedTextMessage?.text || "").trim();
    if (!text) return;

    const cfg = loadConfig();
    let stateU = userState.get(from) || { countryKey: null };

    // Si no tiene país -> seleccionar una vez
    if (!stateU.countryKey) {
      const entries = Object.entries(cfg.countries);
      const list = entries.map(([k, v], i) => `• *${i + 1}* ${v.label}`);
      const n = parseInt(text, 10);
      if (Number.isInteger(n) && n >= 1 && n <= entries.length) {
        const chosenKey = entries[n - 1][0];
        stateU.countryKey = chosenKey;
        userState.set(from, stateU);
        const menuText = cfg.texts.menu.join("\n");
        await sock.sendMessage(from, { text: `¡Listo! Guardé tu país ✅\n\n${cfg.texts.greeting}\n\n${menuText}` });
        return;
      }
      const prompt = ["Hola… soy *Samantha*.", "", "Indica tu país (solo una vez):", ...list].join("\n");
      await sock.sendMessage(from, { text: prompt });
      return;
    }

    // Ya con país, opciones:
    const showMenu = async () => {
      const menuText = cfg.texts.menu.join("\n");
      await sock.sendMessage(from, { text: `${cfg.texts.greeting}\n\n${menuText}` });
    };

    if (text === "8") return showMenu();

    if (text === "1") {
      const c = cfg.countries[stateU.countryKey];
      const symbol = cfg.currencySymbols[c.currency] || c.currency;
      const lines = [cfg.texts.productIntro, ""];
      const block = (title, obj) => {
        const keys = Object.keys(obj || {});
        if (!keys.length) return;
        lines.push(`*${title}*`);
        keys.forEach(k => lines.push(`• ${k}: ${obj[k]} ${symbol}`));
        lines.push("");
      };
      block("Plan Compartido 1", c.prices.shared1);
      block("Plan Compartido 2", c.prices.shared2);
      block("Plan Individual", c.prices.individual);

      // Accesos rápidos siempre visibles
      lines.push("——");
      lines.push("5. 💳 Ir a pagar");
      lines.push("8. 🔁 Volver al menú");

      await sock.sendMessage(from, { text: lines.join("\n") });
      return;
    }

    if (text === "5") {
      const c = cfg.countries[stateU.countryKey];
      const pay = c.payment || {};
      const symbol = cfg.currencySymbols[c.currency] || c.currency;
      const payMsg = [
        "*Pago*",
        `Banco: ${pay.bank || "-"}`,
        `Cuenta: ${pay.account || "-"}`,
        `Titular: ${pay.owner || "-"}`,
        `Moneda: ${c.currency} (${symbol})`,
        pay.qr ? "Te envío el QR a continuación." : ""
      ].join("\n");
      await sock.sendMessage(from, { text: payMsg });
      if (pay.qr) await sock.sendMessage(from, { image: { url: pay.qr }, caption: "QR de pago" });

      // Accesos rápidos
      await sock.sendMessage(from, { text: "8. 🔁 Volver al menú" });
      return;
    }

    if (text === "2") {
      await sock.sendMessage(from, { text: "ChatGPT PLUS te ofrece más velocidad, mejores respuestas y herramientas extra." });
      await sock.sendMessage(from, { text: "5. 💳 Ir a pagar\n8. 🔁 Volver al menú" });
      return;
    }

    if (text === "3") {
      const refs = loadConfig().images.references || [];
      if (!refs.length) {
        await sock.sendMessage(from, { text: "Por ahora no hay referencias cargadas." });
      } else {
        for (const r of refs) await sock.sendMessage(from, { image: { url: r } });
      }
      await sock.sendMessage(from, { text: "8. 🔁 Volver al menú" });
      return;
    }

    if (text === "4") {
      const admins = cfg.admins || [];
      const join = admins.map(a => `• ${a}`).join("\n");
      await sock.sendMessage(from, { text: `Te conecto con un vendedor:\n${join || "No hay vendedores configurados."}` });
      await sock.sendMessage(from, { text: "5. 💳 Ir a pagar\n8. 🔁 Volver al menú" });
      return;
    }

    // Fallback: mostrar menú
    await showMenu();
  });
}

startBot().catch(e => console.error("Fallo al iniciar bot:", e));

/* ===== HTTP listen ===== */
app.listen(PORT, () => {
  console.log(`🌐 Panel/Login: http://localhost:${PORT}/login.html`);
  console.log(`📱 QR (si hay): http://localhost:${PORT}/qr`);
});