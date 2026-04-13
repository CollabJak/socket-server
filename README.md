# CollabJak Socket Server

A high-performance, secure Socket.io server built with Express and Redis, designed for real-time notifications and data synchronization for the CollabJak POS system.

## Features

- **Real-time Communication**: Powered by Socket.io.
- **JWT Authentication**: Secure client connection with JWT validation and JTI (JWT ID) replay protection via Redis.
- **Server-to-Client Emitter**: Secure HTTP endpoint to trigger socket events from other services (e.g., Laravel backend) using HMAC signatures.
- **Rate Limiting**: Built-in rate limiting for both client events and server emissions.
- **Event Allowlisting**: Strict control over which events can be sent and received.
- **Room Scoping**: Support for business-level and location-level rooms.

---

## Installation

### Prerequisites

- [Node.js](https://nodejs.org/) (v18 or later recommended)
- [Redis](https://redis.io/) (required for JTI replay protection and production environments)

### Setup

1. Clone the repository:
   ```bash
   git clone https://github.com/CollabJak/socket-server.git
   cd socket-server
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

3. Configure environment variables:
   Copy the `.env.example` to `.env` and fill in the values:
   ```bash
   cp .env.example .env
   ```

---

## Configuration

The following environment variables are supported:

| Variable | Description | Default |
| :--- | :--- | :--- |
| `PORT` | The port on which the server will listen. | `3001` |
| `SOCKET_JWT_SECRET` | Secret key used to verify client JWT tokens. | *Required* |
| `SOCKET_SERVER_SECRET` | Secret key used for HMAC signature validation on `/emit`. | *Required* |
| `REDIS_URL` | Redis connection URL (e.g., `redis://localhost:6379`). | `""` |
| `SOCKET_CORS_ORIGIN` | Allowed origins for CORS (comma-separated). | `*` |
| `SOCKET_CLIENT_EVENT_ALLOWLIST` | Events allowed from client to server (comma-separated). | `""` |
| `SOCKET_SERVER_EVENT_ALLOWLIST`| Events allowed from server to client (comma-separated). | `stock.updated` |
| `SOCKET_JTI_REPLAY_STRICT` | Whether to strictly enforce JTI replay protection. | `true` |

---

## Running the Server

### Development Mode
```bash
node server.js
```

### Production Mode
It is recommended to use a process manager like [PM2](https://pm2.keymetrics.io/):
```bash
pm2 start server.js --name "socket-server"
```

---

## API Endpoints

### 1. Health Check
Checks if the server is running.
- **URL**: `/health`
- **Method**: `GET`
- **Response**: `{ "ok": true }`

### 2. Emit Event (Server-to-Client)
Securely emit events to connected clients from an authorized backend.
- **URL**: `/emit`
- **Method**: `POST`
- **Payload**:
  ```json
  {
    "event": "stock.updated",
    "room": "location:1:5",
    "data": { "product_id": 123, "new_stock": 10 },
    "ts": 1673456789,
    "signature": "hmac_sha256_signature"
  }
  ```
- **Authentication**: Requires an HMAC-SHA256 signature in the payload, calculated using `SOCKET_SERVER_SECRET`.

---

## Security Details

### Client Authentication
Clients must connect with a valid JWT in the `auth` object:
```javascript
const socket = io("http://localhost:3001", {
  auth: {
    token: "YOUR_JWT_TOKEN"
  }
});
```
The JWT payload should include:
- `sub` or `user_id`: Numeric ID of the user.
- `business_id`: Numeric ID of the business.
- `location_ids`: Array of numeric IDs for accessible locations.
- `jti`: Unique token identifier (used for replay protection).

### HMAC Signature Calculation
For the `/emit` endpoint, the signature is calculated by:
1. Creating a JSON payload including `event`, `room`, `data`, and `ts`.
2. Sorting keys alphabetically for stable stringification.
3. Calculating HMAC-SHA256 of the stringified payload using `SOCKET_SERVER_SECRET`.

---

## License

This project is licensed under the [ISC License](LICENSE).
