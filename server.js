require("dotenv").config();
const express  = require("express");
const cors     = require("cors");
const path     = require("path");
const fs       = require("fs");
const fetch    = require("node-fetch");

const app  = express();
const PORT = parseInt(process.env.PORT || "8080", 10);

const FUSION_BASE    = "https://fusiondms.com.br";
const FUSION_USUARIO = process.env.FUSION_USUARIO || "cdaalimentos.monitoramento";
const FUSION_SENHA   = process.env.FUSION_SENHA   || "Cdamonitoramento3744";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "cda2024";
const COOKIE_FILE    = "./fusion_cookie.txt";
const AWSALB_FIXO    = "NVrK670Kruqv5XQ7P8LWy2HLv1PbD2G47s8tGkjo6/oGReO0SNWCadN2DJYQj1aJvVXgxsq2RV58xYlw8+3ST9c4UMNUWnJd2khHksz9jg4B2dGib12qx4qPMA9T";

// ─── COOKIE ──────────────────────────────────────────────────────────────────
function lerCookie() {
  try { if (fs.existsSync(COOKIE_FILE)) return fs.readFileSync(COOKIE_FILE,"utf8").trim(); } catch(_) {}
  return `PHPSESSID=; AWSALB=${AWSALB_FIXO}; AWSALBCORS=${AWSALB_FIXO}`;
}
function salvarCookie(raw) {
  let c = raw.trim();
  if (!c.includes("AWSALB=")) c += `; AWSALB=${AWSALB_FIXO}; AWSALBCORS=${AWSALB_FIXO}`;
  fs.writeFileSync(COOKIE_FILE, c, "utf8");
  console.log("[painel] Cookie salvo.");
}

// ─── CACHE ───────────────────────────────────────────────────────────────────
let _cache = { ts: 0, data: null };
const CACHE_TTL = 5 * 60 * 1000;
function invalidarCache() { _cache.ts = 0; }

// ─── TIPO DE CARGA ───────────────────────────────────────────────────────────
function inferirTipoCarga(destino = "") {
  const d = destino.toUpperCase();
  if (d.includes("FOOD") || d.includes(" FS") || d.includes("FS ") || d === "FS") return "FS";
  if (d.includes("VAREJO") || d.includes("DONANA")) return "VAREJO";
  return "MISTA";
}

// ─── VALE DO AÇO ─────────────────────────────────────────────────────────────
const VALE_ACO_KW = [
  "IPATINGA","TIMOTEO","TIMÓTEO","CIDADE NOBRE","CID.NOBRE","CID. NOBRE",
  "PARAISO","PARAÍSO","BRAUNAS","CORREGO NOVO","CÓRREGO NOVO","C.NOVO",
  "DUVALE","GARCIA","CONSUL","BAKERY","BELO ORIENTE","B.ORIENTE",
  "PADARIA","LUIBAT","MOREIRA","IPABA","IAPU","RIBEIRO","PAMIL","TRINDAD",
];
function isValeAco(destino = "") {
  const d = destino.toUpperCase().normalize("NFD").replace(/[\u0300-\u036f]/g,"");
  return VALE_ACO_KW.some(k => d.includes(k.normalize("NFD").replace(/[\u0300-\u036f]/g,"")));
}

// ─── PARSE ───────────────────────────────────────────────────────────────────
function parseDateTime(str = "") {
  if (!str) return null;
  const m = str.match(/(\d{2})\/(\d{2})\/(\d{4})\s+(\d{2}):(\d{2})/);
  if (!m) return null;
  return new Date(`${m[3]}-${m[2]}-${m[1]}T${m[4]}:${m[5]}:00-03:00`);
}
function parseIso(str = "") {
  if (!str) return null;
  const m = str.match(/(\d{2})\/(\d{2})\/(\d{4})/);
  if (!m) return null;
  return `${m[3]}-${m[2]}-${m[1]}`;
}

