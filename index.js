"use strict";

/* ===== Core / Libs ===== */
const fs = require("fs");
const path = require("path");
const express = require("express");
const session = require("express-session");
const bodyParser = require("body-parser");
const multer = require("multer");
const qrcodeTerminal = require("qrcode-terminal"); // QR en terminal
const QRCode = require("qrcode");                  // Guardar QR a PNG
require("dotenv").config();

/* ===== Baileys ===== */
const { makeWASocket, useMultiFileAuthState } = require("@whiskeysockets/baileys");

/* ===== Constantes / Rutas ===== */
const PORT = process.env.PORT || 3000;
const AUTH_DIR = process.env.AUTH_DIR || path.join(__dirname, "data", "auth");
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(__dirname, "data", "uploads");
const PUBLIC_DIR = path.join(__dirname, "public");
const CONFIG_PATH = path.join(__dirname, "config.json");

/* ===== Helpers de archivos/dirs ===== */
function ensureDir(p) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}
ensureDir(AUTH_DIR);
ensureDir(UPLOAD_DIR);
ensureDir(PUBLIC_DIR);

/* ===== Cargar/guardar config ===== */
function loadConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    fs.writeFileSync(
      CONFIG_PATH,
      JSON.stringify(
        {
          admins: [],
          images: { saludo: "", qr: "", references: [] },
          texts: {
            greeting:
              "Hola, soy *Samantha*. Estoy aquí para ayudarte a elegir el plan perfecto, resolver dudas y acompañarte en todo el proceso ✨",
            menu: [
              "1. 💲 Ver productos y precios irresistibles.",
              "2. 💎 ¿Qué es ChatGPT PLUS?",
              "3. 🖼️ Ver referencias.",
              "4. 🤝 Conectar con un vendedor.",
              "5. 💳 Ir a pagar",
              "8. 🔁 Volver al menú",
            ],
            productIntro: "Estos son nuestros planes disponibles en tu país:",
          },
          currencySymbols: { BOB: "Bs", ARS: "$", MXN: "$", PEN: "S/", USD: "$", EUR: "€" },
          countries: {},
        },
        null,
        2
      )
    );
  }
  return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
}
function saveConfig(cfg) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
}

/* ===== Estado del bot por usuario ===== */
// Map<jid, { countryKey: string|null, lastPromptTs?: number }>
const userState = new Map();

/* ===== Express ===== */
const app = express();
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(
  session({
    secret: process.env.SESSION_SECRET || "secret",
    resave: false,
    saveUninitialized: false,
  })
);
app.use(express.static(PUBLIC_DIR));
app.use("/media", express.static(UPLOAD_DIR));

/* ===== Auth para panel ===== */
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

/* ===== Admin protegido ===== */
app.get("/admin.html", requireLogin, (req, res) =>
  res.sendFile(path.join(PUBLIC_DIR, "admin.html"))
);

/* ===== API: leer config ===== */
app.get("/api/config", requireLogin, (req, res) => res.json(loadConfig()));

/* ===== API: textos ===== */
app.post("/api/texts", requireLogin, (req, res) => {
  const cfg = loadConfig();
  const { greeting, menu, productIntro } = req.body || {};
  if (typeof greeting === "string") cfg.texts.greeting = greeting;
  if (Array.isArray(menu)) cfg.texts.menu = menu;
  if (typeof productIntro === "string") cfg.texts.productIntro = productIntro;
  saveConfig(cfg);
  res.json({ ok: true });
});

