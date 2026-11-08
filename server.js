/**
 * ============================================================
 * CENTRAL CRM IA — Microsserviço de Sessão WhatsApp Web (QR Code)
 * ============================================================
 *
 * O QUE ISSO FAZ:
 * Mantém uma conexão persistente (processo de servidor contínuo) com o
 * WhatsApp Web usando a biblioteca Baileys. Expõe uma API HTTP simples
 * para o painel Central CRM IA: gerar/consultar QR Code, status da sessão,
 * enviar mensagens, e grava eventos/mensagens recebidas DIRETO nas tabelas
 * reais do CRM (whatsapp_connections e messages) via Table API HTTP.
 *
 * ONDE RODAR:
 * Este processo PRECISA de um ambiente com processo contínuo (Railway,
 * Render, VPS, etc.). NÃO funciona em hospedagem estática/serverless
 * (Cloudflare Workers, Vercel Edge, etc.) porque exige um socket
 * permanentemente aberto.
 *
 * LIMITAÇÕES IMPORTANTES (leia antes de usar em produção):
 * - Este é um uso NÃO OFICIAL do WhatsApp. Sujeito a bloqueios,
 *   instabilidades e mudanças da Meta sem aviso prévio.
 * - Este serviço NÃO implementa disparo automatizado em massa,
 *   evasão de bloqueios, camuflagem de tráfego ou simulação de
 *   comportamento humano. Os endpoints de envio aqui são para uso
 *   individual/assistido (atendimento humano), conforme o escopo
 *   definido no painel.
 * - Mantenha apenas UMA sessão por número de telefone. Múltiplas
 *   conexões simultâneas ao mesmo número aumentam o risco de bloqueio.
 *
 * SEGURANÇA:
 * - Toda chamada (exceto /health) exige o header:
 *     x-service-key: <SERVICE_SECRET definido nas variáveis de ambiente>
 * - As sessões ficam salvas em disco (pasta /sessions). No Railway, use
 *   um Volume persistente para não perder a sessão a cada deploy/restart.
 * - Nunca exponha a SERVICE_SECRET no frontend/navegador. Ela só deve
 *   ser usada por uma chamada feita a partir de um backend (ou, no caso
 *   deste MVP, diretamente do painel administrativo via fetch autenticado
 *   — avalie mover isso para um backend intermediário em produção real).
 */

const express = require('express');
const cors = require('cors');
const qrcode = require('qrcode');
const fetch = require('node-fetch');
const pino = require('pino');
const path = require('path');
const fs = require('fs');
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion
} = require('@whiskeysockets/baileys');

const PORT = process.env.PORT || 3000;
const SERVICE_SECRET = process.env.SERVICE_SECRET || '';
// URL base do site do CRM publicado (Hosted Deploy), ex: https://03a06473-xxxx.vip.gensparksite.com
// Usada para gravar diretamente nas tabelas "messages" e "whatsapp_connections" via Table API real.
const CRM_BASE_URL = (process.env.CRM_BASE_URL || '').replace(/\/$/, '');
const SESSIONS_DIR = process.env.SESSIONS_DIR || path.join(__dirname, 'sessions');
// Intervalo mínimo (em segundos) entre dois envios na MESMA sessão/número.
// IMPORTANTE: isto é um limite de taxa simples e transparente para reduzir o
// risco de bloqueio em uso assistido por um atendente humano — não é uma
// fila automatizada, nem simulação de comportamento humano (digitação,
// horários aleatórios etc.), o que está fora do escopo deste serviço.
// Ajustável via variável de ambiente MIN_SEND_INTERVAL_SECONDS no Railway.
const MIN_SEND_INTERVAL_SECONDS = Math.max(1, parseInt(process.env.MIN_SEND_INTERVAL_SECONDS || '5', 10) || 5);

