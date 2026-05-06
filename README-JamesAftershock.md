# Tjiunardi Dashboard Viewer

A **view-only web app** for browsing your Tjiunardi stock research reports. Works on tablets, phones, and computers — no install needed for viewers.

---

## For the person setting up (you)

### 1. Create the `.env` file

In this folder (`Tjiunardi-Dashboard-Viewer`), create a file called `.env` with these two lines:

```
VITE_SUPABASE_URL=https://xxxxx.supabase.co
VITE_SUPABASE_ANON_KEY=your_anon_key_here
```

Use the **same values** from your desktop app's `.env` file (in the `Tjiunardi-Dashboard` folder).

### 2. Install dependencies (once)

Open a terminal in this folder and run:

```
npm install
```

### 3. Start the viewer

```
npm run dev
```

Open **http://localhost:5174** in your browser.

---

## For other users (tablets, phones, other computers)

- **No setup needed** on their device.
- They open the viewer URL in their browser.
- They sign in with their **Supabase email/password** (same as the desktop app).
- When they tap **"Open in Gemini"** on a conversation, they need to be signed into **Gemini** in that browser.

---

## Deploying (so tablets can access it without your computer running)

### Option A: Vercel (free, recommended)

1. Push this folder to a **GitHub repository**.
2. Go to [vercel.com](https://vercel.com) and sign in with GitHub.
3. Click **Import** and select the repository.
4. In the Vercel dashboard, go to **Settings → Environment Variables** and add:
   - `VITE_SUPABASE_URL` = your Supabase URL
   - `VITE_SUPABASE_ANON_KEY` = your Supabase anon key
5. Click **Deploy**.
6. You'll get a URL like `https://your-viewer.vercel.app` — share it with anyone who needs access.

### Option B: Netlify (free, alternative)

1. Push to GitHub.
2. Go to [netlify.com](https://netlify.com) and import the repository.
3. Add the same two environment variables in the Netlify dashboard.
4. Deploy and share the URL.

---

## What this app does

- **View companies** with sorting and search.
- **Filter** to show only companies that have reports.
- **View gems** for each company, sorted by rank or name.
- **View all conversations** (reports) for any company + gem combination.
- **Open conversations in Gemini** by tapping the "Open in Gemini" button (opens in a new tab).
- **Metrics** (`/metrics`): pick a gem and compare companies in a table using the **latest run’s `captured_metrics`** for that gem (column labels from `gems.capture_config` when present), plus **weighted scores** (same eight score types as the Scores page). Optional URL: `/metrics?gem=<gem_id>` to pre-select a gem.

This is a **read-only** viewer. It does not create or modify any data in your Supabase database.

---

## This project does NOT affect your desktop app

- All code lives in this separate `Tjiunardi-Dashboard-Viewer` folder.
- No files in `Tjiunardi-Dashboard` are changed.
- Both apps connect to the same Supabase database (viewer only reads).
