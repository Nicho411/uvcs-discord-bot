const express = require('express');
const app = express();
app.use(express.json());

// ─────────────────────────────────────────────
// CONFIGURAÇÕES — edite aqui
// ─────────────────────────────────────────────

const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL || 'https://discord.com/api/webhooks/1504203276059414600/un00IXg2dncFWt0m-BPhMxeJ1ZlK4b50tTpGuOMrfJp5PWwvFkp4MwLfG-PovfQPM1QH';

// Mapeamento: username exato do UVCS → User ID do Discord
// Como pegar o User ID: Discord > Configurações > Avançado > Ativar Modo Desenvolvedor
// Depois clique com botão direito no usuário > "Copiar ID do usuário"
const REVIEWER_MAP = {
  // 'username.no.uvcs': 'ID_DO_DISCORD',
  'nicholaspedroso@outlook.com':  'Nicho411',
};

const PORT = process.env.PORT || 3000;

// ─────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────

function getMention(username) {
  if (!username) return null;
  const id = REVIEWER_MAP[username.toLowerCase().trim()];
  return id ? `<@${id}>` : `**@${username}**`; // fallback: nome em negrito
}

function buildDiscordEmbed(payload) {
  const reviewer  = payload.assignee ?? payload.reviewer ?? payload.reviewers?.[0] ?? null;
  const owner     = payload.owner   ?? payload.author    ?? 'desconhecido';
  const title     = payload.title   ?? 'Novo Code Review';
  const repo      = payload.repository ?? payload.repo ?? '';
  const branch    = payload.branch  ?? '';
  const reviewUrl = payload.url     ?? payload.reviewUrl ?? '';

  const mention = getMention(reviewer);
  const mentionLine = mention
    ? `👤 **Revisor:** ${mention}`
    : '👤 Revisor não identificado';

  // Monta campos opcionais
  const fields = [];
  if (repo)    fields.push({ name: '📁 Repositório', value: repo,   inline: true });
  if (branch)  fields.push({ name: '🌿 Branch',      value: branch, inline: true });
  if (owner)   fields.push({ name: '✏️ Autor',       value: owner,  inline: true });

  return {
    content: mention ? `${mention} você tem um novo Code Review para revisar!` : mentionLine,
    embeds: [{
      title: `🔍 ${title}`,
      url:   reviewUrl || undefined,
      color: 0x5865F2, // azul Discord
      fields,
      footer: { text: 'Unity Version Control · Code Review' },
      timestamp: new Date().toISOString(),
    }],
  };
}

// ─────────────────────────────────────────────
// ROTA PRINCIPAL — recebe o webhook do UVCS
// ─────────────────────────────────────────────

app.post('/uvcs-webhook', async (req, res) => {
  const payload = req.body;

  console.log('[UVCS] Payload recebido:', JSON.stringify(payload, null, 2));

  // Filtra apenas eventos de Code Review (ajuste o campo/valor conforme seu UVCS)
  const eventType = payload.event ?? payload.type ?? '';
  if (eventType && !eventType.toLowerCase().includes('review')) {
    console.log('[UVCS] Evento ignorado:', eventType);
    return res.sendStatus(200);
  }

  try {
    const discordBody = buildDiscordEmbed(payload);
    const response = await fetch(DISCORD_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(discordBody),
    });

    if (!response.ok) {
      const err = await response.text();
      console.error('[Discord] Erro ao enviar mensagem:', response.status, err);
      return res.status(500).json({ error: 'Falha ao enviar para o Discord' });
    }

    console.log('[Discord] Mensagem enviada com sucesso');
    res.sendStatus(200);
  } catch (err) {
    console.error('[Erro]', err);
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────
// ROTA DE TESTE — simula um Code Review
// ─────────────────────────────────────────────

app.get('/test', async (req, res) => {
  const fakePayload = {
    event:      'codereview.created',
    title:      'Refactor: sistema de inventário',
    owner:      'joao.silva',
    assignee:   'maria.souza',  // ← troque para um username que está no seu REVIEWER_MAP
    repository: 'MeuJogo',
    branch:     '/main/feature-inventario',
    url:        'https://dashboard.unity3d.com/devops',
  };

  console.log('[TEST] Simulando payload:', fakePayload);
  try {
    const discordBody = buildDiscordEmbed(fakePayload);
    const response = await fetch(DISCORD_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(discordBody),
    });

    if (!response.ok) {
      const err = await response.text();
      return res.status(500).json({ discord_error: err });
    }

    res.json({ ok: true, sent: discordBody });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────
// ROTA DE HEALTH CHECK
// ─────────────────────────────────────────────

app.get('/', (req, res) => res.json({ status: 'online' }));

app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
  console.log(`Teste rápido: http://localhost:${PORT}/test`);
});