if (!fs.existsSync(SESSIONS_DIR)) fs.mkdirSync(SESSIONS_DIR, { recursive: true });
if (!SERVICE_SECRET) {
  console.warn('[AVISO] SERVICE_SECRET não definida. Configure essa variável de ambiente antes de ir para produção!');
}
if (!CRM_BASE_URL) {
  console.warn('[AVISO] CRM_BASE_URL não definida. O serviço vai rodar, mas não vai gravar mensagens/eventos de volta no CRM.');
}
console.log(`   Intervalo mínimo entre envios (MIN_SEND_INTERVAL_SECONDS): ${MIN_SEND_INTERVAL_SECONDS}s`);

const logger = pino({ level: 'warn' });
const app = express();
app.use(cors());
app.use(express.json());

/* ============ ESTADO EM MEMÓRIA POR SESSÃO ============ */
/* sessions[sessionId] = { sock, qr, status, lastEvent, lastEventAt, phone } */
const sessions = {};

function authMiddleware(req, res, next) {
  const key = req.header('x-service-key');
  if (!SERVICE_SECRET || key !== SERVICE_SECRET) {
    return res.status(401).json({ error: 'Não autorizado. Header x-service-key inválido ou ausente.' });
  }
  next();
}

/* ============ GRAVA DIRETO NAS TABELAS REAIS DO CRM (Table API) ============ */
/* sessionId aqui é o mesmo "id" do registro em whatsapp_connections do CRM. */

async function crmFetch(path, options) {
  if (!CRM_BASE_URL) return null;
  const res = await fetch(`${CRM_BASE_URL}/tables/${path}`, Object.assign({
    headers: { 'Content-Type': 'application/json' }
  }, options));
  if (!res.ok) {
    logger.warn({ status: res.status, path }, 'Falha ao gravar no CRM via Table API');
    return null;
  }
  return res.json().catch(() => null);
}

// IMPORTANTE: o método HTTP PATCH é bloqueado pela política de CORS do
// ambiente de Hosted Deploy do CRM ("Method PATCH is not allowed by
// Access-Control-Allow-Methods"), o que fazia essa atualização de status
// falhar em silêncio. Correção: buscamos o registro atual (GET), mesclamos
// com os campos alterados, e enviamos substituição completa via PUT (aceito
// normalmente), preservando os campos não informados em "fields".
async function updateConnectionStatus(sessionId, fields) {
  let current = {};
  try {
    const res = await fetch(`${CRM_BASE_URL}/tables/whatsapp_connections/${sessionId}`);
    if (res.ok) current = await res.json();
  } catch (e) { /* segue só com os campos informados; o PUT abaixo reportará erro real se o registro não existir */ }
  const merged = Object.assign({}, current, fields, { id: sessionId });
  delete merged.gs_project_id;
  delete merged.gs_table_name;
  await crmFetch(`whatsapp_connections/${sessionId}`, { method: 'PUT', body: JSON.stringify(merged) });
}

async function recordIncomingMessage(sessionId, fromPhone, content) {
  // Tenta localizar um contato existente pelo telefone para vincular a mensagem.
  let contactId = '';
  let contactName = fromPhone;
  try {
    const search = await fetch(`${CRM_BASE_URL}/tables/contacts?search=${encodeURIComponent(fromPhone)}&limit=5`);
    if (search.ok) {
      const data = await search.json();
      const match = (data.data || []).find(c => (c.phone || '').replace(/\D/g, '') === fromPhone.replace(/\D/g, ''));
      if (match) { contactId = match.id; contactName = match.name; }
    }
  } catch (e) { /* ignora — grava mensagem sem contato vinculado */ }

  await crmFetch('messages', {
    method: 'POST',
    body: JSON.stringify({
      id: 'wa-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8),
      contact_id: contactId, contact_name: contactName, contact_phone: fromPhone,
      channel: 'whatsapp', direction: 'entrada', content,
      status: 'recebido', connection_id: sessionId, conversation_status: 'aberto', read: false
    })
  });
}

