const express = require('express');
const cron = require('node-cron');
const app = express();
app.use(express.json());

// ─────────────────────────────────────────────
// CONFIGURAÇÕES
// ─────────────────────────────────────────────

const REPO_WEBHOOKS = {
  'Sundried-Art': process.env.DISCORD_WEBHOOK_ART || '',
  'Sundried-Dev': process.env.DISCORD_WEBHOOK_DEV || '',
};

function getWebhookUrl(repo) {
  for (const [key, url] of Object.entries(REPO_WEBHOOKS)) {
    if (repo.includes(key)) return url;
  }
  return Object.values(REPO_WEBHOOKS)[0];
}

const REVIEWER_MAP = {
  'nicholaspedroso@outlook.com': '192641612659163137',
  'francescolpm@gmail.com': '884441615886856224',
  'jefsmed@outlook.com': '190662247603765249',
  'filipefiorentini@gmail.com': '305950346512039938',
  'cassiolima052000@gmail.com': '384008601360138240',
  'nicolaschiquito2023@gmail.com': '1484621389108350987',
};

const CLICKUP_TOKEN = process.env.CLICKUP_TOKEN || '';
const CLICKUP_TEAM_ID = process.env.CLICKUP_TEAM_ID || '';

const CLICKUP_STATUS = {
  review_requested: 'IN REVIEW',
  status_reviewed: 'ACCEPTED',
  status_rework: 'REJECTED',
};

const PORT = process.env.PORT || 3000;

// ─────────────────────────────────────────────
// DEDUP — evita processar o mesmo evento duas vezes
// O UVCS dispara "add reviewer" + "[requested-review-from-EMAIL]" para o mesmo revisor
// ─────────────────────────────────────────────

const recentEvents = new Map();

function isDuplicate(key) {
  const now = Date.now();
  if (recentEvents.has(key) && now - recentEvents.get(key) < 10000) {
    return true; // mesmo evento nos últimos 10 segundos
  }
  recentEvents.set(key, now);
  // Limpa entradas antigas para não acumular memória
  for (const [k, t] of recentEvents.entries()) {
    if (now - t > 60000) recentEvents.delete(k);
  }
  return false;
}

// ─────────────────────────────────────────────
// LEMBRETE DIÁRIO
// ─────────────────────────────────────────────

const REMINDER_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_GENERAL || '';
const fs = require('fs');
const path = require('path');
const LOCK_FILE = path.join('/tmp', 'lembrete.lock');

cron.schedule('0 17 * * 1-5', async () => {
  const hoje = new Date().toISOString().slice(0, 10);
  // Usa arquivo em /tmp para sobreviver a múltiplas instâncias no mesmo host
  try {
    if (fs.existsSync(LOCK_FILE)) {
      const data = fs.readFileSync(LOCK_FILE, 'utf8').trim();
      if (data === hoje) {
        console.log('[CRON] Lembrete já enviado hoje, ignorando duplicata');
        return;
      }
    }
    fs.writeFileSync(LOCK_FILE, hoje, 'utf8');
  } catch (err) {
    console.warn('[CRON] Erro no lock file, continuando mesmo assim:', err.message);
  }
  console.log('[CRON] Enviando lembrete diário...');
  try {
    const response = await fetch(REMINDER_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content: '@here Lembre-se de lançar suas horas nas tarefas em que trabalhou no dia de hoje! E também subir prints/vídeos nos cards das tarefas no ClickUp!',
      }),
    });
    if (!response.ok) console.error('[CRON] Erro:', await response.text());
    else console.log('[CRON] Lembrete enviado com sucesso!');
  } catch (err) {
    console.error('[CRON] Erro:', err);
  }
}, { timezone: 'America/Sao_Paulo' });

// ─────────────────────────────────────────────
// CLICKUP
// ─────────────────────────────────────────────

function extractTaskId(reviewTitle) {
  const match = reviewTitle.match(/\[([A-Z]+-\d+)\]/);
  return match ? match[1] : null;
}

