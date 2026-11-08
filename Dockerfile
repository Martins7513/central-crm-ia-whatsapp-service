# Central CRM IA — Microsserviço WhatsApp (Baileys)
# Dockerfile pronto para deploy no Railway (ou qualquer plataforma com suporte a Docker)

FROM node:20-bookworm-slim

# Dependências de sistema necessárias para algumas libs nativas usadas pelo Baileys.
# "ca-certificates" é essencial: sem ele o git não consegue validar o certificado
# SSL do GitHub ao baixar dependências via HTTPS (erro "server certificate
# verification failed. CAfile: none CRLfile: none").
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    make \
    g++ \
    git \
    ca-certificates \
    && update-ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# O Baileys depende internamente de um pacote (libsignal) hospedado no GitHub,
# referenciado via protocolo git/ssh. Containers de build (como o do Railway)
# não têm chave SSH configurada, o que faz o "npm install" falhar com o erro
# "Could not read from remote repository". A correção é forçar o git a usar
# HTTPS em vez de SSH/git:// para qualquer acesso ao GitHub.
# IMPORTANTE: usamos "--add" nas regras repetidas porque "git config --global"
# sem --add SOBRESCREVE uma regra "insteadOf" anterior com a mesma chave, em
# vez de somar as duas — por isso a primeira tentativa não funcionou.
RUN git config --global url."https://github.com/".insteadOf "ssh://git@github.com/" \
    && git config --global --add url."https://github.com/".insteadOf "git@github.com:" \
    && git config --global --add url."https://".insteadOf "git://"

COPY package.json ./
RUN npm install --omit=dev

COPY server.js ./

# Pasta onde as sessões autenticadas do WhatsApp ficam salvas.
# IMPORTANTE: o Railway NÃO aceita a instrução Docker "VOLUME" no Dockerfile
# (ela é rejeitada na validação do build). Volumes persistentes no Railway
# são configurados pela própria interface (Service → Settings → Volumes),
# apontando o Mount Path para este mesmo caminho: /app/sessions
RUN mkdir -p /app/sessions

ENV SESSIONS_DIR=/app/sessions
ENV PORT=3000

EXPOSE 3000

CMD ["node", "server.js"]
