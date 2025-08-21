"use strict";

/* ===== Core ===== */
const fs = require("fs");
const path = require("path");
const express = require("express");
const session = require("express-session");
const bodyParser = require("body-parser");
const multer = require("multer");
const qrcode = require("qrcode");
require("dotenv").config();

/* ===== Baileys ===== */
const {
  makeWASocket,
  useMultiFileAuthState,
  Browsers
} = require("@whiskeysockets/baileys");

/* ===== Constantes / Paths ===== */
const PORT = process.env.PORT || 3000;

// Carpeta escribible para PNG en cualquier hosting (Render recomienda /tmp)
const TMP_DIR = process.env.TMP_DIR || "/tmp";
const LOCAL_UPLOADS = path.join(process.cwd(), "uploads");
const QR_PATH =
  (fs.existsSync(TMP_DIR) ? path.join(TMP_DIR, "qr-login.png")
                          : path.join(LOCAL_UPLOADS, "qr-login.png"));

const AUTH_DIR = process.env.AUTH_DIR || path.join(process.cwd(), "data", "auth");
const CONFIG_PATH = path.join(process.cwd(), "config.json");

// Helpers dirs
function ensureDir(p) { if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true }); }
ensureDir(path.dirname(CONFIG_PATH));
ensureDir(path.dirname(QR_PATH));
ensureDir(AUTH_DIR);

// Config load/save
function loadConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    fs.writeFileSync(
      CONFIG_PATH,
      JSON.stringify({
        admins: [],
        images: { saludo: "", qr: "", references: [] },
        texts: {
          greeting: "Hola, soy *Samantha*. Estoy aquí para ayudarte ✨",
          productIntro: "Estos son nuestros planes disponibles en tu país:",
          menu: [
            "1. 💲 Ver productos y precios irresistibles.",
            "2. 💎 ¿Qué es ChatGPT PLUS?",
            "3. 🖼️ Ver referencias.",
            "4. 🤝 Conectar con un vendedor.",
            "5. 💳 Ir a pagar",
            "8. 🔁 Volver al menú"
          ]
        },
        currencySymbols: { BOB: "Bs", ARS: "$", MXN: "$", PEN: "S/", USD: "$", EUR: "€" },
        countries: {
          bolivia: {
            label: "Bolivia",
            currency: "BOB",
            payment: { bank: "", account: "", owner: "", qr: "" },
            prices: {
              shared1: { "1 mes": 35, "2 meses": 60, "6 meses": 169, "1 año": 329 },
              shared2: { "1 mes": 60, "2 meses": 109, "6 meses": 309 },
              individual: { "1 mes": 139, "2 meses": 269, "6 meses": 599, "1 año": 1579 }
            }
          }
        }
      }, null, 2)
    );
  }
  return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
}
function saveConfig(cfg) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
}

/* ===== Estado de usuarios ===== */
const userState = new Map(); // {jid -> {countryKey}}

/* ===== Express ===== */
const app = express();
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(session({
  secret: process.env.SESSION_SECRET || "supersecreto",
  resave: false,
  saveUninitialized: false
}));

// Servir /public si existe
const PUBLIC_DIR = path.join(process.cwd(), "public");
if (fs.existsSync(PUBLIC_DIR)) {
  app.use(express.static(PUBLIC_DIR));
}

// Acceso estático a /media si existiera uploads local
if (fs.existsSync(LOCAL_UPLOADS)) app.use("/media", express.static(LOCAL_UPLOADS));
if (fs.existsSync(TMP_DIR)) app.use("/tmp", express.static(TMP_DIR));

/* ===== Vistas mínimas inline (por si el host no sirve /public) ===== */
const loginHTML = `<!doctype html><meta charset="utf-8">
<title>Login</title>
<style>body{font-family:system-ui;background:#0b1220;color:#e8eefc;display:flex;align-items:center;justify-content:center;height:100vh;margin:0}
.card{background:#111a2b;border:1px solid #1c2a46;border-radius:16px;padding:28px;width:360px;box-shadow:0 10px 30px #0006}
input{width:100%;margin:8px 0;padding:12px;border-radius:10px;border:1px solid #2a3b5f;background:#0f172a;color:#e8eefc}
button{width:100%;padding:12px;border-radius:10px;border:0;background:#2563eb;color:white;font-weight:600;cursor:pointer}</style>
<div class="card">
  <h2>Acceder</h2>
  <input id="user" placeholder="Usuario">
  <input id="pass" placeholder="Contraseña" type="password">
  <button id="go">Entrar</button>
  <div id="msg" style="color:#ffb4b4;margin-top:8px"></div>
</div>
<script>
  document.getElementById('go').onclick = async () => {
    const user = document.getElementById('user').value.trim();
    const pass = document.getElementById('pass').value.trim();
    const r = await fetch('/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({user,pass})});
    if(r.ok) location.href='/admin'; else document.getElementById('msg').textContent='Credenciales inválidas';
  };
</script>`;