// ─── FETCH FUSION ─────────────────────────────────────────────────────────────
async function fusionPost(endpoint, body = {}) {
  const url = `${FUSION_BASE}/php/track/${endpoint}`;
  const resp = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "Cookie": lerCookie(),
      "Referer": `${FUSION_BASE}/html/menus/main.php`,
      "User-Agent": "Mozilla/5.0",
    },
    body: new URLSearchParams(body).toString(),
    timeout: 15000,
  });
  const text = await resp.text();
  if (text.includes("SESSAO_EXPIRADA") || text.includes("sessao_expirada")) throw new Error("SESSAO_EXPIRADA");
  return text;
}

// ─── GESTÃO DE CARGAS ────────────────────────────────────────────────────────
async function getGestaoCargas() {
  const raw = await fusionPost(
    "gestaoromaneio/get_romaneios.php?allStatus=true&acessar_tabela_log=1&tela=3.1", {}
  );
  let rows = [];
  try {
    const p = JSON.parse(raw);
    rows = Array.isArray(p) ? p : (p?.dados || p?.data || []);
  } catch { rows = []; }

  if (rows.length > 0) {
    console.log(`[gestao] ${rows.length} rows | campos: ${Object.keys(rows[0]).join(", ")}`);
  } else {
    console.log("[gestao] ZERO rows — verifique cookie");
  }
  return rows;
}

// ─── MONTA ESCALA ─────────────────────────────────────────────────────────────
async function montarEscala() {
  if (_cache.data && Date.now() - _cache.ts < CACHE_TTL) return _cache.data;

  const rows = await getGestaoCargas();

  // TODAS as cargas — sem filtro de situação
  const cargas = rows.map(r => {
    const erp      = String(r.t10_carga_erp  || r.carga_erp  || "").trim();
    const destino  = String(r.t10_destino     || r.destino    || "").trim() || "--";
    const motorista= String(r.t10_motorista   || r.motorista  || "").trim() || "--";
    const placa    = String(r.t10_placa       || r.placa      || "").trim() || "--";
    const ajudante = String(r.t10_ajudante    || r.ajudante   || "").trim() || null;
    const situacao = String(r.t10_situacao    || r.situacao   || r.status   || "").trim();

    // ── DATA DE SAÍDA: prevista por padrão, real quando existir ──────────────
    const saidaRealStr     = String(r.t10_data_largada        || r.data_largada        || "").trim();
    const saidaPrevistaStr = String(r.t10_data_prevista_saida || r.data_prevista_saida || "").trim();
    const saidaEhPrevista  = !saidaRealStr && !!saidaPrevistaStr;
    const dataSaida        = parseIso(saidaRealStr || saidaPrevistaStr);

    // ── PREVISÃO DE RETORNO ───────────────────────────────────────────────────
    const termDt = parseDateTime(String(r.t10_data_prevista_termino || r.dt_termino_previsto || "").trim());
    let prevRetorno = null, horaRetorno = 14;
    if (termDt) {
      prevRetorno = termDt.toISOString().slice(0,10);
      horaRetorno = (termDt.getUTCHours() - 3 + 24) % 24;
    }

    // ── QUANTIDADES ───────────────────────────────────────────────────────────
    const totalEntregas = parseInt(r.t10_qtd_entregas || r.qtd_entregas || r.total_entregas || 0) || 0;
    const entregues     = parseInt(r.t10_entregues    || r.entregues    || r.entregas_ok    || 0) || 0;
    const devolvidos    = parseInt(r.t10_devolvidos   || r.devolvidos   || 0) || 0;
    const pct           = totalEntregas > 0 ? Math.round((entregues/totalEntregas)*100) : 0;

    return {
      tipoCarga:      inferirTipoCarga(destino),
      tipoVeiculo:    String(r.t10_tipo_veiculo || r.tipo_veiculo || r.veiculo || "").trim() || null,
      carga:          erp || String(r.t10_id_romaneio || r.id_romaneio || "--").trim(),
      situacao,
      destino,
      placa,
      motorista,
      ajudante:       ajudante || null,
      peso:           parseFloat(r.t10_peso_total  || r.peso_total  || r.peso  || 0) || null,
      valorCarga:     parseFloat(r.t10_valor_total || r.valor_total || r.valor || 0) || null,
      qtdEntregas:    totalEntregas,
      entregues,
      devolvidos,
      pct,
      dataSaida,
      saidaEhPrevista,
      prevRetorno,
      horaRetorno,
      distancia:      parseFloat(r.t10_km_previsto || r.km_previsto || 0) || null,
      valeAco:        isValeAco(destino),
    };
  }).filter(c => c.carga !== "--"); // remove linhas sem ERP

  console.log(`[escala] ${cargas.length} cargas montadas`);
  _cache = { ts: Date.now(), data: cargas };
  return cargas;
}

