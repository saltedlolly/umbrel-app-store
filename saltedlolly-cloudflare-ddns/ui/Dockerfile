FROM node:18-alpine

# Install wget for healthchecks
RUN apk add --no-cache wget

# Create app directory
WORKDIR /usr/src/app

# Copy UI package json and install production deps
COPY ui/package*.json ./
RUN npm install --only=production

# Copy UI files into the image
COPY ui/ ./

# Copy the project logo into the UI public folder (context is repository root)
COPY logo.png ./public/logo.png

EXPOSE 3000
CMD ["node", "server.js"]