const adminHTML = `<!doctype html><meta charset="utf-8"><title>Admin</title>
<div style="font-family:system-ui;padding:20px">
  <h2>Panel</h2>
  <p>Si ves esto es la versión inline. Si además tienes <code>public/admin.html</code>, también funcionará.</p>
  <p><a href="/qr" target="_blank">Ver QR</a> | <a href="/api/logout">Salir</a></p>
</div>`;

/* ===== Auth middleware ===== */
function requireLogin(req, res, next) {
  if (req.session && req.session.logged) return next();
  // intentar servir /public/login.html; si no existe, HTML inline
  const file = path.join(PUBLIC_DIR, "login.html");
  if (fs.existsSync(file)) return res.sendFile(file);
  return res.send(loginHTML);
}

/* ===== Rutas web ===== */
app.get("/", (req, res) => res.redirect("/login"));
app.get("/login", (req, res) => {
  const file = path.join(PUBLIC_DIR, "login.html");
  if (fs.existsSync(file)) return res.sendFile(file);
  res.send(loginHTML);
});
app.get("/admin", requireLogin, (req, res) => {
  const file = path.join(PUBLIC_DIR, "admin.html");
  if (fs.existsSync(file)) return res.sendFile(file);
  res.send(adminHTML);
});

/* ===== API auth ===== */
app.post("/api/login", (req, res) => {
  const { user, pass } = req.body || {};
  const U = process.env.ADMIN_USER || "admin";
  const P = process.env.ADMIN_PASS || "1234";
  if (user === U && pass === P) {
    req.session.logged = true;
    return res.json({ ok: true });
  }
  res.status(401).json({ ok: false, error: "Credenciales inválidas" });
});
app.get("/api/logout", (req, res) => {
  req.session.destroy(() => res.redirect("/login"));
});

/* ===== API config ===== */
app.get("/api/config", requireLogin, (req, res) => res.json(loadConfig()));

/* ===== Upload (por si quieres usar desde admin) ===== */
const storage = multer.diskStorage({
  destination: (_, __, cb) => cb(null, fs.existsSync(TMP_DIR) ? TMP_DIR : LOCAL_UPLOADS),
  filename: (_, file, cb) => cb(null, Date.now() + path.extname(file.originalname || ".jpg"))
});
const upload = multer({ storage });
app.post("/api/upload", requireLogin, upload.single("file"), (req, res) => {
  if (!req.file) return res.status(400).json({ ok: false, error: "Sin archivo" });
  const publicPath = fs.existsSync(TMP_DIR) ? `/tmp/${req.file.filename}` : `/media/${req.file.filename}`;
  res.json({ ok: true, path: publicPath });
});

/* ===== QR como PNG y link ===== */
app.get("/qr", async (_req, res) => {
  if (fs.existsSync(QR_PATH)) return res.sendFile(QR_PATH);
  res.status(404).send("QR no disponible aún. Espera unos segundos y recarga.");
});

