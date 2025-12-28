FROM node:18-alpine

WORKDIR /app

# Copy the share-waiter script
COPY wait-for-shares.js ./wait-for-shares.js

# Set the entrypoint to run the script
ENTRYPOINT ["node", "/app/wait-for-shares.js"]
