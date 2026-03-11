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
  try {
    if (fs.existsSync(COOKIE_FILE)) return fs.readFileSync(COOKIE_FILE, "utf8").trim();
  } catch (_) {}
  return `PHPSESSID=; AWSALB=${AWSALB_FIXO}; AWSALBCORS=${AWSALB_FIXO}`;
}

function salvarCookie(raw) {
  let cookie = raw.trim();
  if (!cookie.includes("AWSALB=")) cookie += `; AWSALB=${AWSALB_FIXO}; AWSALBCORS=${AWSALB_FIXO}`;
  fs.writeFileSync(COOKIE_FILE, cookie, "utf8");
  console.log("[painel] Cookie salvo.");
}

// ─── CACHE ───────────────────────────────────────────────────────────────────
let _cache = { ts: 0, data: null };
const CACHE_TTL = 5 * 60 * 1000; // 5 min

function invalidarCache() { _cache.ts = 0; }

// ─── TIPO DE CARGA (derivado do destino) ─────────────────────────────────────
function inferirTipoCarga(destino = "") {
  const d = destino.toUpperCase();
  if (d.includes("FOOD") || d.includes("FS ") || d.includes(" FS") || d === "FS") return "FS";
  if (d.includes("VAREJO") || d.includes("DONANA")) return "VAREJO";
  return "MISTA";
}

// ─── VALE DO AÇO detection ───────────────────────────────────────────────────
const VALE_ACO_KEYWORDS = [
  "IPATINGA","TIMOTEO","TIMÓTEO","CIDADE NOBRE","CID.NOBRE","CID. NOBRE",
  "PARAISO","PARAÍSO","BRAUNAS","BRAUNÃS","CORREGO NOVO","CÓRREGO NOVO",
  "C.NOVO","DUVALE","GARCIA","CONSUL","BAKERY","BELO ORIENTE","B.ORIENTE",
  "PADARIA","LUIBAT","MOREIRA","IPABA","IAPU","RIBEIRO","PAMIL","TRINDAD",
];

function isValeAco(destino = "") {
  const d = destino.toUpperCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  return VALE_ACO_KEYWORDS.some(k => {
    const kn = k.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
    return d.includes(kn);
  });
}

// ─── FETCH FUSION ─────────────────────────────────────────────────────────────
async function fusionPost(endpoint, body = {}) {
  const cookie = lerCookie();
  const url = `${FUSION_BASE}/php/track/${endpoint}`;
  const form = new URLSearchParams(body).toString();
  const resp = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "Cookie": cookie,
      "Referer": `${FUSION_BASE}/html/menus/main.php`,
      "User-Agent": "Mozilla/5.0",
    },
    body: form,
    timeout: 15000,
  });
  const text = await resp.text();
  if (text.includes("login") || text.includes("sessao_expirada") || text.includes("SESSAO_EXPIRADA")) {
    throw new Error("SESSAO_EXPIRADA");
  }
  return text;
}

// ─── CARGAS EM CURSO ─────────────────────────────────────────────────────────
async function getCargasEmCurso() {
  const raw = await fusionPost(
    "monitoraentregas/monitoramento_entregas_v2.php",
    { usuario: FUSION_USUARIO, senha: FUSION_SENHA }
  );
  let parsed;
  try { parsed = JSON.parse(raw); } catch { parsed = []; }
  const lista = Array.isArray(parsed) ? parsed : (parsed?.dados || parsed?.data || []);
  return lista;
}

// ─── GESTÃO DE CARGAS (terminoDt, destino, km) ───────────────────────────────
async function getGestaoCargas() {
  const raw = await fusionPost(
    "gestaoromaneio/get_romaneios.php?allStatus=true&acessar_tabela_log=1&tela=3.1",
    {}
  );
  let rows = [];
  try {
    const p = JSON.parse(raw);
    rows = Array.isArray(p) ? p : (p?.dados || p?.data || []);
  } catch { rows = []; }

  const mapa = {};
  for (const r of rows) {
    const erp = String(r.t10_carga_erp || r.carga_erp || r.erp || "").trim();
    if (!erp || erp === "0") continue;

    const termStr = String(r.t10_data_prevista_termino || r.dt_termino_previsto || "").trim();
    const termDt  = termStr ? parseDateTime(termStr) : null;
    const destino = String(r.t10_destino || r.destino || "").trim();
    const km      = parseFloat(r.t10_km_previsto || r.km_previsto || 0) || null;

    mapa[erp] = { terminoDt: termDt, terminoStr: termStr, destino, kmPrevisto: km };
  }
  return mapa;
}

// ─── PARSE DATETIME ──────────────────────────────────────────────────────────
function parseDateTime(str = "") {
  const m = str.match(/(\d{2})\/(\d{2})\/(\d{4})\s+(\d{2}):(\d{2})/);
  if (!m) return null;
  return new Date(`${m[3]}-${m[2]}-${m[1]}T${m[4]}:${m[5]}:00-03:00`);
}