async function findTaskByCustomId(customId) {
  if (!CLICKUP_TOKEN || !CLICKUP_TEAM_ID) return null;
  try {
    const url = `https://api.clickup.com/api/v2/task/${customId}?custom_task_ids=true&team_id=${CLICKUP_TEAM_ID}`;
    const res = await fetch(url, {
      headers: { Authorization: CLICKUP_TOKEN },
    });
    if (!res.ok) {
      console.error('[ClickUp] Erro ao buscar task:', res.status, await res.text());
      return null;
    }
    const task = await res.json();
    if (!task?.id) {
      console.warn(`[ClickUp] Task "${customId}" não encontrada`);
      return null;
    }
    console.log(`[ClickUp] Task encontrada: ${task.custom_id} (${task.name}) → ID: ${task.id}`);
    return task.id;
  } catch (err) {
    console.error('[ClickUp] Erro na busca:', err);
    return null;
  }
}

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
    if (!res.ok) console.error('[ClickUp] Erro ao atualizar status:', res.status, await res.text());
    else console.log(`[ClickUp] Status atualizado para "${status}" na task ${taskId}`);
  } catch (err) {
    console.error('[ClickUp] Erro ao atualizar:', err);
  }
}

async function postClickUpComment(taskId, comment, author) {
  if (!CLICKUP_TOKEN || !comment) return;
  try {
    const res = await fetch(`https://api.clickup.com/api/v2/task/${taskId}/comment`, {
      method: 'POST',
      headers: {
        Authorization: CLICKUP_TOKEN,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        comment_text: `**[Code Review - ${author}]**\n${comment}`,
        notify_all: false,
      }),
    });
    if (!res.ok) console.error('[ClickUp] Erro ao postar comentário:', res.status, await res.text());
    else console.log(`[ClickUp] Comentário postado na task ${taskId}`);
  } catch (err) {
    console.error('[ClickUp] Erro ao postar comentário:', err);
  }
}

async function syncClickUp(reviewTitle, eventType, options = {}) {
  const newStatus = CLICKUP_STATUS[eventType];
  const customId = extractTaskId(reviewTitle);
  if (!customId) {
    console.warn(`[ClickUp] Nenhum ID encontrado no título: "${reviewTitle}"`);
    return;
  }
  console.log(`[ClickUp] Buscando task ${customId}...`);
  const taskId = await findTaskByCustomId(customId);
  if (!taskId) return;

  const actions = [];
  if (newStatus) actions.push(updateTaskStatus(taskId, newStatus));
  if (options.comment && options.author) actions.push(postClickUpComment(taskId, options.comment, options.author));

  await Promise.allSettled(actions);
}

// ─────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────

function getMention(email) {
  if (!email) return null;
  const id = REVIEWER_MAP[email.toLowerCase().trim()];
  return id ? `<@${id}>` : `**${email}**`;
}

// Verifica se todos os revisores já finalizaram (nenhum com "Under review")
function allReviewersFinished(payload) {
  const reviewers = payload.PLASTIC_REVIEW_REVIEWERS ?? '';
  if (!reviewers) return true; // sem revisores, considera finalizado
  return !reviewers.split(';').some(r => r.includes(':Under review'));
}

// Verifica se algum revisor pediu Rework
function anyReviewerRework(payload) {
  const reviewers = payload.PLASTIC_REVIEW_REVIEWERS ?? '';
  return reviewers.split(';').some(r => r.includes(':Rework'));
}

