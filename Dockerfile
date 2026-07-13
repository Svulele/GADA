FROM node:20-alpine

WORKDIR /app

# Install deps first so this layer is cached when only source changes
COPY package*.json ./
RUN npm ci --omit=dev

# Copy the rest of the app
COPY . .

# entrypoint.sh links the DB/config files onto the persistent /data volume
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

ENV NODE_ENV=production
EXPOSE 3000

ENTRYPOINT ["/entrypoint.sh"]
CMD ["node", "server.js"]
