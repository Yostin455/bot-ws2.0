"use strict";

/* ====== IMPORTS ====== */
const fs = require("fs");
const path = require("path");
const express = require("express");
const session = require("express-session");
const bodyParser = require("body-parser");
const multer = require("multer");
const dotenv = require("dotenv");
const QRCode = require("qrcode");
const qrcodeTerminal = require("qrcode-terminal");
const { makeWASocket, useMultiFileAuthState, Browsers } = require("@whiskeysockets/baileys");
dotenv.config();

/* ====== RUTAS Y CONSTANTES ====== */
const PORT       = process.env.PORT || 3000;
const AUTH_DIR   = process.env.AUTH_DIR   || path.join(__dirname, "data", "auth");
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(__dirname, "data", "uploads");
const CONFIG_PATH = path.join(__dirname, "config.json");
const QR_PNG_PATH = path.join(UPLOAD_DIR, "qr-login.png");

function ensureDir(p){ if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true }); }
ensureDir(AUTH_DIR);
ensureDir(UPLOAD_DIR);

/* ====== CONFIG ====== */
function loadConfig(){
  if (!fs.existsSync(CONFIG_PATH)){
    const blank = {
      admins: [],
      images: { saludo: "", qr: "", references: [] },
      texts: {
        greeting: "Hola, soy *Samantha*. Estoy aquí para ayudarte a elegir el plan perfecto, resolver dudas y acompañarte en todo el proceso ✨",
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
      currencySymbols: { BOB:"Bs", ARS:"ARS", MXN:"$MXN", PEN:"S/", USD:"$", EUR:"€" },
      countries: {
        bolivia: {
          label: "Bolivia", currency: "BOB",
          payment: { bank:"Banco Unión", account:"CTA 123", owner:"Titular BO", qr:"" },
          prices: {
            shared1: { "1 mes":35, "2 meses":60, "6 meses":169, "1 año":329 },
            shared2: { "1 mes":60, "2 meses":109, "6 meses":309 },
            individual: { "1 mes":139, "2 meses":269, "6 meses":599, "1 año":1579 }
          }
        },
        argentina: {
          label: "Argentina", currency:"ARS",
          payment: { bank:"Banco Nación", account:"ALIAS ejemplo", owner:"Titular AR", qr:"" },
          prices: {
            shared1: { "1 mes":3500, "2 meses":6000 },
            shared2: { "1 mes":6000, "2 meses":10900 },
            individual: { "1 mes":13900, "2 meses":26900 }
          }
        },
        mexico: {
          label: "México", currency:"MXN",
          payment: { bank:"BBVA", account:"CLABE 000", owner:"Titular MX", qr:"" },
          prices: {
            shared1: { "1 mes":100, "2 meses":180 },
            shared2: { "1 mes":180, "2 meses":340 },
            individual: { "1 mes":550, "2 meses":990 }
          }
        }
      }
    };
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(blank, null, 2));
  }
  return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
}
function saveConfig(cfg){ fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2)); }

/* ====== ESTADO DEL BOT ====== */
const userState = new Map(); // jid -> { countryKey }

/* ====== EXPRESS ====== */
const app = express();
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended:true }));
app.use(session({
  secret: process.env.SESSION_SECRET || "secret",
  resave:false, saveUninitialized:false
}));

// estáticos
app.use(express.static(path.join(__dirname, "public")));
app.use("/media", express.static(UPLOAD_DIR));

// login requerido
function requireLogin(req, res, next){
  if (req.session && req.session.logged) return next();
  return res.redirect("/login.html");
}

/* ====== LOGIN ====== */
app.post("/api/login", (req,res)=>{
  const { user, pass } = req.body || {};
  const U = process.env.ADMIN_USER || "admin";
  const P = process.env.ADMIN_PASS || "1234";
  if (user===U && pass===P){ req.session.logged = true; return res.json({ok:true}); }
  res.status(401).json({ok:false, error:"Credenciales inválidas"});
});
app.post("/api/logout",(req,res)=>req.session.destroy(()=>res.json({ok:true})));

/* ====== API CONFIG ====== */
app.get("/api/config", requireLogin, (req,res)=>res.json(loadConfig()));

// textos
app.post("/api/texts", requireLogin, (req,res)=>{
  const cfg = loadConfig();
  const { greeting, productIntro, menu } = req.body;
  if (typeof greeting==="string") cfg.texts.greeting = greeting;
  if (typeof productIntro==="string") cfg.texts.productIntro = productIntro;
  if (Array.isArray(menu)) cfg.texts.menu = menu;
  saveConfig(cfg);
  res.json({ok:true});
});

