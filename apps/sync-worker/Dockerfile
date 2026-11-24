# syntax=docker/dockerfile:1

FROM node:22-alpine AS deps
WORKDIR /app

COPY package.json package-lock.json ./
COPY packages/shared/package.json ./packages/shared/package.json
COPY apps/sync-worker/package.json ./apps/sync-worker/package.json
COPY apps/api/package.json ./apps/api/package.json
COPY apps/web/package.json ./apps/web/package.json

RUN npm ci --omit=dev --omit=optional --ignore-scripts --workspace=@clairflux/sync-worker --workspace=@clairflux/shared --include-workspace-root \
    || npm install --omit=dev --omit=optional --ignore-scripts --no-audit --no-fund --workspace=@clairflux/sync-worker --workspace=@clairflux/shared --include-workspace-root \
  && npm cache clean --force

FROM node:22-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production \
    PORT=4001

COPY --from=deps --chown=node:node /app/package.json ./package.json
COPY --from=deps --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node packages/shared/package.json ./packages/shared/package.json
COPY --chown=node:node packages/shared/src ./packages/shared/src
COPY --chown=node:node apps/sync-worker/package.json ./apps/sync-worker/package.json
COPY --chown=node:node apps/sync-worker/src ./apps/sync-worker/src

RUN cat <<'EOF' > /app/.ts-loader.mjs
import { register } from 'node:module';

const hook = `
export async function resolve(specifier, context, nextResolve) {
  try {
    return await nextResolve(specifier, context);
  } catch (err) {
    if (err && err.code === 'ERR_MODULE_NOT_FOUND' && specifier.startsWith('.')) {
      if (specifier.endsWith('.js')) {
        return nextResolve(specifier.slice(0, -3) + '.ts', context);
      }
      if (!/\\.[a-z0-9]+$/i.test(specifier)) {
        return nextResolve(specifier + '.ts', context);
      }
    }
    throw err;
  }
}
`;

register('data:text/javascript,' + encodeURIComponent(hook));
EOF
RUN chown node:node /app/.ts-loader.mjs

USER node

EXPOSE 4001

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:4001/healthz').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "--experimental-strip-types", "--import", "/app/.ts-loader.mjs", "apps/sync-worker/src/gemini-pipeline.ts"]
