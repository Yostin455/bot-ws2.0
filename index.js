"use strict";

/* ===== Core / Libs ===== */
const fs = require("fs");
const path = require("path");
const express = require("express");
const session = require("express-session");
const bodyParser = require("body-parser");
const multer = require("multer");
const qrcode = require("qrcode");
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
ensureDir(path.dirname(CONFIG_PATH));
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
          texts: {
            greeting:
              "Hola, soy *Samantha*. Estoy aquí para ayudarte a elegir el plan perfecto, resolver dudas y acompañarte en todo el proceso ✨",
            menu: [
              "1. 💲 Ver productos y precios irresistibles.",
              "2. 💎 ¿Qué es ChatGPT PLUS?",
              "3. 🖼️ Ver referencias.",
              "4. 🤝 Conectar con un vendedor.",
              "5. 💳 Ir a pagar",
              "8. 🔁 Volver al menú"
            ],
            productIntro: "Estos son nuestros planes disponibles en tu país:"
          },
          currencySymbols: { BOB: "Bs", ARS: "ARS", MXN: "$", PEN: "S/", USD: "$", EUR: "€" },
          countries: {
            bolivia: {
              label: "Bolivia",
              currency: "BOB",
              payment: { bank: "Banco Unión", account: "CTA 123456", owner: "Titular Ejemplo", qr: "" },
              prices: {
                shared1: { "1 mes": 35, "2 meses": 60, "6 meses": 169, "1 año": 329 },
                shared2: { "1 mes": 60, "2 meses": 109, "6 meses": 309 },
                individual: { "1 mes": 139, "2 meses": 269, "6 meses": 599, "1 año": 1579 }
              }
            },
            argentina: {
              label: "Argentina",
              currency: "ARS",
              payment: { bank: "Banco Nación", account: "CBU/ALIAS 000-111", owner: "Titular AR", qr: "" },
              prices: {
                shared1: { "1 mes": 3500, "2 meses": 6000 },
                shared2: { "1 mes": 6000, "2 meses": 10900 },
                individual: { "1 mes": 13900, "2 meses": 26900 }
              }
            },
            mexico: {
              label: "México",
              currency: "MXN",
              payment: { bank: "BBVA", account: "CLABE 012...", owner: "Titular MX", qr: "" },
              prices: {
                shared1: { "1 mes": 100, "2 meses": 180 },
                shared2: { "1 mes": 180, "2 meses": 340 },
                individual: { "1 mes": 550, "2 meses": 990 }
              }
            }
          }
        },
        null,
        2
      )
    );
  }
  return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
}
function saveConfig(conf) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(conf, null, 2));
}

/* ===== Estado del bot ===== */
const userState = new Map(); // key: jid, value: { countryKey }
const lastPromptTime = new Map(); // evita spam del prompt de país

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
  return res.redirect("/login.html");
}

/* ===== Login / Logout ===== */
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

/* ===== API config/textos ===== */
app.get("/api/config", requireLogin, (req, res) => res.json(loadConfig()));

app.post("/api/texts", requireLogin, (req, res) => {
  const cfg = loadConfig();
  const { greeting, menu, productIntro } = req.body;
  if (typeof greeting === "string") cfg.texts.greeting = greeting;
  if (Array.isArray(menu)) cfg.texts.menu = menu;
  if (typeof productIntro === "string") cfg.texts.productIntro = productIntro;
  saveConfig(cfg);
  res.json({ ok: true });
});

/* ===== API países ===== */
app.get("/api/countries", requireLogin, (req, res) => {
  const cfg = loadConfig();
  const q = (req.query.q || "").toString().toLowerCase();
  const entries = Object.entries(cfg.countries).map(([key, data]) => ({ key, ...data }));
  const filtered = q
    ? entries.filter(
        (e) =>
          e.key.includes(q) ||
          (e.label || "").toLowerCase().includes(q) ||
          (e.currency || "").toLowerCase().includes(q)
      )
    : entries;
  res.json({ ok: true, items: filtered });
});