/* ============ INICIA (OU RETOMA) UMA SESSÃO ============ */
async function startSession(sessionId) {
  const sessionPath = path.join(SESSIONS_DIR, sessionId);
  if (!fs.existsSync(sessionPath)) fs.mkdirSync(sessionPath, { recursive: true });

  const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: state,
    logger,
    printQRInTerminal: false
  });

  sessions[sessionId] = sessions[sessionId] || {};
  sessions[sessionId].sock = sock;
  sessions[sessionId].status = 'conectando';
  sessions[sessionId].qr = null;

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      sessions[sessionId].qr = await qrcode.toDataURL(qr);
      sessions[sessionId].status = 'aguardando_leitura';
      sessions[sessionId].lastEvent = 'QR Code gerado — aguardando leitura';
      sessions[sessionId].lastEventAt = new Date().toISOString();
    }

    if (connection === 'open') {
      sessions[sessionId].status = 'conectado';
      sessions[sessionId].qr = null;
      sessions[sessionId].phone = sock.user?.id?.split(':')[0] || null;
      sessions[sessionId].lastEvent = 'Conectado com sucesso';
      sessions[sessionId].lastEventAt = new Date().toISOString();
      await updateConnectionStatus(sessionId, {
        status: 'conectado', phone_number: sessions[sessionId].phone ? '+' + sessions[sessionId].phone : '',
        last_event: 'Conectado com sucesso', last_event_at: new Date().toISOString(),
        connected_at: new Date().toISOString()
      });
    }

    if (connection === 'close') {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const loggedOut = statusCode === DisconnectReason.loggedOut;
      sessions[sessionId].status = loggedOut ? 'desconectado' : 'erro';
      sessions[sessionId].lastEvent = loggedOut ? 'Sessão encerrada (logout)' : `Conexão perdida (código ${statusCode})`;
      sessions[sessionId].lastEventAt = new Date().toISOString();
      await updateConnectionStatus(sessionId, {
        status: sessions[sessionId].status, last_event: sessions[sessionId].lastEvent,
        last_event_at: sessions[sessionId].lastEventAt
      });

      if (!loggedOut) {
        // tenta reconectar automaticamente (falha transitória de rede)
        setTimeout(() => startSession(sessionId).catch(() => {}), 5000);
      }
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
    for (const msg of messages) {
      if (msg.key.fromMe) continue;
      const text = msg.message?.conversation || msg.message?.extendedTextMessage?.text || '';
      const from = msg.key.remoteJid?.replace('@s.whatsapp.net', '');
      if (!from || !text) continue;
      await recordIncomingMessage(sessionId, '+' + from, text);
    }
  });

  return sock;
}

/* ============ ENDPOINTS ============ */

app.get('/health', (req, res) => res.json({ ok: true, service: 'central-crm-ia-whatsapp-service', time: new Date().toISOString() }));

