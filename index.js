"use strict";

/* ===== Core / Libs ===== */
const fs = require("fs");
const path = require("path");
const express = require("express");
const session = require("express-session");
const bodyParser = require("body-parser");
const multer = require("multer");
const QRCode = require("qrcode");               // para guardar QR en PNG
require("dotenv").config();

/* ===== WhatsApp (Baileys) ===== */
const { makeWASocket, useMultiFileAuthState } = require("@whiskeysockets/baileys");

/* ===== Constantes / Paths ===== */
const PORT       = process.env.PORT || 3000;
const AUTH_DIR   = process.env.AUTH_DIR   || path.join(__dirname, "data", "auth");
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(__dirname, "data", "uploads");
const CONFIG_PATH = path.join(__dirname, "config.json");
const WAQR_PNG = (process.env.WAQR_PNG || "1") === "1";  // guarda QR como PNG

/* ===== Helpers de archivos/dirs ===== */
function ensureDir(p) { if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true }); }
ensureDir(path.dirname(CONFIG_PATH));
ensureDir(AUTH_DIR);
ensureDir(UPLOAD_DIR);

/* ===== Cargar/guardar config ===== */
function loadConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    const init = {
      admins: [],
      images: { saludo: "", qr: "", references: [] },
      texts: {
        greeting: "Hola, soy *Samantha*. Estoy aquí para ayudarte a elegir el plan perfecto, resolver dudas y acompañarte en todo el proceso ✨",
        menu: [],
        productIntro: "Estos son nuestros planes disponibles en tu país:"
      },
      currencySymbols: { BOB: "Bs", ARS: "$", MXN: "$", PEN: "S/", USD: "$", EUR: "€" },
      countries: {
        bolivia: {
          label: "Bolivia",
          currency: "BOB",
          payment: { bank: "", account: "", owner: "", qr: "" },
          prices: {
            shared1:   { "1 mes": 35, "2 meses": 60, "6 meses": 169, "1 año": 329 },
            shared2:   { "1 mes": 60, "2 meses": 109, "6 meses": 309 },
            individual:{ "1 mes": 139, "2 meses": 269, "6 meses": 599, "1 año": 1579 }
          }
        },
        argentina: { label:"Argentina", currency:"ARS", payment:{bank:"",account:"",owner:"",qr:""}, prices:{shared1:{},shared2:{},individual:{}} },
        mexico:    { label:"México",   currency:"MXN", payment:{bank:"",account:"",owner:"",qr:""}, prices:{shared1:{},shared2:{},individual:{}} }
      }
    };
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(init, null, 2));
  }
  return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
}
function saveConfig(cfg) { fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2)); }

/* ===== Utilidades de menú ===== */
function buildMenu(cfg) {
  const base = [
    "1. 💲 Ver productos y precios irresistibles.",
    "2. 💎 ¿Qué es ChatGPT PLUS?",
    "3. 🖼️ Ver referencias.",
    "4. 🤝 Conectar con un vendedor."
  ];
  const tail = [
    "5. 💳 Ir a pagar",
    "8. 🔁 Volver al menú"
  ];
  let items = Array.isArray(cfg.texts?.menu) && cfg.texts.menu.length ? cfg.texts.menu.slice() : base.slice();
  // quita duplicados de 5 y 8 y fuerza orden
  items = items.filter(l => !/^5\./.test(l) && !/^8\./.test(l));
  items.push(...tail);
  const header = cfg.texts?.greeting || "Hola, soy *Samantha*.";
  return header + "\n\n" + items.join("\n");
}
const MENU_FOOTER = "\n\n5. 💳 Ir a pagar\n8. 🔁 Volver al menú";

/* ===== Estado del bot por usuario ===== */
const userState = new Map(); // { jid -> { countryKey } }

/* ===== Express ===== */
const app = express();
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(session({
  secret: process.env.SESSION_SECRET || "supersecreto",
  resave: false,
  saveUninitialized: false
}));

// estáticos
app.use(express.static(path.join(__dirname, "public")));
app.use("/media", express.static(UPLOAD_DIR));

/* ===== Auth middleware (panel) ===== */
function requireLogin(req, res, next) {
  if (req.session?.logged) return next();
  return res.redirect("/login.html");
}

/* ===== Login API ===== */
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
app.post("/api/logout", (req, res) => req.session.destroy(() => res.json({ ok:true })));

/* ===== Config read ===== */
app.get("/api/config", requireLogin, (req, res) => res.json(loadConfig()));

