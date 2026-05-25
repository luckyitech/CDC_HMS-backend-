# Deploying the In-App Notification Feature

This guide covers deploying the document upload notification system (bell icon + live toast for doctors).

---

## What was added

- When staff or lab uploads a document, all doctors see a red badge on the bell icon in their topbar.
- Clicking the bell opens a dropdown list of recent uploads.
- A live toast also appears instantly if the doctor is on the screen at the time.
- A `Notifications` table stores the notification records.

---

## Deployment Steps

### 1. Pull the new code

Pull the latest changes on both the backend and frontend repos.

### 2. Run the database migration (backend)

SSH into the production server and run:

```bash
cd /path/to/backend
npx sequelize-cli db:migrate
```

This creates the `Notifications` table. It is safe to run — it checks if the table already exists before creating it.

Expected output:
```
== 20260522000000-create-notifications: migrating =======
== 20260522000000-create-notifications: migrated (0.Xs)
```

If it says `already up to date`, the table already exists and you are fine.

### 3. Add environment variable (backend)

Open the production `.env` file and add:

```
NOTIFY_ALL_DOCTORS=true
```

- `true` — all doctors see every document upload notification (current behaviour)
- `false` — only the patient's assigned doctor sees the notification (for multi-doctor clinics)

### 4. Restart the backend server

```bash
pm2 restart all
# or however you normally restart the server
```

### 5. Build and deploy the frontend

```bash
cd /path/to/frontend
npm run build
```

Then deploy the `dist/` folder as you normally do.

---

## Nginx configuration (important for live bell)

If nginx sits in front of your backend, the SSE connection (live bell) needs its own rule or nginx will cut the connection every 60 seconds.

Add this block inside your nginx server config:

```nginx
location /api/sse {
    proxy_pass http://localhost:3000;
    proxy_http_version 1.1;
    proxy_set_header Connection '';
    proxy_buffering off;
    proxy_cache off;
    proxy_read_timeout 86400s;
}
```

**Without this**, the bell badge and dropdown still work (they load on page visit), but the live toast will not fire — the doctor has to refresh the page to see new notifications.

---

## Verify it is working

1. Log in as staff and upload a document for any patient.
2. In a separate browser tab, log in as a doctor.
3. The bell icon should show a red badge with a count.
4. If both tabs are open at the same time, a blue toast should appear on the doctor's screen when staff uploads.
5. Click the bell — the document should appear in the dropdown.
6. Click the notification — it should open that patient's profile on the Medical Documents tab.

---

## Rollback

If something goes wrong and you need to undo:

1. Run the migration undo:
   ```bash
   npx sequelize-cli db:migrate:undo
   ```
   This drops the `Notifications` table.

2. Remove `NOTIFY_ALL_DOCTORS` from `.env`.

3. Deploy the previous version of the backend and frontend.