// ─── MIDDLEWARE ───────────────────────────────────────────────────────────────
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, ".")));

// ─── ROTAS ───────────────────────────────────────────────────────────────────
app.get("/api/status", (_req, res) => {
  const c = lerCookie();
  res.json({ ok:true, sessaoAtiva: c.includes("PHPSESSID=") && !c.includes("PHPSESSID=;"), ts: new Date().toISOString(), cacheTs: new Date(_cache.ts).toISOString() });
});

app.post("/api/admin/auth", (req, res) => {
  const { password } = req.body || {};
  if (password === ADMIN_PASSWORD) res.json({ ok: true });
  else res.status(401).json({ ok: false, error: "Senha incorreta." });
});

app.post("/api/admin/cookie", (req, res) => {
  const { password, cookie } = req.body || {};
  if (password !== ADMIN_PASSWORD) return res.status(401).json({ ok:false, error:"Não autorizado." });
  if (!cookie || !cookie.includes("PHPSESSID")) return res.status(400).json({ ok:false, error:"Cookie inválido." });
  salvarCookie(cookie); invalidarCache();
  res.json({ ok:true, msg:"Cookie salvo com sucesso." });
});

app.post("/api/admin/refresh", async (req, res) => {
  const { password } = req.body || {};
  if (password !== ADMIN_PASSWORD) return res.status(401).json({ ok:false, error:"Não autorizado." });
  invalidarCache();
  try {
    const cargas = await montarEscala();
    res.json({ ok:true, total:cargas.length, msg:`${cargas.length} cargas carregadas.` });
  } catch (err) { res.status(500).json({ ok:false, error:err.message }); }
});

app.post("/api/admin/debug", async (req, res) => {
  const { password } = req.body || {};
  if (password !== ADMIN_PASSWORD) return res.status(401).json({ ok:false, error:"Não autorizado." });
  try {
    const rows = await getGestaoCargas();
    res.json({ ok:true, total:rows.length, campos: rows[0] ? Object.keys(rows[0]) : [], amostra: rows.slice(0,2) });
  } catch (err) { res.status(500).json({ ok:false, error:err.message }); }
});

app.get("/api/escala", async (_req, res) => {
  try {
    const cargas = await montarEscala();
    res.json({ ok:true, geradoEm:new Date().toISOString(), total:cargas.length, cargas });
  } catch (err) {
    res.status(500).json({ ok:false, error: err.message.includes("SESSAO") ? "SESSAO_EXPIRADA" : err.message });
  }
});

// ─── KEEPALIVE ────────────────────────────────────────────────────────────────
setInterval(async () => {
  try { await getGestaoCargas(); console.log("[keepalive] OK —", new Date().toLocaleTimeString("pt-BR")); }
  catch (e) { console.log("[keepalive] falhou:", e.message?.slice(0,60)); }
}, 18 * 60 * 1000);

app.listen(PORT, () => console.log(`[Cercal Painel] porta ${PORT}`));
