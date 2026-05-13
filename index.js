const express = require('express');
const app = express();
app.use(express.json());

// ─────────────────────────────────────────────
// CONFIGURAÇÕES — edite aqui
// ─────────────────────────────────────────────

const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL || 'COLE_AQUI_O_WEBHOOK_DO_DISCORD';

// Mapeamento: username exato do UVCS → User ID do Discord
// Como pegar o User ID: Discord > Configurações > Avançado > Ativar Modo Desenvolvedor
// Depois clique com botão direito no usuário > "Copiar ID do usuário"
const REVIEWER_MAP = {
  'nicholaspedroso@outlook.com': '192641612659163137',
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

function extractReviewer(payload) {
  // O UVCS envia o payload já formatado para o Discord
  // O revisor aparece em embeds[0].title ou na description como [requested-review-from-EMAIL]
  const embed = payload.embeds?.[0];
  if (!embed) return null;

  // Tenta pegar do título do embed
  const title = embed.title ?? '';
  if (title.includes('@')) return title.trim();

  // Tenta extrair da description: [requested-review-from-EMAIL]
  const desc = embed.description ?? '';
  const match = desc.match(/\[requested-review-from-([^\]]+)\]/);
  if (match) return match[1].trim();

  return null;
}

function buildDiscordEmbed(payload) {
  const reviewer  = payload.assignee ?? payload.reviewer ?? payload.reviewers?.[0] ?? extractReviewer(payload);
  const owner     = payload.owner   ?? payload.author    ?? 'desconhecido';
  const embed     = payload.embeds?.[0];
  const title     = payload.title   ?? (embed?.title && !embed.title.includes('@') ? embed.title : null) ?? 'Novo Code Review';
  const repo      = payload.repository ?? payload.repo ?? embed?.footer?.text ?? '';
  const branch    = payload.branch  ?? '';

  // Extrai a URL plástica da description e converte para link do dashboard
  const desc      = embed?.description ?? '';
  const urlMatch  = desc.match(/<(plastic:\/\/[^>]+)>/);
  const reviewUrl = payload.url ?? payload.reviewUrl ?? (urlMatch ? urlMatch[1] : '') ?? '';

  // Extrai o nome do review do content: "New comment to the review `NOME`"
  const contentMatch = payload.content?.match(/review `([^`]+)`/);
  const reviewName = contentMatch ? contentMatch[1] : title;

  const mention = getMention(reviewer);
  const mentionLine = mention
      ? `👤 **Revisor:** ${mention}`
      : '👤 Revisor não identificado';

  const fields = [];
  if (repo)   fields.push({ name: '📁 Repositório', value: repo,   inline: true });
  if (branch) fields.push({ name: '🌿 Branch',      value: branch, inline: true });
  if (owner !== 'desconhecido') fields.push({ name: '✏️ Autor', value: owner, inline: true });

  return {
    content: mention ? `${mention} você tem um novo Code Review para revisar!` : mentionLine,
    embeds: [{
      title: `🔍 ${reviewName}`,
      color: 0x5865F2,
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

  // Filtra apenas eventos de atribuição de revisor
  // O UVCS indica isso com [requested-review-from-...] na description
  const desc = payload.embeds?.[0]?.description ?? '';
  const isReviewRequest = desc.includes('requested-review-from');
  const eventType = payload.event ?? payload.type ?? '';
  const isReviewEvent = eventType.toLowerCase().includes('review');

  if (!isReviewRequest && !isReviewEvent) {
    console.log('[UVCS] Evento ignorado (não é atribuição de revisor)');
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
    assignee:   'nicholaspedroso@outlook.com',
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