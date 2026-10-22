FROM node:20-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY server.js ./
COPY timer.ttf ./fonts/timer.ttf
ENV TIMER_FONT_PATH=/app/fonts/timer.ttf
ENV PORT=8080
EXPOSE 8080
CMD ["node", "server.js"]