// países
app.get("/api/countries", requireLogin, (req,res)=>{
  const q = (req.query.q||"").toString().toLowerCase();
  const cfg = loadConfig();
  const list = Object.entries(cfg.countries).map(([key,val])=>({key, ...val}));
  const filtered = q ? list.filter(c =>
    c.key.includes(q) || (c.label||"").toLowerCase().includes(q) || (c.currency||"").toLowerCase().includes(q)
  ) : list;
  res.json({ok:true, items:filtered});
});
app.post("/api/countries", requireLogin, (req,res)=>{
  const { key, label, currency, payment, prices } = req.body || {};
  if (!key || !label || !currency) return res.status(400).json({ok:false, error:"key, label, currency son requeridos"});
  const cfg = loadConfig();
  cfg.countries[String(key).toLowerCase()] = {
    label, currency,
    payment: { bank:payment?.bank||"", account:payment?.account||"", owner:payment?.owner||"", qr:payment?.qr||"" },
    prices: prices || { shared1:{}, shared2:{}, individual:{} }
  };
  saveConfig(cfg);
  res.json({ok:true});
});
app.delete("/api/countries/:key", requireLogin, (req,res)=>{
  const cfg = loadConfig();
  const k = req.params.key.toLowerCase();
  if (!cfg.countries[k]) return res.status(404).json({ok:false, error:"No existe"});
  delete cfg.countries[k]; saveConfig(cfg); res.json({ok:true});
});

/* ====== SUBIDAS ====== */
const upload = multer({ dest: UPLOAD_DIR });
app.post("/api/upload", requireLogin, upload.single("file"), (req,res)=>{
  if(!req.file) return res.status(400).json({ok:false, error:"Archivo faltante"});
  const ext = path.extname(req.file.originalname) || ".jpg";
  const final = req.file.filename + ext;
  fs.renameSync(req.file.path, path.join(UPLOAD_DIR, final));
  res.json({ ok:true, path: "/media/"+final });
});
app.post("/api/images", requireLogin, (req,res)=>{
  const { field, value } = req.body || {};
  const cfg = loadConfig();
  if (field==="saludo") cfg.images.saludo = value||"";
  else if (field==="qr") cfg.images.qr = value||"";
  else if (field==="references:add"){ (cfg.images.references ||= []).push(value); }
  else if (field==="references:clear"){ cfg.images.references = []; }
  saveConfig(cfg);
  res.json({ok:true});
});

/* ====== SERVIR ADMIN (protegido) ====== */
app.get("/admin.html", requireLogin, (req,res)=>{
  res.sendFile(path.join(__dirname, "public", "admin.html"));
});

/* ====== QR COMO PNG / LINK ====== */
// (Para Render y local) — visita https://TU-APP.onrender.com/qr
app.get("/qr", (req,res)=>{
  if (fs.existsSync(QR_PNG_PATH)) {
    return res.sendFile(QR_PNG_PATH);
  }
  res.status(404).send("QR no disponible. Espera a que el bot lo genere.");
});

