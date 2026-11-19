# Restaurant Cashier Dashboard (Kasir Restoran)

A modern restaurant POS cashier dashboard backend and frontend built with Node.js, Express, MySQL 8, and vanilla HTML/CSS/JS.

## Prerequisites

- **Node.js**: v18 or higher
- **Docker**: Docker Desktop or Rancher Desktop (using `dockerd` / moby container engine) with Docker Compose v2

---

## Quick Start

Follow these steps to run the application for the first time:

1. **Clone the repository:**
   ```bash
   git clone <repository-url>
   cd restoran
   ```

2. **Install Node.js dependencies:**
   ```bash
   npm install
   ```

3. **Configure environment variables:**
   - On Windows:
     ```cmd
     copy .env.example .env
     ```
   - On macOS / Linux:
     ```bash
     cp .env.example .env
     ```

4. **Start the MySQL database container:**
   ```bash
   npm run db:up
   ```

5. **Wait until the database container is healthy:**
   ```bash
   docker compose ps
   ```
   *(Wait until the status displays `healthy`)*

6. **Seed users with bcrypt hashes:**
   ```bash
   npm run db:seed
   ```

7. **Start the Node.js server:**
   ```bash
   node server.js
   ```

8. **Open the dashboard in your browser:**
   Navigate to [http://localhost:3000](http://localhost:3000)

---

## Default Development Credentials

After running `npm run db:seed`:
- **Kasir:** `budi` / `admin123`
- **Kasir:** `sari` / `admin123`
- **Supervisor:** `spv` / `admin123` (Supervisor PIN: `1234`)
- **Admin:** `admin` / `admin123` (Admin PIN: `1234`)

> ⚠️ **Warning:** These credentials and PINs are intended strictly for local development and testing. Always change them before deploying to production.

---

## Database

### Connecting with DBeaver / HeidiSQL / GUI Tools
- **Host:** `localhost`
- **Port:** `3307` (mapped to container's internal 3306)
- **User:** `root`
- **Password:** value of `DB_PASSWORD` in `.env` (default: `rootpass`)
- **Database:** `kasir_restoran`

### Database Management Commands
- **Start database:**
  ```bash
  npm run db:up
  ```
- **Stop database:**
  ```bash
  npm run db:down
  ```
- **View container logs:**
  ```bash
  npm run db:logs
  ```
- **Open interactive MySQL shell:**
  ```bash
  npm run db:shell
  ```
- **Reset database (wipes all data & re-runs `database/kasir_restoran.sql`):**
  ```bash
  npm run db:reset
  ```
- **Export current database changes back to `database/kasir_restoran.sql`:**
  ```bash
  npm run db:dump
  ```
  *(After dumping changes, review and commit `database/kasir_restoran.sql` to Git)*

---

## Important Notes

- **Initial SQL Execution:** The initialization script `database/kasir_restoran.sql` runs **only once** on the first container startup when the volume `dbdata` is empty.
- **Applying Schema Changes:** Modifying `database/kasir_restoran.sql` does not update an already initialized volume. To apply schema updates, run `npm run db:reset` (caution: this deletes all existing container data).
- **DROP DATABASE Caution:** `database/kasir_restoran.sql` starts with `DROP DATABASE IF EXISTS kasir_restoran;`. Never run this script manually against a production database holding live data.
- **Security:** Never commit `.env` containing sensitive credentials to Git. Keep `.env.example` updated with safe placeholder values.

---

## Troubleshooting

- **Port 3307 already in use:**
  If port `3307` is occupied by another service on your host, edit `DB_PORT` in your `.env` file (e.g. `DB_PORT=3308`), then restart the container with `npm run db:up`.
- **"Access denied for user 'root'":**
  Ensure `MYSQL_ROOT_PASSWORD` matches `DB_PASSWORD` in `.env`. Note that MySQL initializes the root password only on first startup. If you changed the password in `.env` after the volume was already created, run `npm run db:reset` to recreate the volume with the new password.
- **Container unhealthy:**
  Check the database startup logs to diagnose the issue:
  ```bash
  npm run db:logs
  ```

---

## Optional: Full Stack in Docker

To run both MySQL and the Node.js app inside Docker containers:
```bash
docker compose --profile full up -d
```
The application will be accessible at [http://localhost:3000](http://localhost:3000).