app.post("/api/countries", requireLogin, (req, res) => {
  const cfg = loadConfig();
  const { key, label, currency, payment, prices } = req.body || {};
  if (!key || !label || !currency) return res.status(400).json({ ok: false, error: "key, label, currency requeridos" });
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

/* ===== Guardar paths de imágenes a config ===== */
app.post("/api/images", requireLogin, (req, res) => {
  const { field, value } = req.body;
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

/* ===== Rutas limpias y estáticas ===== */
app.get("/", (req, res) => res.redirect("/login.html"));
app.get("/login", (req, res) => res.sendFile(path.join(__dirname, "public", "login.html")));
app.get("/admin", requireLogin, (req, res) => res.sendFile(path.join(__dirname, "public", "admin.html")));

/* ===== QR como PNG ===== */
app.get("/qr", (req, res) => {
  const qrPath = path.join(UPLOAD_DIR, "qr-login.png");
  if (fs.existsSync(qrPath)) return res.sendFile(qrPath);
  return res.status(404).send("QR no disponible. Revisa los logs.");
});

/* ===== BOT ===== */
let sock;
async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  sock = makeWASocket({
    auth: state,
    printQRInTerminal: false, // no en terminal, lo convertimos a PNG
    browser: ["BotWS", "Chrome", "120"]
  });

  sock.ev.on("creds.update", saveCreds);

  // Generar PNG al recibir QR
  sock.ev.on("connection.update", async (update) => {
    const { qr, connection } = update || {};
    if (qr) {
      const qrPath = path.join(UPLOAD_DIR, "qr-login.png");
      try {
        await qrcode.toFile(qrPath, qr, { type: "png", margin: 1, width: 512 });
        console.log("QR listo como PNG en:", qrPath);
        console.log("LINK público:", "/qr"); // en Render: https://TU-APP.onrender.com/qr
      } catch (e) {
        console.error("Error al crear QR:", e);
      }
    }
    if (connection === "open") {
      // conectado: borro QR para no confundir
      const qrPath = path.join(UPLOAD_DIR, "qr-login.png");
      if (fs.existsSync(qrPath)) fs.unlinkSync(qrPath);
      console.log("✅ Bot conectado a WA");
    }
  });

  // Lógica de mensajes (menú + país)
  sock.ev.on("messages.upsert", async ({ messages }) => {
    const m = messages?.[0];
    if (!m || !m.key?.remoteJid) return;
    const from = m.key.remoteJid;
    const text =
      m.message?.conversation ||
      m.message?.extendedTextMessage?.text ||
      m.message?.imageMessage?.caption ||
      "";
    const t = text.trim();

    const cfg = loadConfig();

    // estado actual
    let st = userState.get(from) || { countryKey: null };

    // Si no tiene país → pedir una sola vez cada 25s
    if (!st.countryKey) {
      const now = Date.now();
      const last = lastPromptTime.get(from) || 0;
      const list = Object.entries(cfg.countries).map(([k, v], i) => `• *${i + 1}* ${v.label}`);
      const n = parseInt(t, 10);

      if (Number.isInteger(n) && n >= 1 && n <= list.length) {
        const chosen = Object.keys(cfg.countries)[n - 1];
        st.countryKey = chosen;
        userState.set(from, st);

        const menuText = cfg.texts.menu.join("\n");
        await sock.sendMessage(from, {
          text: `¡Listo! Guardé tu país ✅\n\n${cfg.texts.greeting}\n\n${menuText}`
        });
        return;
      }

      if (now - last > 25000) {
        lastPromptTime.set(from, now);
        const prompt = ["Hola… soy *Samantha*.", "", "Indica tu país (solo una vez):", ...list].join(
          "\n"
        );
        await sock.sendMessage(from, { text: prompt });
      }
      return;
    }

    // Menú
    if (t === "8") {
      const menuText = cfg.texts.menu.join("\n");
      await sock.sendMessage(from, { text: `${cfg.texts.greeting}\n\n${menuText}` });
      return;
    }

    if (t === "1") {
      const c = cfg.countries[st.countryKey];
      const symbol = cfg.currencySymbols[c.currency] || c.currency;
      const lines = [cfg.texts.productIntro, ""];
      const block = (title, obj) => {
        const keys = Object.keys(obj || {});
        if (!keys.length) return;
        lines.push(`*${title}*`);
        keys.forEach((k) => lines.push(`• ${k}: ${obj[k]} ${symbol}`));
        lines.push("");
      };
      block("📦 Planes Compartidos (1 dispositivo):", c.prices.shared1);
      block("📦 Planes Compartidos (2 dispositivos):", c.prices.shared2);
      block("👤 Planes Individuales:", c.prices.individual);
      // añadir opciones fijas
      lines.push("5. 💳 Ir a pagar");
      lines.push("8. 🔁 Volver al menú");
      await sock.sendMessage(from, { text: lines.join("\n") });
      return;
    }

    if (t === "5") {
      const c = cfg.countries[st.countryKey];
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
      // retorno de opciones
      await sock.sendMessage(from, { text: "8. 🔁 Volver al menú" });
      return;
    }

    if (t === "2") {
      await sock.sendMessage(from, {
        text:
          "Soy yo otra vez… *Samantha*. Esto puedo hacer contigo con *ChatGPT Plus*:\n\n🎨 Imágenes ilimitadas\n📎 Analizo PDF, Word, Excel, PowerPoint\n🧾 Informes, CV, cartas\n📊 Excel con análisis\n💻 Programación\n💬 Asistente 24/7\n🌍 Traducciones\n🎞️ Videos automáticos con SORA\n\n8. 🔁 Volver al menú"
      });
      return;
    }

    if (t === "3") {
      const refs = cfg.images.references || [];
      if (!refs.length) {
        await sock.sendMessage(from, { text: "Por ahora no hay referencias cargadas.\n\n8. 🔁 Volver al menú" });
        return;
      }
      for (const r of refs) await sock.sendMessage(from, { image: { url: r } });
      await sock.sendMessage(from, { text: "8. 🔁 Volver al menú" });
      return;
    }

    if (t === "4") {
      const admins = cfg.admins || [];
      const join = admins.map((a) => `• ${a}`).join("\n");
      await sock.sendMessage(from, {
        text: `Te conecto con un vendedor:\n${join || "No hay vendedores configurados."}\n\n8. 🔁 Volver al menú`
      });
      return;
    }

    // Fallback → re-mostrar menú
    const menuText = cfg.texts.menu.join("\n");
    await sock.sendMessage(from, { text: `${cfg.texts.greeting}\n\n${menuText}` });
  });
}

startBot().catch((e) => console.error("Fallo al iniciar bot:", e));

/* ===== HTTP listen ===== */
app.listen(PORT, () => {
  console.log(`Panel/Login: http://localhost:${PORT}/login.html`);
  console.log(`QR (si hay): http://localhost:${PORT}/qr`);
});

/* ===== 404 por defecto ===== */
app.use((req, res) => res.status(404).send("Ruta no encontrada"));