/* ====== BOT WHATSAPP ====== */
let sock;
async function startBot(){
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);

  sock = makeWASocket({
    auth: state,
    browser: Browsers.appropriate("Chrome"),
    printQRInTerminal: false // generamos PNG + link nosotros
  });

  // Generación del QR (PNG + link)
  sock.ev.on("connection.update", async (u)=>{
    const { connection, lastDisconnect, qr } = u;

    if (qr){
      try{
        // 1) PNG en /data/uploads/qr-login.png
        await QRCode.toFile(QR_PNG_PATH, qr, { width: 360, margin: 1 });
        console.log("🖼️ QR guardado:", QR_PNG_PATH);

        // 2) QR en consola (útil en local)
        qrcodeTerminal.generate(qr, { small:true });

        // 3) Link directo (sirve en Render/logs)
        const link = "https://api.qrserver.com/v1/create-qr-code/?size=320x320&data=" + encodeURIComponent(qr);
        console.log("🔗 QR (link):", link);
        console.log("🌐 QR (PNG):  https://TU-APP.onrender.com/qr  (ajusta TU-APP en Render)");
      }catch(e){ console.error("Error guardando QR:", e); }
    }

    if (connection==="close"){
      const code = u?.lastDisconnect?.error?.output?.statusCode || 0;
      console.log("❌ Conexión cerrada:", code);
      if (code === 401){
        console.log("Sesión inválida. Borra /data/auth y vuelve a escanear.");
      } else {
        setTimeout(startBot, 1500);
      }
    } else if (connection==="open"){
      console.log("✅ Conectado a WhatsApp");
    }
  });

  sock.ev.on("creds.update", saveCreds);

  // Manejo de mensajes
  sock.ev.on("messages.upsert", async ({ messages })=>{
    const m = messages?.[0];
    if (!m || !m.message || m.key.fromMe) return;
    const from = m.key.remoteJid;
    if (from.endsWith("@g.us")) return; // ignorar grupos

    // texto recibido
    const text =
      m.message?.conversation ||
      m.message?.extendedTextMessage?.text ||
      m.message?.imageMessage?.caption ||
      m.message?.videoMessage?.caption ||
      "";
    const t = text.trim();

    const cfg = loadConfig();
    let st = userState.get(from) || { countryKey:null };

    // si no tiene país -> pedir una vez hasta que elija
    if (!st.countryKey){
      const entries = Object.entries(cfg.countries);
      const lista = entries.map(([k,v],i)=>`• *${i+1}* ${v.label}`).join("\n");

      const n = parseInt(t, 10);
      if (Number.isInteger(n) && n>=1 && n<=entries.length){
        st.countryKey = entries[n-1][0];
        userState.set(from, st);
        const menu = cfg.texts.menu.join("\n");
        await sock.sendMessage(from, { text: `¡Listo! Guardé tu país ✅\n\n${cfg.texts.greeting}\n\n${menu}` });
        return;
      }

      await sock.sendMessage(from, { text: `Hola… soy *Samantha*.\n\nIndica tu país (solo una vez):\n${lista}` });
      return;
    }

    // Ya tiene país -> opciones
    if (t === "8"){
      const menu = cfg.texts.menu.join("\n");
      await sock.sendMessage(from, { text: `${cfg.texts.greeting}\n\n${menu}` });
      return;
    }

    if (t === "1"){ // productos/precios
      const c = cfg.countries[st.countryKey];
      const symbol = cfg.currencySymbols[c.currency] || c.currency;
      const lines = [cfg.texts.productIntro, ""];
      const block = (title, obj)=>{
        const ks = Object.keys(obj||{});
        if (!ks.length) return;
        lines.push(`*${title}*`);
        ks.forEach(k=>lines.push(`• ${k}: ${obj[k]} ${symbol}`));
        lines.push("");
      };
      block("Planes Compartidos (1 dispositivo)", c.prices.shared1);
      block("Planes Compartidos (2 dispositivos)", c.prices.shared2);
      block("Planes Individuales", c.prices.individual);
      lines.push("5. 💳 Ir a pagar");
      lines.push("8. 🔁 Volver al menú");
      await sock.sendMessage(from, { text: lines.join("\n") });
      return;
    }

    if (t === "2"){
      await sock.sendMessage(from, { text:
        "Soy yo otra vez… *Samantha*. Esto puedo hacer contigo con *ChatGPT Plus*:\n\n" +
        "🎨 Imágenes ilimitadas\n📎 Analizo PDF/Word/Excel/PowerPoint\n📝 Informes, CV, cartas\n" +
        "📊 Excel con análisis\n💻 Programación\n🗣️ Asistente 24/7\n🌍 Traducciones\n🎬 Videos automáticos con SORA\n\n" +
        "5. 💳 Ir a pagar\n8. 🔁 Volver al menú"
      });
      return;
    }

    if (t === "3"){
      const refs = cfg.images.references || [];
      if (!refs.length) { await sock.sendMessage(from, { text: "Por ahora no hay referencias." }); }
      for (const r of refs){ await sock.sendMessage(from, { image: { url:r } }); }
      await sock.sendMessage(from, { text: "5. 💳 Ir a pagar\n8. 🔁 Volver al menú" });
      return;
    }

    if (t === "4"){
      const admins = cfg.admins || [];
      await sock.sendMessage(from, { text: `Te conecto con un vendedor:\n${admins.map(a=>"• "+a).join("\n") || "No configurado."}` });
      return;
    }

    if (t === "5"){ // pagar
      const c = cfg.countries[st.countryKey];
      const pay = c.payment || {};
      const symbol = cfg.currencySymbols[c.currency] || c.currency;
      const msg = [
        "*Pago*",
        `Banco: ${pay.bank || "-"}`,
        `Cuenta: ${pay.account || "-"}`,
        `Titular: ${pay.owner || "-"}`,
        `Moneda: ${c.currency} (${symbol})`,
        pay.qr ? "Te envío el QR a continuación." : "Puedes ver el QR en: /qr"
      ].join("\n");
      await sock.sendMessage(from, { text: msg });
      if (pay.qr) await sock.sendMessage(from, { image: { url: pay.qr }, caption: "QR de pago" });
      return;
    }

    // fallback -> menú
    const menu = cfg.texts.menu.join("\n");
    await sock.sendMessage(from, { text: `${cfg.texts.greeting}\n\n${menu}` });
  });
}

startBot().catch(e=>console.error("Error iniciando bot:", e));

/* ====== HTTP ====== */
app.listen(PORT, ()=>console.log(`✅ Server OK • Panel: http://localhost:${PORT}/login.html  • QR: /qr`));