const express = require('express');
const cron    = require('node-cron');
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
// LEMBRETE DIÁRIO
// ─────────────────────────────────────────────

const REMINDER_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_GENERAL || 'COLE_AQUI_O_WEBHOOK_DO_GENERAL';

// Agendamento: segunda a sexta às 17h (horário de Brasília, UTC-3)
// Cron: minuto hora * * dia-da-semana (1=seg, 5=sex)
cron.schedule('0 20 * * 1-5', async () => {
  console.log('[CRON] Enviando lembrete diário...');
  try {
    const response = await fetch(REMINDER_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content: '@here Lembre-se de lançar suas horas nas tarefas em que trabalhou no dia de hoje! E também subir prints/vídeos nos cards das tarefas no ClickUp!',
      }),
    });
    if (!response.ok) {
      const err = await response.text();
      console.error('[CRON] Erro ao enviar lembrete:', err);
    } else {
      console.log('[CRON] Lembrete enviado com sucesso!');
    }
  } catch (err) {
    console.error('[CRON] Erro:', err);
  }
}, { timezone: 'America/Sao_Paulo' });

// ─────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────

function getMention(email) {
  if (!email) return null;
  const id = REVIEWER_MAP[email.toLowerCase().trim()];
  return id ? `<@${id}>` : `**${email}**`; // fallback: email em negrito
}

// Detecta o tipo de evento
function detectEvent(payload) {
  if (!payload.PLASTIC_REVIEW_ACTION !== undefined && payload.PLASTIC_REVIEW_ACTION !== undefined) {
    const action     = payload.PLASTIC_REVIEW_ACTION      ?? '';
    const comment    = payload.PLASTIC_REVIEW_COMMENT     ?? '';
    const commentAct = payload.PLASTIC_REVIEW_COMMENT_ACTION ?? '';

    // Ignora comentários automáticos de status (ex: [status-reviewed]) — já tratados pelo evento "update reviewer"
    if (commentAct === 'Created' && (comment.includes('[status-') || comment.includes('[requested-review-from'))) {
      return 'ignore';
    }

    if (action === 'update reviewer') {
      // Verifica se algum revisor mudou para Reviewed ou Rework
      const info = payload.PLASTIC_REVIEW_ACTION_INFO ?? '';
      if (info.includes(':Reviewed'))       return 'status_reviewed';
      if (info.includes(':Rework'))         return 'status_rework';
      return 'ignore';
    }

    if (action.includes('Assigned') || action.includes('ReviewerAssigned')) return 'review_requested';
    if (action === 'create')                return 'review_requested';
    if (commentAct === 'Created' && comment && !comment.startsWith('[')) return 'comment';
    return 'ignore';
  }

  // Payload legado via embeds (testes /test)
  const desc = payload.embeds?.[0]?.description ?? '';
  if (desc.includes('requested-review-from')) return 'review_requested';
  if (desc.includes('[status-reviewed]'))     return 'status_reviewed';
  if (desc.includes('[status-rework]'))       return 'status_rework';
  if (desc.includes('Under review'))          return 'under_review';
  return 'comment';
}

