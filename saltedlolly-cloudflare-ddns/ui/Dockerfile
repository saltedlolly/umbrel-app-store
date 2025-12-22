FROM node:18-alpine

# Install wget for healthchecks
RUN apk add --no-cache wget

# Create app directory
WORKDIR /usr/src/app

# Accept version as build argument
ARG VERSION=unknown

# Copy UI package json and install production deps
COPY ui/package*.json ./
RUN npm install --only=production

# Copy UI files into the image
COPY ui/ ./

# Write version to a file that server.js can read
RUN echo "{\"version\": \"${VERSION}\"}" > version.json

EXPOSE 3000
CMD ["node", "server.js"]
