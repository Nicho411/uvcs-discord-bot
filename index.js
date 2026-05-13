const express = require('express');
const app = express();
app.use(express.json());

// ─────────────────────────────────────────────
// CONFIGURAÇÕES — edite aqui
// ─────────────────────────────────────────────

// Mapeamento: nome do repositório → Webhook do canal Discord correspondente
const REPO_WEBHOOKS = {
  'Sundried-Art': process.env.DISCORD_WEBHOOK_ART || 'COLE_AQUI_O_WEBHOOK_DO_CANAL_ARTE',
  'Sundried-Dev': process.env.DISCORD_WEBHOOK_DEV || 'COLE_AQUI_O_WEBHOOK_DO_CANAL_DEV',
};

// Retorna o webhook correto com base no repositório do payload
function getWebhookUrl(repo) {
  for (const [key, url] of Object.entries(REPO_WEBHOOKS)) {
    if (repo.includes(key)) return url;
  }
  return Object.values(REPO_WEBHOOKS)[0]; // fallback: primeiro webhook
}

// Mapeamento: email exato do UVCS → User ID do Discord
// Como pegar o User ID: Discord > Configurações > Avançado > Ativar Modo Desenvolvedor
// Depois clique com botão direito no usuário > "Copiar ID do usuário"
const REVIEWER_MAP = {
  'nicholaspedroso@outlook.com': '192641612659163137',
  'francescolpm@gmail.com':      '884441615886856224',
  'jefsmed@outlook.com':         '190662247603765249',
  'filipefiorentini@gmail.com':  '305950346512039938',
  'cassiolima052000@gmail.com':  '384008601360138240',
};

const PORT = process.env.PORT || 3000;

// ─────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────

function getMention(email) {
  if (!email) return null;
  const id = REVIEWER_MAP[email.toLowerCase().trim()];
  return id ? `<@${id}>` : `**${email}**`; // fallback: email em negrito
}

// Detecta o tipo de evento com base na description do embed
function detectEvent(desc) {
  if (desc.includes('requested-review-from')) return 'review_requested';
  if (desc.includes('[status-reviewed]'))     return 'status_reviewed';
  if (desc.includes('[status-rework]'))       return 'status_rework';
  if (desc.includes('Under review'))          return 'under_review';
  return 'comment'; // qualquer outro texto é tratado como comentário
}