function detectEvent(payload) {
  if (payload.PLASTIC_REVIEW_ACTION !== undefined) {
    const action = payload.PLASTIC_REVIEW_ACTION ?? '';
    const comment = payload.PLASTIC_REVIEW_COMMENT ?? '';
    const commentAct = payload.PLASTIC_REVIEW_COMMENT_ACTION ?? '';
    const info = payload.PLASTIC_REVIEW_ACTION_INFO ?? '';
    const status = payload.PLASTIC_REVIEW_STATUS ?? '';

    // Ignora evento de criação do review (after-mkreview) — sem ACTION e sem revisores ainda
    const isCreationEvent = !action && !commentAct && payload.content?.includes('New code review');
    if (isCreationEvent) return 'ignore';

    // Abertura — só processa "add reviewer" com ACTION_INFO preenchido
    // Ignora o evento duplicado "[requested-review-from-EMAIL]" que vem logo depois
    if (action === 'add reviewer' && info && !info.includes(':')) return 'review_requested';

    // Mudança de status — só processa quando TODOS os revisores finalizaram
    if (action === 'update reviewer') {
      if (!allReviewersFinished(payload)) {
        console.log('[UVCS] Revisores ainda pendentes, aguardando todos finalizarem');
        return 'ignore';
      }
      // Se algum pediu Rework, prioriza Rework sobre Reviewed
      if (anyReviewerRework(payload)) return 'status_rework';
      if (info.includes(':Reviewed')) return 'status_reviewed';
      return 'ignore';
    }

    // Ignora comentários automáticos (incluindo o [requested-review-from-EMAIL] duplicado)
    if (commentAct === 'Created' && comment.startsWith('[')) return 'ignore';

    // Comentário real
    if (commentAct === 'Created' && comment) return 'comment';

    return 'ignore';
  }

  // Payload legado via embeds (não usado em produção)
  const desc = payload.embeds?.[0]?.description ?? '';
  if (desc.includes('requested-review-from')) return 'review_requested';
  if (desc.includes('[status-reviewed]')) return 'status_reviewed';
  if (desc.includes('[status-rework]')) return 'status_rework';
  if (desc.includes('Under review')) return 'under_review';
  return 'comment';
}