// ─── MONTA PAYLOAD PRINCIPAL ─────────────────────────────────────────────────
async function montarEscala() {
  if (_cache.data && Date.now() - _cache.ts < CACHE_TTL) return _cache.data;

  const [listaRaw, gestaoMap] = await Promise.all([
    getCargasEmCurso(),
    getGestaoCargas(),
  ]);

  // Normaliza campos do monitoramento
  const emCurso = listaRaw.filter(r => {
    const sit = String(r.situacao || r.status || "").toLowerCase();
    return sit.includes("curso") || sit.includes("em curso");
  });

  const cargas = emCurso.map(c => {
    // ERP
    const idErpRaw = String(c.id_erp || c.idErp || c.carga_erp || "").trim();
    const erp = /^1[0-9]\d{5}$/.test(idErpRaw) ? idErpRaw : "";

    // Dados da gestão
    const g = gestaoMap[erp] || {};

    // Destino (prefere gestão)
    const destino = g.destino || String(c.destino || c.rota || "").trim() || "--";

    // Tipo de carga e Vale do Aço
    const valeAco   = isValeAco(destino);
    const tipoCarga = inferirTipoCarga(destino);

    // Placa / Motorista
    let placa = "", motorista = "";
    const largadaRaw = String(c.largada || c.dados_gerais || c.motorista_placa || "").trim();
    const placaM = largadaRaw.match(/\b([A-Z]{3}\d[A-Z0-9]\d{2}|[A-Z]{3}\d{4})\b/i);
    if (placaM) placa = placaM[1].toUpperCase();
    motorista = String(c.motorista || c.nome_motorista || "").trim() || largadaRaw.split(/[-|]/)[0].trim();

    // Entregas
    const totalEntregas = parseInt(c.total_entregas || c.totalEntregas || c.qtd_entregas || 0);
    const entregues     = parseInt(c.entregues || c.entregas_realizadas || 0);
    const pct           = totalEntregas > 0 ? Math.round((entregues / totalEntregas) * 100) : 0;

    // Datas
    let dataSaida = null;
    const largStr = String(c.data_largada || c.dataLargada || c.dt_saida || "").trim();
    const dsM = largStr.match(/(\d{2})\/(\d{2})\/(\d{4})/);
    if (dsM) dataSaida = `${dsM[3]}-${dsM[2]}-${dsM[1]}`;

    let prevRetorno = null, horaRetorno = 14;
    if (g.terminoDt) {
      prevRetorno = g.terminoDt.toISOString().slice(0, 10);
      horaRetorno = g.terminoDt.getHours() - 3; // UTC-3
      if (horaRetorno < 0) horaRetorno += 24;
    }

    return {
      tipoCarga,
      tipoVeiculo: String(c.tipo_veiculo || c.tipoVeiculo || c.veiculo || "").trim() || null,
      carga:        erp || String(c.id_romaneio || c.idRomaneio || c.romaneio || "--").trim(),
      destino,
      placa,
      motorista,
      ajudante:     String(c.ajudante || c.nome_ajudante || "").trim() || null,
      peso:         parseFloat(c.peso_total || c.peso || 0) || null,
      valorCarga:   parseFloat(c.valor_total || c.valor || 0) || null,
      qtdEntregas:  totalEntregas,
      entregues,
      pct,
      dataSaida,
      prevRetorno,
      horaRetorno,
      distancia:    g.kmPrevisto || parseFloat(c.km_previsto || c.distancia || 0) || null,
      valeAco,
      situacao:     "Em Curso",
    };
  });

  _cache = { ts: Date.now(), data: cargas };
  return cargas;
}

// ─── MIDDLEWARE ───────────────────────────────────────────────────────────────
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// ─── ROTAS ───────────────────────────────────────────────────────────────────

app.get("/api/status", (_req, res) => {
  const temCookie = fs.existsSync(COOKIE_FILE) && lerCookie().includes("PHPSESSID=") && !lerCookie().includes("PHPSESSID=;");
  res.json({ ok: true, sessaoAtiva: temCookie, ts: new Date().toISOString(), cacheTs: new Date(_cache.ts).toISOString() });
});

// Admin: verifica senha
app.post("/api/admin/auth", (req, res) => {
  const { password } = req.body || {};
  if (password === ADMIN_PASSWORD) res.json({ ok: true });
  else res.status(401).json({ ok: false, error: "Senha incorreta." });
});

// Admin: salva cookie
app.post("/api/admin/cookie", (req, res) => {
  const { password, cookie } = req.body || {};
  if (password !== ADMIN_PASSWORD) return res.status(401).json({ ok: false, error: "Não autorizado." });
  if (!cookie || !cookie.includes("PHPSESSID")) return res.status(400).json({ ok: false, error: "Cookie inválido." });
  salvarCookie(cookie);
  invalidarCache();
  res.json({ ok: true, msg: "Cookie salvo com sucesso." });
});

// Admin: força atualização
app.post("/api/admin/refresh", async (req, res) => {
  const { password } = req.body || {};
  if (password !== ADMIN_PASSWORD) return res.status(401).json({ ok: false, error: "Não autorizado." });
  invalidarCache();
  try {
    const cargas = await montarEscala();
    res.json({ ok: true, total: cargas.length, msg: `Cache atualizado — ${cargas.length} cargas carregadas.` });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Dashboard: cargas
app.get("/api/escala", async (_req, res) => {
  try {
    const cargas = await montarEscala();
    res.json({ ok: true, geradoEm: new Date().toISOString(), total: cargas.length, cargas });
  } catch (err) {
    console.error("[painel] /api/escala:", err.message);
    const sessao = err.message.includes("SESSAO") ? "SESSAO_EXPIRADA" : err.message;
    res.status(500).json({ ok: false, error: sessao });
  }
});

// ─── KEEPALIVE: pinga Fusion a cada 18min ─────────────────────────────────────
setInterval(async () => {
  try {
    await getCargasEmCurso();
    console.log("[keepalive] Fusion OK —", new Date().toLocaleTimeString("pt-BR"));
  } catch (e) {
    console.log("[keepalive] falhou:", e.message?.slice(0, 60));
  }
}, 18 * 60 * 1000);

// ─── START ────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`[Cercal Painel] rodando na porta ${PORT}`);
  console.log(`[Cercal Painel] Admin: /admin.html | Senha: ${ADMIN_PASSWORD}`);
});