/* ===== BOT ===== */
let sock;
async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  sock = makeWASocket({
    auth: state,
    browser: Browsers.appropriate("Desktop"),
    printQRInTerminal: false // no dibujar bloques en logs
  });

  sock.ev.on("creds.update", saveCreds);

  // Cuando Baileys emite un QR, lo convertimos a PNG y lo guardamos en QR_PATH
  sock.ev.on("connection.update", async (u) => {
    try {
      if (u.qr) {
        await qrcode.toFile(QR_PATH, u.qr, { width: 420 });
        console.log("QR listo como PNG en:", QR_PATH);
      }
      if (u.connection === "open") {
        console.log("✅ Conectado a WhatsApp");
      }
    } catch (e) {
      console.error("Error generando QR:", e);
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
    let st = userState.get(from) || { countryKey: null };

    // Si no tiene país, pedirlo y guardarlo
    if (!st.countryKey) {
      const list = Object.entries(cfg.countries).map(([k, v], i) => `• *${i + 1}* ${v.label}`);
      const n = parseInt(text, 10);
      if (Number.isInteger(n) && n >= 1 && n <= list.length) {
        const chosen = Object.keys(cfg.countries)[n - 1];
        st.countryKey = chosen;
        userState.set(from, st);
        const menuText = cfg.texts.menu.join("\n");
        await sock.sendMessage(from, { text: `¡Listo! Guardé tu país ✅\n\n${cfg.texts.greeting}\n\n${menuText}` });
        return;
      }
      const prompt = ["Hola… soy *Samantha*.", "", "Indica tu país (solo una vez):", ...list].join("\n");
      await sock.sendMessage(from, { text: prompt });
      return;
    }

    // Con país definido, manejar menú
    if (text === "8") {
      const menuText = cfg.texts.menu.join("\n");
      await sock.sendMessage(from, { text: `${cfg.texts.greeting}\n\n${menuText}` });
      return;
    }

    if (text === "1") {
      const c = cfg.countries[st.countryKey];
      const symbol = cfg.currencySymbols[c.currency] || c.currency;
      const lines = [cfg.texts.productIntro, ""];
      const block = (title, obj) => {
        const keys = Object.keys(obj || {});
        if (!keys.length) return;
        lines.push(`*${title}*`);
        keys.forEach(k => lines.push(`• ${k}: ${obj[k]} ${symbol}`));
        lines.push("");
      };
      block("📦 Planes Compartidos (1 dispositivo)", c.prices.shared1);
      block("📦 Planes Compartidos (2 dispositivos)", c.prices.shared2);
      block("🧑‍💻 Planes Individuales", c.prices.individual);
      lines.push("5. 💳 Ir a pagar");
      lines.push("8. 🔁 Volver al menú");
      await sock.sendMessage(from, { text: lines.join("\n") });
      return;
    }

    if (text === "5") {
      const c = cfg.countries[st.countryKey];
      const pay = c.payment || {};
      const symbol = cfg.currencySymbols[c.currency] || c.currency;
      const msg = [
        "*Pago*",
        `Banco: ${pay.bank || "-"}`,
        `Cuenta: ${pay.account || "-"}`,
        `Titular: ${pay.owner || "-"}`,
        `Moneda: ${c.currency} (${symbol})`,
        pay.qr ? "Te envío el QR a continuación." : ""
      ].join("\n");
      await sock.sendMessage(from, { text: msg });
      if (pay.qr) await sock.sendMessage(from, { image: { url: pay.qr }, caption: "QR de pago" });
      return;
    }

    if (text === "2") {
      await sock.sendMessage(from, { text: "ChatGPT PLUS te ofrece más velocidad, mejores respuestas y herramientas extra." });
      await sock.sendMessage(from, { text: "8. 🔁 Volver al menú\n5. 💳 Ir a pagar" });
      return;
    }

    if (text === "3") {
      const refs = cfg.images.references || [];
      if (!refs.length) {
        await sock.sendMessage(from, { text: "Por ahora no hay referencias cargadas.\n\n8. 🔁 Volver al menú\n5. 💳 Ir a pagar" });
        return;
      }
      for (const r of refs) await sock.sendMessage(from, { image: { url: r } });
      await sock.sendMessage(from, { text: "8. 🔁 Volver al menú\n5. 💳 Ir a pagar" });
      return;
    }

    if (text === "4") {
      const admins = cfg.admins || [];
      const join = admins.map(a => `• ${a}`).join("\n");
      await sock.sendMessage(from, { text: `Te conecto con un vendedor:\n${join || "No hay vendedores configurados."}\n\n8. 🔁 Volver al menú\n5. 💳 Ir a pagar` });
      return;
    }

    // fallback
    const menuText = cfg.texts.menu.join("\n");
    await sock.sendMessage(from, { text: `${cfg.texts.greeting}\n\n${menuText}` });
  });
}

startBot().catch(err => console.error("Error iniciando bot:", err));

/* ===== HTTP listen ===== */
app.listen(PORT, () => {
  console.log(`HTTP OK en :${PORT}`);
  console.log("Login:", "/login  |  Admin:", "/admin  |  QR:", "/qr");
});