/* ===== Textos ===== */
app.post("/api/texts", requireLogin, (req, res) => {
  const cfg = loadConfig();
  const { greeting, menu, productIntro } = req.body || {};
  if (typeof greeting === "string") cfg.texts.greeting = greeting;
  if (Array.isArray(menu)) cfg.texts.menu = menu;
  if (typeof productIntro === "string") cfg.texts.productIntro = productIntro;
  saveConfig(cfg);
  res.json({ ok: true });
});

/* ===== Países CRUD ===== */
app.get("/api/countries", requireLogin, (req, res) => {
  const q = (req.query.q || "").toString().toLowerCase();
  const cfg = loadConfig();
  const arr = Object.entries(cfg.countries).map(([key, v]) => ({ key, ...v }));
  const items = q ? arr.filter(e =>
    e.key.includes(q) ||
    (e.label||"").toLowerCase().includes(q) ||
    (e.currency||"").toLowerCase().includes(q)
  ) : arr;
  res.json({ ok:true, items });
});

app.post("/api/countries", requireLogin, (req, res) => {
  const cfg = loadConfig();
  const { key, label, currency, payment, prices } = req.body || {};
  if (!key || !label || !currency) return res.status(400).json({ ok:false, error:"key, label, currency son requeridos" });
  cfg.countries[key.toLowerCase()] = {
    label,
    currency,
    payment: {
      bank: payment?.bank || "", account: payment?.account || "", owner: payment?.owner || "", qr: payment?.qr || ""
    },
    prices: prices || { shared1:{}, shared2:{}, individual:{} }
  };
  saveConfig(cfg);
  res.json({ ok:true });
});

app.delete("/api/countries/:key", requireLogin, (req, res) => {
  const cfg = loadConfig();
  const k = req.params.key.toLowerCase();
  if (!cfg.countries[k]) return res.status(404).json({ ok:false, error:"No existe" });
  delete cfg.countries[k];
  saveConfig(cfg);
  res.json({ ok:true });
});

/* ===== Uploads ===== */
const upload = multer({ dest: UPLOAD_DIR });
app.post("/api/upload", requireLogin, upload.single("file"), (req, res) => {
  if (!req.file) return res.status(400).json({ ok:false, error:"Sin archivo" });
  const ext = path.extname(req.file.originalname) || ".jpg";
  const finalName = req.file.filename + ext;
  const finalPath = path.join(UPLOAD_DIR, finalName);
  fs.renameSync(req.file.path, finalPath);
  res.json({ ok:true, path: "/media/" + finalName });
});

/* ===== Guardar paths de imágenes en config ===== */
app.post("/api/images", requireLogin, (req, res) => {
  const { field, value } = req.body || {};
  const cfg = loadConfig();
  if (field === "saludo") cfg.images.saludo = value || "";
  else if (field === "qr") cfg.images.qr = value || "";
  else if (field === "references:add") {
    if (!cfg.images.references) cfg.images.references = [];
    if (value) cfg.images.references.push(value);
  } else if (field === "references:clear") cfg.images.references = [];
  saveConfig(cfg);
  res.json({ ok:true });
});

/* ===== Vistas protegidas ===== */
app.get("/admin.html", requireLogin, (req, res) =>
  res.sendFile(path.join(__dirname, "public", "admin.html"))
);

/* ===== Home & 404 ===== */
app.get("/", (req, res) => res.redirect("/login.html"));
app.use((req, res) => res.status(404).send("Not Found. Visita /login.html o /qr"));

/* ===== Ruta QR como PNG (útil en Render) ===== */
app.get("/qr", (req, res) => {
  const png = path.join(UPLOAD_DIR, "qr-login.png");
  if (fs.existsSync(png)) res.sendFile(png);
  else res.status(404).send("QR no disponible. Revisa los logs.");
});

