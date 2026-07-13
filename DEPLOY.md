# GADA Deployment Guide

This guide covers deploying GADA with a managed Postgres database and a hosted Node.js app.
It is designed for a production-ready setup using:

- Supabase for Postgres
- Render (recommended) or Railway for Node hosting

> Note: Vercel is not ideal for a long-running Express server unless you refactor the app into serverless functions.

---

## 1. Prepare Supabase

1. Create a new Supabase project.
2. In the Supabase dashboard, copy the `DATABASE_URL` connection string.
3. Make sure the database is set to a size/location that fits your free-tier workload.

## 2. Configure the app locally

1. Copy the example env file:

```bash
cp .env.example .env
```

2. Edit `.env` and set:

```env
PORT=3000
SESSION_SECRET=replace-this-with-a-long-random-string
NODE_ENV=production
DATABASE_URL=postgres://user:password@host:5432/database
```

3. If you prefer to keep config in environment variables instead of `config.json`, add either:

```env
CONFIG_JSON_PATH=./config.json
```

or inline:

```env
CONFIG_JSON={"locations":["Reception","Ward A"],"users":[{"id":"admin","name":"Admin","role":"Admin","department":"Admin","access":"admin","pin":"0000"}]}
```

4. Install dependencies:

```bash
npm install
```

## 3. Provision the Postgres schema

The app auto-creates the required tables when it starts if `DATABASE_URL` is present.
However, if you want to migrate existing local data from `gada.db`, use the migration script below.

### Migrate local SQLite data into Supabase

Set `DATABASE_URL` in `.env` or export it in your terminal, then run:

```bash
export DATABASE_URL="postgres://..."
npm run migrate:sqlite-to-postgres
```

This script:
- creates the `assets` and `events` tables if needed,
- truncates destination tables,
- imports records from your local `gada.db`,
- resets Postgres sequences.

If you see `getaddrinfo ENOTFOUND db...supabase.co`, the database hostname in
`DATABASE_URL` is not resolving. In Supabase, open your project and copy the
current connection string from **Project Settings > Database > Connection
string**, then replace `[YOUR-PASSWORD]` with the database password. If the
project was paused/deleted or the project reference was mistyped, the `db.<ref>.supabase.co`
hostname will not resolve.

## 4. Deploy the app to Render (recommended)

### Create a new service

1. Go to `https://dashboard.render.com` and create a new Web Service.
2. Connect your GitHub repo or use the direct repo upload.
3. Set the build command:

```bash
npm install
```

4. Set the start command:

```bash
npm start
```

### Add environment variables

Set these in the Render dashboard:

- `DATABASE_URL`
- `SESSION_SECRET`
- `NODE_ENV=production`
- Optional: `CONFIG_JSON_PATH` or `CONFIG_JSON`

### Deploy

Deploy the service and verify that the app starts successfully.

## 5. Alternate host: Railway

Railway also supports Node apps and will work well with this Express server.
Follow the same environment variable setup and start command.

## 6. Confirm the production app

After deployment:

- open the live URL
- verify the login page loads
- confirm the dashboard and scan pages connect
- test admin asset import and scanning

## 7. Production config options

### `config.json`

By default GADA uses a local `config.json` in the project root.
This file contains user PINs and location metadata.

### `CONFIG_JSON_PATH`

Set this to a file path if the config file lives outside the repository.

### `CONFIG_JSON`

Set this to a JSON string to provide config directly from environment variables.
This is useful on hosts where you do not want a repo file containing PINs.

Example:

```env
CONFIG_JSON={"locations":["Reception","Ward A"],"users":[{"id":"admin","name":"Admin","role":"Admin","department":"Admin","access":"admin","pin":"0000"}]}
```

---

## 8. Notes

- Do not commit `config.json`, `.env`, or `gada.db`.
- Always change admin PINs before using the app in production.
- `SESSION_SECRET` should be a strong random string.