/* ===== API: países ===== */
// listar/buscar
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
// crear/actualizar
app.post("/api/countries", requireLogin, (req, res) => {
  const { key, label, currency, payment, prices } = req.body || {};
  if (!key || !label || !currency)
    return res.status(400).json({ ok: false, error: "key, label y currency son requeridos" });
  const cfg = loadConfig();
  cfg.countries[key.toLowerCase()] = {
    label,
    currency,
    payment: {
      bank: payment?.bank || "",
      account: payment?.account || "",
      owner: payment?.owner || "",
      qr: payment?.qr || "",
    },
    prices: prices || { shared1: {}, shared2: {}, individual: {} },
  };
  saveConfig(cfg);
  res.json({ ok: true });
});
// eliminar
app.delete("/api/countries/:key", requireLogin, (req, res) => {
  const cfg = loadConfig();
  const k = req.params.key.toLowerCase();
  if (!cfg.countries[k]) return res.status(404).json({ ok: false, error: "No existe" });
  delete cfg.countries[k];
  saveConfig(cfg);
  res.json({ ok: true });
});

/* ===== API: subida de imágenes ===== */
const upload = multer({ dest: UPLOAD_DIR });
app.post("/api/upload", requireLogin, upload.single("file"), (req, res) => {
  if (!req.file) return res.status(400).json({ ok: false, error: "Sin archivo" });
  const ext = path.extname(req.file.originalname) || ".jpg";
  const finalName = req.file.filename + ext;
  const finalPath = path.join(UPLOAD_DIR, finalName);
  fs.renameSync(req.file.path, finalPath);
  const rel = "/media/" + finalName; // ruta pública
  res.json({ ok: true, path: rel });
});

/* ===== API: asignar imágenes en config ===== */
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

/* ===== BOT ===== */
let sock;

