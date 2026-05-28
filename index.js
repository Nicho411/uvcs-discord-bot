const express = require('express');
const cron    = require('node-cron');
const app = express();
app.use(express.json());

// ─────────────────────────────────────────────
// CONFIGURAÇÕES — edite aqui
// ─────────────────────────────────────────────

const REPO_WEBHOOKS = {
  'Sundried-Art': process.env.DISCORD_WEBHOOK_ART || 'COLE_AQUI_O_WEBHOOK_DO_CANAL_ARTE',
  'Sundried-Dev': process.env.DISCORD_WEBHOOK_DEV || 'COLE_AQUI_O_WEBHOOK_DO_CANAL_DEV',
};

function getWebhookUrl(repo) {
  for (const [key, url] of Object.entries(REPO_WEBHOOKS)) {
    if (repo.includes(key)) return url;
  }
  return Object.values(REPO_WEBHOOKS)[0];
}

const REVIEWER_MAP = {
  'nicholaspedroso@outlook.com': '192641612659163137',
  'francescolpm@gmail.com':      '884441615886856224',
  'jefsmed@outlook.com':         '190662247603765249',
  'filipefiorentini@gmail.com':  '305950346512039938',
  'cassiolima052000@gmail.com':  '384008601360138240',
};

const CLICKUP_TOKEN   = process.env.CLICKUP_TOKEN   || '';
const CLICKUP_TEAM_ID = process.env.CLICKUP_TEAM_ID || '';

// Mapeamento: evento → status no ClickUp
const CLICKUP_STATUS = {
  review_requested: 'IN REVIEW',
  status_reviewed:  'ACCEPTED',
  status_rework:    'REJECTED',
};

const PORT = process.env.PORT || 3000;

// ─────────────────────────────────────────────
// LEMBRETE DIÁRIO
// ─────────────────────────────────────────────

const REMINDER_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_GENERAL || 'COLE_AQUI_O_WEBHOOK_DO_GENERAL';

let ultimoLembrete = null;

cron.schedule('0 17 * * 1-5', async () => {
  const hoje = new Date().toISOString().slice(0, 10);
  if (ultimoLembrete === hoje) {
    console.log('[CRON] Lembrete já enviado hoje, ignorando duplicata');
    return;
  }
  ultimoLembrete = hoje;

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
      console.error('[CRON] Erro ao enviar lembrete:', await response.text());
    } else {
      console.log('[CRON] Lembrete enviado com sucesso!');
    }
  } catch (err) {
    console.error('[CRON] Erro:', err);
  }
}, { timezone: 'America/Sao_Paulo' });

// ─────────────────────────────────────────────
// CLICKUP
// ─────────────────────────────────────────────

// Extrai o custom ID da task do título do review (ex: "Dev [SD-391]: ..." → "SD-391")
function extractTaskId(reviewTitle) {
  const match = reviewTitle.match(/\[([A-Z]+-\d+)\]/);
  return match ? match[1] : null;
}

// Busca a task pelo custom ID e retorna o task ID interno do ClickUp
async function findTaskByCustomId(customId) {
  if (!CLICKUP_TOKEN || !CLICKUP_TEAM_ID) return null;

  try {
    const url = `https://api.clickup.com/api/v2/team/${CLICKUP_TEAM_ID}/task?custom_task_ids=true&custom_id=${customId}`;
    const res = await fetch(url, {
      headers: { Authorization: CLICKUP_TOKEN },
    });

    if (!res.ok) {
      console.error('[ClickUp] Erro ao buscar task:', res.status, await res.text());
      return null;
    }

    const data = await res.json();
    const task = data.tasks?.[0];
    if (!task) {
      console.warn(`[ClickUp] Task não encontrada para custom ID: ${customId}`);
      return null;
    }

    return task.id;
  } catch (err) {
    console.error('[ClickUp] Erro na busca:', err);
    return null;
  }
}

// Atualiza o status da task no ClickUp
async function updateTaskStatus(taskId, status) {
  if (!CLICKUP_TOKEN) return;

  try {
    const res = await fetch(`https://api.clickup.com/api/v2/task/${taskId}`, {
      method: 'PUT',
      headers: {
        Authorization: CLICKUP_TOKEN,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ status }),
    });

    if (!res.ok) {
      console.error('[ClickUp] Erro ao atualizar status:', res.status, await res.text());
    } else {
      console.log(`[ClickUp] Status atualizado para "${status}" na task ${taskId}`);
    }
  } catch (err) {
    console.error('[ClickUp] Erro ao atualizar:', err);
  }
}