// Extrai dados comuns do payload
function parsePayload(payload) {
  if (payload.PLASTIC_REVIEW_ACTION !== undefined) {
    // Quem mudou o status está no ACTION_INFO (ex: "jefsmed@outlook.com:Reviewed")
    const actionInfo   = payload.PLASTIC_REVIEW_ACTION_INFO ?? '';
    const actionActor  = actionInfo.includes(':') ? actionInfo.split(':')[0] : (payload.PLASTIC_USER ?? '');

    return {
      actor:       payload.PLASTIC_REVIEW_OWNER    ?? '',   // dono do review
      actionActor: payload.PLASTIC_USER            ?? '',   // quem executou a ação
      statusActor: actionActor,                             // quem mudou o status
      repo:        payload.PLASTIC_REPOSITORY_NAME ?? '',
      reviewName:  payload.PLASTIC_REVIEW_TITLE    ?? 'Code Review',
      eventType:   detectEvent(payload),
      reviewer:    payload.PLASTIC_REVIEW_ASSIGNEE ?? null,
      comment:     payload.PLASTIC_REVIEW_COMMENT  ?? null,
      branch:      payload.PLASTIC_REVIEW_TARGET   ?? '',
      newStatus:   actionInfo.includes(':') ? actionInfo.split(':')[1] : '',
    };
  }

  // Payload legado via embeds (testes)
  const embed = payload.embeds?.[0] ?? {};
  const desc  = embed.description ?? '';
  const reviewerMatch = desc.match(/\[requested-review-from-([^\]]+)\]/);
  return {
    actor:       embed.title ?? '',
    actionActor: embed.title ?? '',
    statusActor: embed.title ?? '',
    repo:        embed.footer?.text ?? '',
    reviewName:  payload.content?.match(/review `([^`]+)`/)?.[1] ?? 'Code Review',
    eventType:   detectEvent(payload),
    reviewer:    reviewerMatch ? reviewerMatch[1] : null,
    comment:     desc.replace(/<plastic:\/\/[^>]+>/g, '').replace(/\[.*?\]/g, '').trim() || null,
    branch:      '',
    newStatus:   '',
  };
}

// Monta a mensagem do Discord de acordo com o tipo de evento
function buildMessage(payload) {
  const { actor, actionActor, statusActor, repo, reviewName, eventType, reviewer, comment, newStatus } = parsePayload(payload);

  const ownerMention    = getMention(actor);        // dono do review
  const reviewerMention = getMention(reviewer);     // revisor designado
  const statusMention   = getMention(statusActor);  // quem mudou o status

  // Label legível do status
  const statusLabel = newStatus.toLowerCase().includes('review') ? 'Reviewed ✅'
      : newStatus.toLowerCase().includes('rework')  ? 'Rework Required ⚠️'
          : newStatus;

  switch (eventType) {

    case 'review_requested':
      return {
        content: `${ownerMention} abriu um novo review para ${reviewerMention}`,
        embeds: [{
          title: `🔍 ${reviewName}`,
          color: 0x5865F2,
          fields: [
            { name: '✏️ Autor',       value: actor    || 'desconhecido', inline: true },
            { name: '👤 Revisor',     value: reviewer || 'desconhecido', inline: true },
            { name: '📁 Repositório', value: repo     || 'desconhecido', inline: true },
          ],
          footer: { text: 'Unity Version Control · Novo Review' },
          timestamp: new Date().toISOString(),
        }],
      };

    case 'status_reviewed':
    case 'status_rework': {
      const color = eventType === 'status_reviewed' ? 0x57F287 : 0xFEE75C;
      return {
        content: `${ownerMention} sua solicitação de review teve o status alterado para **${statusLabel}** por ${statusMention}`,
        embeds: [{
          title: `${eventType === 'status_reviewed' ? '✅' : '⚠️'} ${reviewName}`,
          color,
          fields: [
            { name: '👤 Alterado por', value: statusActor || 'desconhecido', inline: true },
            { name: '📁 Repositório',  value: repo        || 'desconhecido', inline: true },
          ],
          footer: { text: 'Unity Version Control · Status Atualizado' },
          timestamp: new Date().toISOString(),
        }],
      };
    }

    case 'comment':
      return {
        content: `${getMention(actionActor)} adicionou um comentário no review 💬`,
        embeds: [{
          title: `💬 ${reviewName}`,
          color: 0xEB459E,
          description: comment ?? undefined,
          fields: [
            { name: '👤 Comentado por', value: actionActor || 'desconhecido', inline: true },
            { name: '📁 Repositório',   value: repo        || 'desconhecido', inline: true },
          ],
          footer: { text: 'Unity Version Control · Novo Comentário' },
          timestamp: new Date().toISOString(),
        }],
      };

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

  const { eventType, repo } = parsePayload(payload);
  if (eventType === 'ignore' || eventType === 'under_review') {
    console.log('[UVCS] Evento ignorado:', eventType);
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