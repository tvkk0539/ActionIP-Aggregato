# Use official Node.js 20 (LTS) Alpine image for small footprint
FROM node:20-alpine

# Set the working directory inside the container
WORKDIR /usr/src/app

# Copy package definition files first to leverage Docker cache
COPY package*.json ./

# Install production dependencies only
RUN npm ci --only=production

# Copy the rest of the application code
COPY . .

# Expose the application port (defaults to 8080 in config.js)
EXPOSE 8080

# Define the command to run the app
CMD [ "npm", "start" ]