// Orquestra a busca e atualização pelo título do review
async function syncClickUp(reviewTitle, eventType) {
  const newStatus = CLICKUP_STATUS[eventType];
  if (!newStatus) return;

  const customId = extractTaskId(reviewTitle);
  if (!customId) {
    console.warn(`[ClickUp] Nenhum ID de task encontrado no título: "${reviewTitle}"`);
    return;
  }

  console.log(`[ClickUp] Buscando task ${customId}...`);
  const taskId = await findTaskByCustomId(customId);
  if (!taskId) return;

  await updateTaskStatus(taskId, newStatus);
}

// ─────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────

function getMention(email) {
  if (!email) return null;
  const id = REVIEWER_MAP[email.toLowerCase().trim()];
  return id ? `<@${id}>` : `**${email}**`;
}

function detectEvent(payload) {
  if (payload.PLASTIC_REVIEW_ACTION !== undefined) {
    const action     = payload.PLASTIC_REVIEW_ACTION         ?? '';
    const comment    = payload.PLASTIC_REVIEW_COMMENT        ?? '';
    const commentAct = payload.PLASTIC_REVIEW_COMMENT_ACTION ?? '';
    const info       = payload.PLASTIC_REVIEW_ACTION_INFO    ?? '';

    if (action === 'add reviewer' || comment.includes('[requested-review-from')) {
      return 'review_requested';
    }
    if (action === 'update reviewer') {
      if (info.includes(':Reviewed')) return 'status_reviewed';
      if (info.includes(':Rework'))   return 'status_rework';
      return 'ignore';
    }
    if (commentAct === 'Created' && comment.startsWith('[status-')) return 'ignore';
    if (commentAct === 'Created' && comment && !comment.startsWith('[')) return 'comment';
    return 'ignore';
  }

  const desc = payload.embeds?.[0]?.description ?? '';
  if (desc.includes('requested-review-from')) return 'review_requested';
  if (desc.includes('[status-reviewed]'))     return 'status_reviewed';
  if (desc.includes('[status-rework]'))       return 'status_rework';
  if (desc.includes('Under review'))          return 'under_review';
  return 'comment';
}

function parsePayload(payload) {
  if (payload.PLASTIC_REVIEW_ACTION !== undefined) {
    const actionInfo  = payload.PLASTIC_REVIEW_ACTION_INFO ?? '';
    const actionActor = actionInfo.includes(':') ? actionInfo.split(':')[0] : (payload.PLASTIC_USER ?? '');
    const commentText = payload.PLASTIC_REVIEW_COMMENT ?? '';
    const reviewerFromComment = commentText.match(/\[requested-review-from-([^\]]+)\]/)?.[1] ?? null;
    const reviewer = reviewerFromComment
        ?? (actionInfo && !actionInfo.includes(':') ? actionInfo : null)
        ?? payload.PLASTIC_REVIEW_ASSIGNEE
        ?? null;

    return {
      actor:       payload.PLASTIC_REVIEW_OWNER    ?? '',
      actionActor: payload.PLASTIC_USER            ?? '',
      statusActor: actionActor,
      repo:        payload.PLASTIC_REPOSITORY_NAME ?? '',
      reviewName:  payload.PLASTIC_REVIEW_TITLE    ?? 'Code Review',
      eventType:   detectEvent(payload),
      reviewer,
      comment:     (!commentText.startsWith('[') ? commentText : null),
      branch:      payload.PLASTIC_REVIEW_TARGET   ?? '',
      newStatus:   actionInfo.includes(':') ? actionInfo.split(':')[1] : '',
    };
  }

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

function buildMessage(payload) {
  const { actor, actionActor, statusActor, repo, reviewName, eventType, reviewer, comment, newStatus } = parsePayload(payload);

  const ownerMention    = getMention(actor);
  const reviewerMention = getMention(reviewer);
  const statusMention   = getMention(statusActor);

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

  const { eventType, repo, reviewName } = parsePayload(payload);
  if (eventType === 'ignore' || eventType === 'under_review') {
    console.log('[UVCS] Evento ignorado:', eventType);
    return res.sendStatus(200);
  }

  const discordBody = buildMessage(payload);
  if (!discordBody) {
    console.log('[UVCS] Evento não mapeado, ignorado');
    return res.sendStatus(200);
  }

  // Dispara Discord e ClickUp em paralelo
  await Promise.allSettled([
    // Discord
    fetch(getWebhookUrl(repo), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(discordBody),
    }).then(async r => {
      if (!r.ok) console.error('[Discord] Erro:', r.status, await r.text());
      else console.log(`[Discord] Mensagem enviada — evento: ${eventType}`);
    }),

    // ClickUp (só para eventos que alteram status)
    ['review_requested', 'status_reviewed', 'status_rework'].includes(eventType)
        ? syncClickUp(reviewName, eventType)
        : Promise.resolve(),
  ]);

  res.sendStatus(200);
});

// ─────────────────────────────────────────────
// HEALTH CHECK
// ─────────────────────────────────────────────

app.get('/', (req, res) => res.json({ status: 'online' }));

app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});