function parsePayload(payload) {
  if (payload.PLASTIC_REVIEW_ACTION !== undefined) {
    const actionInfo = payload.PLASTIC_REVIEW_ACTION_INFO ?? '';
    const actionActor = actionInfo.includes(':') ? actionInfo.split(':')[0] : (payload.PLASTIC_USER ?? '');
    const commentText = payload.PLASTIC_REVIEW_COMMENT ?? '';

    // No "add reviewer" o revisor está no ACTION_INFO diretamente
    const reviewer = (actionInfo && !actionInfo.includes(':') ? actionInfo : null)
      ?? payload.PLASTIC_REVIEW_ASSIGNEE
      ?? null;

    // Extrai comentário de eventos de status: "[status-rework-required]Texto do comentário"
    const statusCommentMatch = commentText.match(/^\[status-[^\]]+\](.+)/s);
    const statusComment = statusCommentMatch ? statusCommentMatch[1].trim() : null;
    const plainComment = !commentText.startsWith('[') ? commentText : null;

    return {
      actor: payload.PLASTIC_REVIEW_OWNER ?? '',
      actionActor: payload.PLASTIC_USER ?? '',
      statusActor: actionActor,
      repo: payload.PLASTIC_REPOSITORY_NAME ?? '',
      reviewName: payload.PLASTIC_REVIEW_TITLE ?? 'Code Review',
      eventType: detectEvent(payload),
      reviewer,
      comment: plainComment,
      statusComment,
      branch: payload.PLASTIC_REVIEW_TARGET ?? '',
      newStatus: actionInfo.includes(':') ? actionInfo.split(':')[1] : '',
    };
  }

  const embed = payload.embeds?.[0] ?? {};
  const desc = embed.description ?? '';
  const reviewerMatch = desc.match(/\[requested-review-from-([^\]]+)\]/);
  return {
    actor: embed.title ?? '',
    actionActor: embed.title ?? '',
    statusActor: embed.title ?? '',
    repo: embed.footer?.text ?? '',
    reviewName: payload.content?.match(/review `([^`]+)`/)?.[1] ?? 'Code Review',
    eventType: detectEvent(payload),
    reviewer: reviewerMatch ? reviewerMatch[1] : null,
    comment: desc.replace(/<plastic:\/\/[^>]+>/g, '').replace(/\[.*?\]/g, '').trim() || null,
    branch: '',
    newStatus: '',
  };
}

function buildMessage(payload) {
  const { actor, actionActor, statusActor, repo, reviewName, eventType, reviewer, comment, statusComment, newStatus } = parsePayload(payload);

  const ownerMention = getMention(actor);
  const reviewerMention = getMention(reviewer);
  const statusMention = getMention(statusActor);

  const statusLabel = newStatus.toLowerCase().includes('review') ? 'Reviewed ✅'
    : newStatus.toLowerCase().includes('rework') ? 'Rework Required ⚠️'
      : newStatus;

  switch (eventType) {

    case 'review_requested':
      return {
        content: `${ownerMention} abriu um novo review para ${reviewerMention}`,
        embeds: [{
          title: `🔍 ${reviewName}`,
          color: 0x5865F2,
          fields: [
            { name: '✏️ Autor', value: actor || 'desconhecido', inline: true },
            { name: '👤 Revisor', value: reviewer || 'desconhecido', inline: true },
            { name: '📁 Repositório', value: repo || 'desconhecido', inline: true },
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
          description: statusComment ?? undefined,
          fields: [
            { name: '👤 Alterado por', value: statusActor || 'desconhecido', inline: true },
            { name: '📁 Repositório', value: repo || 'desconhecido', inline: true },
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
            { name: '📁 Repositório', value: repo || 'desconhecido', inline: true },
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
// ROTA PRINCIPAL
// ─────────────────────────────────────────────

app.post('/uvcs-webhook', async (req, res) => {
  const payload = req.body;
  console.log('[UVCS] Payload recebido:', JSON.stringify(payload, null, 2));

  const { eventType, repo, reviewName, reviewer, statusComment, comment, actionActor } = parsePayload(payload);

  // Ignora webhooks de repositórios não mapeados (outros projetos)
  const repoConhecido = Object.keys(REPO_WEBHOOKS).some(k => repo.includes(k));
  if (!repoConhecido) {
    console.log(`[UVCS] Repositório ignorado (não mapeado): "${repo}"`);
    return res.sendStatus(200);
  }

  if (eventType === 'ignore' || eventType === 'under_review') {
    console.log('[UVCS] Evento ignorado:', eventType);
    return res.sendStatus(200);
  }

  // Chave de dedup: tipo de evento + review ID + revisor (se houver)
  const reviewId = payload.PLASTIC_REVIEW_ID ?? '';
  const dedupKey = `${eventType}:${reviewId}:${reviewer ?? ''}`;
  if (isDuplicate(dedupKey)) {
    console.log(`[UVCS] Duplicata ignorada: ${dedupKey}`);
    return res.sendStatus(200);
  }

  const discordBody = buildMessage(payload);
  if (!discordBody) {
    console.log('[UVCS] Evento não mapeado, ignorado');
    return res.sendStatus(200);
  }

  await Promise.allSettled([
    fetch(getWebhookUrl(repo), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(discordBody),
    }).then(async r => {
      if (!r.ok) console.error('[Discord] Erro:', r.status, await r.text());
      else console.log(`[Discord] Mensagem enviada — evento: ${eventType}`);
    }),

    ['review_requested', 'status_reviewed', 'status_rework'].includes(eventType)
      ? syncClickUp(reviewName, eventType, { comment: statusComment ?? comment, author: actionActor })
      : eventType === 'comment' && comment
        ? syncClickUp(reviewName, 'comment', { comment, author: actionActor })
        : Promise.resolve(),
  ]);

  res.sendStatus(200);
});

// ─────────────────────────────────────────────
// HEALTH CHECK
// ─────────────────────────────────────────────

app.get('/', (req, res) => res.json({ status: 'online' }));

app.listen(PORT, () => console.log(`Servidor rodando na porta ${PORT}`));