async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);

  // sin printQRInTerminal (deprecado)
  sock = makeWASocket({ auth: state });
  sock.ev.on("creds.update", saveCreds);

  // Mostrar/guardar QR
  sock.ev.on("connection.update", async (update) => {
    const { qr, connection, lastDisconnect } = update;

    if (qr) {
      // terminal (local)
      qrcodeTerminal.generate(qr, { small: true });
      // PNG en /public/qr.png (útil para Render)
      try {
        const dataUrl = await QRCode.toDataURL(q);
        const base64 = dataUrl.replace(/^data:image\/png;base64,/, "");
        fs.writeFileSync(path.join(PUBLIC_DIR, "qr.png"), base64, "base64");
        console.log("QR disponible en /qr.png");
      } catch (e) {
        console.error("Error guardando QR:", e);
      }
    }

    if (connection === "open") console.log("✅ Conectado a WhatsApp");
    if (connection === "close") {
      const code = lastDisconnect?.error?.output?.statusCode || "";
      console.log("Conexión cerrada", code);
      setTimeout(startBot, 3000);
    }
  });

  // Mensajes
  sock.ev.on("messages.upsert", async ({ messages }) => {
    const m = messages?.[0];
    if (!m) return;
    const from = m.key?.remoteJid;
    const text = (m.message?.conversation || m.message?.extendedTextMessage?.text || "").trim();
    if (!from || !text) return;

    const cfg = loadConfig();
    let stateU = userState.get(from) || { countryKey: null, lastPromptTs: 0 };

    // si no hay país elegido
    if (!stateU.countryKey) {
      // si envía número válido -> guardar país y mandar menú
      const keys = Object.keys(cfg.countries);
      const n = parseInt(text, 10);
      if (Number.isInteger(n) && n >= 1 && n <= keys.length) {
        stateU.countryKey = keys[n - 1];
        userState.set(from, stateU);
        const menuText = cfg.texts.menu.join("\n");
        await sock.sendMessage(from, {
          text: `¡Listo! Guardé tu país ✅\n\n${cfg.texts.greeting}\n\n${menuText}`,
        });
        return;
      }
      // evitar spam del prompt (cooldown 15s)
      const now = Date.now();
      if (now - (stateU.lastPromptTs || 0) > 15000) {
        const list = Object.entries(cfg.countries).map(
          ([, v], i) => `• *${i + 1}* ${v.label}`
        );
        const prompt = ["Hola… soy *Samantha*.", "", "Indica tu país (solo una vez):", ...list].join(
          "\n"
        );
        await sock.sendMessage(from, { text: prompt });
        stateU.lastPromptTs = now;
        userState.set(from, stateU);
      }
      return;
    }

    // Ya tiene país -> handlers
    const country = cfg.countries[stateU.countryKey];
    const symbol = (country && cfg.currencySymbols[country.currency]) || country?.currency || "";

    // 8: volver al menú en cualquier momento
    if (text === "8") {
      const menuText = cfg.texts.menu.join("\n");
      await sock.sendMessage(from, { text: `${cfg.texts.greeting}\n\n${menuText}` });
      return;
    }

    // 5: ir a pagar (siempre disponible)
    if (text === "5") {
      const pay = country?.payment || {};
      const payMsg = [
        "*Pago*",
        `Banco: ${pay.bank || "-"}`,
        `Cuenta: ${pay.account || "-"}`,
        `Titular: ${pay.owner || "-"}`,
        `Moneda: ${country?.currency || "-"}` + (symbol ? ` (${symbol})` : ""),
        pay.qr ? "Te envío el QR a continuación." : "",
      ].join("\n");
      await sock.sendMessage(from, { text: payMsg });
      if (pay.qr) await sock.sendMessage(from, { image: { url: pay.qr }, caption: "QR de pago" });
      return;
    }

    // 1: productos y precios
    if (text === "1") {
      if (!country) {
        // seguridad: si algo se borró, forzar a elegir de nuevo
        userState.set(from, { countryKey: null, lastPromptTs: 0 });
        await sock.sendMessage(from, { text: "Debes seleccionar tu país nuevamente." });
        return;
      }
      const lines = [cfg.texts.productIntro, ""];
      const block = (titulo, obj) => {
        const ks = Object.keys(obj || {});
        if (!ks.length) return;
        lines.push(`*${titulo}*`);
        ks.forEach((k) => lines.push(`• ${k}: ${obj[k]} ${symbol}`));
        lines.push("");
      };
      block("Plan Compartido 1", country.prices?.shared1);
      block("Plan Compartido 2", country.prices?.shared2);
      block("Plan Individual", country.prices?.individual);

      // añadir atajos globales
      lines.push("5. 💳 Ir a pagar");
      lines.push("8. 🔁 Volver al menú");

      await sock.sendMessage(from, { text: lines.join("\n") });
      return;
    }

    if (text === "2") {
      await sock.sendMessage(from, {
        text:
          "ChatGPT PLUS te ofrece más velocidad, mejores respuestas y herramientas extra.",
      });
      // atajos
      await sock.sendMessage(from, { text: "5. 💳 Ir a pagar\n8. 🔁 Volver al menú" });
      return;
    }

    if (text === "3") {
      const refs = cfg.images.references || [];
      if (!refs.length) {
        await sock.sendMessage(from, { text: "Por ahora no hay referencias cargadas." });
      } else {
        for (const r of refs) await sock.sendMessage(from, { image: { url: r } });
      }
      await sock.sendMessage(from, { text: "5. 💳 Ir a pagar\n8. 🔁 Volver al menú" });
      return;
    }

    if (text === "4") {
      const admins = cfg.admins || [];
      const join = admins.map((a) => `• ${a}`).join("\n");
      await sock.sendMessage(from, {
        text: `Te conecto con un vendedor:\n${join || "No hay vendedores configurados."}`,
      });
      await sock.sendMessage(from, { text: "5. 💳 Ir a pagar\n8. 🔁 Volver al menú" });
      return;
    }

    // Fallback: muestra menú otra vez
    const menuText = cfg.texts.menu.join("\n");
    await sock.sendMessage(from, { text: `${cfg.texts.greeting}\n\n${menuText}` });
  });
}

startBot().catch((e) => console.error("Fallo al iniciar bot:", e));

/* ===== HTTP listen ===== */
app.listen(PORT, () =>
  console.log(`Panel admin y QR: http://localhost:${PORT}/login.html  |  /qr.png`)
);