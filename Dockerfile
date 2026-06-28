FROM node:22-bookworm

WORKDIR /app

ENV NODE_ENV=production
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

COPY package.json package-lock.json* ./
RUN npm install --omit=dev
RUN npx playwright install --with-deps chromium

COPY src ./src

EXPOSE 3000

CMD ["npm", "start"]
