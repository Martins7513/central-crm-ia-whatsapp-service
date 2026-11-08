# Central CRM IA — Microsserviço WhatsApp (Baileys)
# Dockerfile pronto para deploy no Railway (ou qualquer plataforma com suporte a Docker)

FROM node:20-bookworm-slim

# Dependências de sistema necessárias para algumas libs nativas usadas pelo Baileys
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    make \
    g++ \
    git \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY server.js ./

# Pasta onde as sessões autenticadas do WhatsApp ficam salvas.
# No Railway, monte um Volume apontando para este caminho para persistir
# a sessão entre deploys/restarts (senão será necessário escanear o QR
# novamente a cada novo deploy).
RUN mkdir -p /app/sessions
VOLUME ["/app/sessions"]

ENV SESSIONS_DIR=/app/sessions
ENV PORT=3000

EXPOSE 3000

CMD ["node", "server.js"]