// Inicia ou retoma uma sessão e começa a gerar QR Code
app.post('/sessions/:id/start', authMiddleware, async (req, res) => {
  const sessionId = req.params.id;
  try {
    if (!sessions[sessionId] || !sessions[sessionId].sock) {
      await startSession(sessionId);
    }
    res.json({ ok: true, sessionId, status: sessions[sessionId]?.status || 'conectando' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Consulta status e QR Code atual da sessão
app.get('/sessions/:id/status', authMiddleware, (req, res) => {
  const s = sessions[req.params.id];
  if (!s) return res.json({ status: 'nao_iniciada', qr: null });
  res.json({
    status: s.status || 'desconhecido',
    qr: s.qr || null,
    phone: s.phone || null,
    lastEvent: s.lastEvent || null,
    lastEventAt: s.lastEventAt || null
  });
});

// Envia mensagem individual (uso assistido, não massificado).
// Suporta texto simples, texto com link (o WhatsApp detecta e exibe como
// clicável/com preview automaticamente — nenhum tratamento especial necessário)
// e, opcionalmente, uma imagem com legenda via "mediaUrl" (URL pública
// same-origin do CRM, ex: https://SEU-CRM/files/whatsapp-media/<id>).
// NÃO há suporte a "botões" interativos reais (CTA/URL button): esse recurso
// não é estável em sessões não oficiais e está fora do escopo deste serviço
// (ver cabeçalho do arquivo — sem técnicas de evasão/instabilidade).
//
// LIMITE DE TAXA (anti-bloqueio): exige um intervalo mínimo de
// MIN_SEND_INTERVAL_SECONDS entre dois envios na MESMA sessão. Isto é um
// limite simples e transparente (rejeita com erro 429 se chamado cedo demais)
// para reduzir o risco de bloqueio em uso assistido por humano — não é fila
// automatizada nem simulação de comportamento humano.
app.post('/sessions/:id/send', authMiddleware, async (req, res) => {
  const sessionId = req.params.id;
  const { to, message, mediaUrl } = req.body || {};
  const s = sessions[sessionId];

  if (!s || !s.sock || s.status !== 'conectado') {
    return res.status(409).json({ error: 'Sessão não está conectada. Gere o QR Code e conecte antes de enviar.' });
  }
  if (!to || !message) {
    return res.status(400).json({ error: 'Informe "to" (telefone com DDI, ex: 5511999999999) e "message".' });
  }

  const now = Date.now();
  const minIntervalMs = MIN_SEND_INTERVAL_SECONDS * 1000;
  if (s.lastSentAt && (now - s.lastSentAt) < minIntervalMs) {
    const waitSeconds = Math.ceil((minIntervalMs - (now - s.lastSentAt)) / 1000);
    return res.status(429).json({
      error: `Aguarde ${waitSeconds}s antes de enviar outra mensagem (limite mínimo de ${MIN_SEND_INTERVAL_SECONDS}s entre envios, configurado para reduzir o risco de bloqueio desta sessão).`,
      retryAfterSeconds: waitSeconds
    });
  }

  try {
    const jid = to.replace(/\D/g, '') + '@s.whatsapp.net';
    if (mediaUrl) {
      // Baixa a imagem do CRM (same-origin, referência retornada pelo upload real
      // via /files/) e envia como mídia com a mensagem como legenda.
      const imgRes = await fetch(mediaUrl);
      if (!imgRes.ok) throw new Error('Não foi possível baixar a imagem informada (status ' + imgRes.status + ')');
      const buffer = Buffer.from(await imgRes.arrayBuffer());
      await s.sock.sendMessage(jid, { image: buffer, caption: message });
    } else {
      await s.sock.sendMessage(jid, { text: message });
    }
    s.lastSentAt = Date.now();
    res.json({ ok: true, sentAt: new Date().toISOString(), minIntervalSeconds: MIN_SEND_INTERVAL_SECONDS });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Desconecta e remove a sessão (logout)
app.post('/sessions/:id/disconnect', authMiddleware, async (req, res) => {
  const sessionId = req.params.id;
  const s = sessions[sessionId];
  try {
    if (s?.sock) {
      await s.sock.logout().catch(() => {});
    }
    delete sessions[sessionId];
    const sessionPath = path.join(SESSIONS_DIR, sessionId);
    if (fs.existsSync(sessionPath)) fs.rmSync(sessionPath, { recursive: true, force: true });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.listen(PORT, () => {
  console.log(`✅ Microsserviço WhatsApp (Baileys) rodando na porta ${PORT}`);
  console.log(`   Sessões persistidas em: ${SESSIONS_DIR}`);
  console.log(`   Integração com CRM (CRM_BASE_URL): ${CRM_BASE_URL ? CRM_BASE_URL : 'NÃO CONFIGURADA'}`);
  console.log(`   Chave de serviço (SERVICE_SECRET): ${SERVICE_SECRET ? 'definida' : 'NÃO DEFINIDA (inseguro!)'}`);
});