// Extrai dados comuns do payload do UVCS
function parsePayload(payload) {
  const embed      = payload.embeds?.[0] ?? {};
  const desc       = embed.description ?? '';
  const actor      = embed.title ?? '';        // quem fez a ação
  const repo       = embed.footer?.text ?? '';
  const reviewName = payload.content?.match(/review `([^`]+)`/)?.[1] ?? 'Code Review';
  const eventType  = detectEvent(desc);

  // Em review_requested, o email do revisor está na description
  const reviewerMatch = desc.match(/\[requested-review-from-([^\]]+)\]/);
  const reviewer = reviewerMatch ? reviewerMatch[1] : null;

  return { embed, desc, actor, repo, reviewName, eventType, reviewer };
}

// Monta a mensagem do Discord de acordo com o tipo de evento
function buildMessage(payload) {
  const { actor, repo, reviewName, eventType, reviewer } = parsePayload(payload);

  const actorMention    = getMention(actor);
  const reviewerMention = getMention(reviewer ?? actor);

  switch (eventType) {

    case 'review_requested':
      // Menciona o revisor designado
      return {
        content: `${reviewerMention} você foi designado para revisar um Code Review!`,
        embeds: [{
          title: `🔍 ${reviewName}`,
          color: 0x5865F2,
          fields: [
            { name: '✏️ Solicitado por', value: actor || 'desconhecido', inline: true },
            { name: '📁 Repositório',    value: repo  || 'desconhecido', inline: true },
          ],
          footer: { text: 'Unity Version Control · Novo Review' },
          timestamp: new Date().toISOString(),
        }],
      };

    case 'status_reviewed':
      // Menciona o autor do review (actor = quem aprovou)
      return {
        content: `${actorMention} marcou o review como **Reviewed** ✅`,
        embeds: [{
          title: `✅ ${reviewName}`,
          color: 0x57F287, // verde
          fields: [
            { name: '👤 Revisado por', value: actor || 'desconhecido', inline: true },
            { name: '📁 Repositório',  value: repo  || 'desconhecido', inline: true },
          ],
          footer: { text: 'Unity Version Control · Status Atualizado' },
          timestamp: new Date().toISOString(),
        }],
      };

    case 'status_rework':
      // Menciona quem pediu o rework
      return {
        content: `${actorMention} solicitou **Rework** no review ⚠️`,
        embeds: [{
          title: `⚠️ ${reviewName}`,
          color: 0xFEE75C, // amarelo
          fields: [
            { name: '👤 Solicitado por', value: actor || 'desconhecido', inline: true },
            { name: '📁 Repositório',    value: repo  || 'desconhecido', inline: true },
          ],
          footer: { text: 'Unity Version Control · Rework Solicitado' },
          timestamp: new Date().toISOString(),
        }],
      };

    case 'comment': {
      // Extrai o texto do comentário (tudo antes do link <plastic://...>)
      const { desc } = parsePayload(payload);
      const commentText = desc.replace(/<plastic:\/\/[^>]+>/g, '').trim() || null;

      return {
        content: `${actorMention} adicionou um comentário no review 💬`,
        embeds: [{
          title: `💬 ${reviewName}`,
          color: 0xEB459E, // rosa
          description: commentText ?? undefined,
          fields: [
            { name: '👤 Comentado por', value: actor || 'desconhecido', inline: true },
            { name: '📁 Repositório',   value: repo  || 'desconhecido', inline: true },
          ],
          footer: { text: 'Unity Version Control · Novo Comentário' },
          timestamp: new Date().toISOString(),
        }],
      };
    }

    default:
      return null;
  }
}

// ─────────────────────────────────────────────
// ROTA PRINCIPAL — recebe o webhook do UVCS
// ─────────────────────────────────────────────

app.post('/uvcs-webhook', async (req, res) => {
  const payload = req.body;
  console.log('[UVCS] Payload recebido:', JSON.stringify(payload, null, 2));

  // Ignora eventos genéricos de "Under review"
  const { eventType, repo } = parsePayload(payload);
  if (eventType === 'under_review') {
    console.log('[UVCS] Evento "Under review" ignorado');
    return res.sendStatus(200);
  }

  const discordBody = buildMessage(payload);
  if (!discordBody) {
    console.log('[UVCS] Evento não mapeado, ignorado');
    return res.sendStatus(200);
  }

  try {
    const webhookUrl = getWebhookUrl(repo);
    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(discordBody),
    });

    if (!response.ok) {
      const err = await response.text();
      console.error('[Discord] Erro:', response.status, err);
      return res.status(500).json({ error: 'Falha ao enviar para o Discord' });
    }

    console.log(`[Discord] Mensagem enviada — evento: ${eventType}`);
    res.sendStatus(200);
  } catch (err) {
    console.error('[Erro]', err);
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────
// ROTA DE TESTE — simula cada tipo de evento
// Acesse /test?evento=review_requested
//         /test?evento=status_reviewed
//         /test?evento=status_rework
//         /test?evento=comment
// ─────────────────────────────────────────────

app.get('/test', async (req, res) => {
  const evento = req.query.evento ?? 'review_requested';

  const payloads = {
    review_requested: {
      content: "New comment to the review `Dev teste`",
      embeds: [{
        color: 15234920,
        title: 'nicholaspedroso@outlook.com',
        description: '[requested-review-from-nicholaspedroso@outlook.com]\n <plastic://test>',
        footer: { text: 'Aulas_19/Shader@4674152027131.unity' },
      }],
    },
    status_reviewed: {
      content: "New comment to the review `Dev teste`",
      embeds: [{
        color: 15234920,
        title: 'nicholaspedroso@outlook.com',
        description: '[status-reviewed]\n <plastic://test>',
        footer: { text: 'Aulas_19/Shader@4674152027131.unity' },
      }],
    },
    status_rework: {
      content: "New comment to the review `Dev teste`",
      embeds: [{
        color: 15234920,
        title: 'nicholaspedroso@outlook.com',
        description: '[status-rework]\n <plastic://test>',
        footer: { text: 'Aulas_19/Shader@4674152027131.unity' },
      }],
    },
    comment: {
      content: "New comment to the review `Dev teste`",
      embeds: [{
        color: 15234920,
        title: 'nicholaspedroso@outlook.com',
        description: 'comentário de teste aqui\n <plastic://test>',
        footer: { text: 'Aulas_19/Shader@4674152027131.unity' },
      }],
    },
  };

  const payload = payloads[evento];
  if (!payload) {
    return res.status(400).json({ error: 'Evento inválido. Use: review_requested | status_reviewed | status_rework | comment' });
  }

  console.log(`[TEST] Simulando evento: ${evento}`);
  const { repo: testRepo } = parsePayload(payload);
  const discordBody = buildMessage(payload);

  try {
    const webhookUrl = getWebhookUrl(testRepo);
    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(discordBody),
    });

    if (!response.ok) {
      const err = await response.text();
      return res.status(500).json({ discord_error: err });
    }

    res.json({ ok: true, evento, sent: discordBody });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────
// HEALTH CHECK
// ─────────────────────────────────────────────

app.get('/', (req, res) => res.json({ status: 'online' }));

app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
  console.log(`Testes disponíveis:`);
  console.log(`  /test?evento=review_requested`);
  console.log(`  /test?evento=status_reviewed`);
  console.log(`  /test?evento=status_rework`);
  console.log(`  /test?evento=comment`);
});