# uvcs-discord-bot

Servidor intermediário que recebe webhooks do Unity Version Control (Plastic SCM) e envia notificações de Code Review para o Discord **mencionando o revisor designado**.

---

## Como funciona

```
UVCS (webhook) → Este servidor → Discord (com @menção ao revisor)
```

---

## Configuração

### 1. Instalar dependências

```bash
npm install
```

### 2. Configurar variáveis de ambiente

Crie um arquivo `.env` na raiz do projeto (copie o `.env.example`):

```bash
cp .env.example .env
```

Edite o `.env` com o webhook do seu canal Discord:

```
DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/SEU_ID/SEU_TOKEN
```

**Como obter o Webhook URL do Discord:**
1. Abra o canal do Discord
2. Editar Canal → Integrações → Webhooks
3. Criar Webhook → Copiar URL do Webhook

### 3. Mapear revisores (obrigatório)

Abra o `index.js` e edite o objeto `REVIEWER_MAP` com os usernames do UVCS e os IDs do Discord:

```js
const REVIEWER_MAP = {
  'joao.silva':  '111111111111111111',
  'maria.souza': '222222222222222222',
};
```

**Como obter o User ID do Discord:**
1. Discord → Configurações → Avançado → Ativar **Modo Desenvolvedor**
2. Clique com botão direito no usuário
3. "Copiar ID do usuário"

---

## Executar

```bash
# Produção
npm start

# Desenvolvimento (reinicia ao salvar)
npm run dev
```

O servidor sobe na porta `3000` (ou na porta definida em `PORT` no `.env`).

---

## Configurar no Unity DevOps

1. Acesse **Unity Dashboard → DevOps → Version Control → Settings → Integrations**
2. Clique em **Webhook → New Integration**
3. Em **Payload URL**, coloque:
   ```
   https://SEU-DOMINIO.com/uvcs-webhook
   ```
4. Selecione o repositório e marque o evento **Code Review**
5. Salve

---

## Testar localmente

Com o servidor rodando, abra no navegador:

```
http://localhost:3000/test
```

Isso simula um payload de Code Review e envia uma mensagem de teste para o Discord.

---

## Hospedagem recomendada

| Plataforma  | Custo      | Como fazer                                      |
|-------------|------------|-------------------------------------------------|
| **Railway** | Gratuito*  | Conecte o repositório GitHub, deploy automático |
| **Render**  | Gratuito*  | Web Service → conecte o repo → `npm start`      |
| **Fly.io**  | Gratuito*  | `fly launch` no terminal                        |
| **VPS**     | ~$5/mês    | `node index.js` ou use PM2                      |

*Planos gratuitos têm limitações de uso, mas são suficientes para este caso.

### Deploy no Railway (mais simples)

1. Suba o projeto para um repositório GitHub
2. Acesse [railway.app](https://railway.app) e crie um novo projeto
3. Selecione **Deploy from GitHub repo**
4. Em **Variables**, adicione `DISCORD_WEBHOOK_URL` com o valor correto
5. O Railway detecta o `package.json` e roda `npm start` automaticamente

---

## Estrutura do projeto

```
uvcs-discord-bot/
├── index.js        ← servidor principal
├── .env.example    ← modelo de variáveis de ambiente
├── .env            ← suas variáveis (não versionar!)
├── .gitignore
└── package.json
```