/* ===== Bot WhatsApp ===== */
let sock;
async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  sock = makeWASocket({ auth: state });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", async (u) => {
    const { qr } = u || {};
    if (qr && WAQR_PNG) {
      try {
        const out = path.join(UPLOAD_DIR, "qr-login.png");
        await QRCode.toFile(out, qr, { type: "png", width: 700, margin: 1 });
        console.log("QR listo como PNG:", out);
      } catch (e) { console.error("Fallo guardando QR:", e.message); }
    }
  });

  sock.ev.on("messages.upsert", async ({ messages }) => {
    const m = messages?.[0];
    const from = m?.key?.remoteJid;
    const text = (m?.message?.conversation || m?.message?.extendedTextMessage?.text || "").trim();
    if (!from || !text) return;

    const cfg = loadConfig();
    let state = userState.get(from) || { countryKey: null };

    // comando para reiniciar país
    if (/^(00|pais|país|country)$/i.test(text)) {
      state.countryKey = null;
      userState.set(from, state);
    }

    // 1) si no hay país, no avanzamos al menú
    if (!state.countryKey) {
      const entries = Object.entries(cfg.countries);
      if (!entries.length) {
        await sock.sendMessage(from, { text: "Aún no hay países configurados. Contacta a un administrador." });
        return;
      }
      const list = entries.map(([k, v], i) => `• *${i + 1}* ${v.label}`);

      const n = parseInt(text, 10);
      if (Number.isInteger(n) && n >= 1 && n <= entries.length) {
        state.countryKey = entries[n - 1][0];
        userState.set(from, state);
        const menuText = buildMenu(cfg);
        await sock.sendMessage(from, { text: `¡Listo! Guardé tu país ✅\n\n${menuText}` });
        return;
      }
      const prompt = [
        "Hola… soy *Samantha*.",
        "",
        "Indica tu país (solo una vez):",
        ...list
      ].join("\n");
      await sock.sendMessage(from, { text: prompt });
      return;
    }

    // 2) ya con país → menú
    if (text === "8") {
      const menuText = buildMenu(cfg);
      await sock.sendMessage(from, { text: menuText });
      return;
    }

    if (text === "1") {
      const c = cfg.countries[state.countryKey];
      const symbol = cfg.currencySymbols?.[c.currency] || c.currency || "";
      const lines = [cfg.texts?.productIntro || "Estos son nuestros planes disponibles en tu país:", ""];
      const block = (title, obj) => {
        const keys = Object.keys(obj || {});
        if (!keys.length) return;
        lines.push(`*${title}*`);
        keys.forEach(k => lines.push(`• ${k}: ${obj[k]} ${symbol}`));
        lines.push("");
      };
      block("Planes Compartidos (1 dispositivo)", c?.prices?.shared1);
      block("Planes Compartidos (2 dispositivos)", c?.prices?.shared2);
      block("Planes Individuales",             c?.prices?.individual);
      await sock.sendMessage(from, { text: lines.join("\n") + MENU_FOOTER });
      return;
    }

    if (text === "5") {
      const c = cfg.countries[state.countryKey];
      const pay = c.payment || {};
      const symbol = cfg.currencySymbols?.[c.currency] || c.currency || "";
      const msg = [
        "*Pago*",
        `Banco: ${pay.bank || "-"}`,
        `Cuenta: ${pay.account || "-"}`,
        `Titular: ${pay.owner || "-"}`,
        `Moneda: ${c.currency || ""}${symbol ? ` (${symbol})` : ""}`
      ].join("\n") + MENU_FOOTER;
      await sock.sendMessage(from, { text: msg });
      if (pay.qr) await sock.sendMessage(from, { image: { url: pay.qr }, caption: "QR de pago" });
      return;
    }

    if (text === "2") {
      await sock.sendMessage(from, { text: "ChatGPT PLUS te ofrece más velocidad, mejores respuestas y herramientas extra." + MENU_FOOTER });
      return;
    }

    if (text === "3") {
      const refs = cfg.images?.references || [];
      if (!refs.length) {
        await sock.sendMessage(from, { text: "Por ahora no hay referencias cargadas." + MENU_FOOTER });
        return;
      }
      for (const r of refs) await sock.sendMessage(from, { image: { url: r } });
      await sock.sendMessage(from, { text: MENU_FOOTER.trim() });
      return;
    }

    if (text === "4") {
      const join = (cfg.admins || []).map(a => `• ${a}`).join("\n") || "No hay vendedores configurados.";
      await sock.sendMessage(from, { text: `Te conecto con un vendedor:\n${join}` + MENU_FOOTER });
      return;
    }

    // fallback → menú
    const menuText = buildMenu(cfg);
    await sock.sendMessage(from, { text: menuText });
  });
}

startBot().catch(e => console.error("Fallo al iniciar bot:", e));

/* ===== HTTP listen ===== */
app.listen(PORT, () => {
  console.log(`Admin/login: http://localhost:${PORT}/login.html`);
  console.log(`QR (si existe PNG): http://localhost:${PORT}/qr`);
});