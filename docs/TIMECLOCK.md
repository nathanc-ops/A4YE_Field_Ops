# Connecting the A4Y Time Clock

Your crews keep using the A4Y Time Clock exactly as they do now. Field Ops reads its **Time Entries** and **Cost Codes** tabs. Hours then land on the right projects and cost codes for job costing, progress and the commercial dashboard.

Field Ops only reads. It never writes to the time clock sheet, and it never reads the **Employees** tab, so PINs and pay rates stay in the sheet.

## Option A: automatic, every hour (recommended)

You only do this once, in about 10 minutes.

1. Go to **script.google.com → New project**. This is a separate project, not your time clock's script. Name it `A4Y Time Clock export`.
2. Delete what's there and paste in the contents of `docs/timeclock-export.gs` from this program.
3. On the `SHEET_ID` line, paste the ID of your **A4Y Time Clock** sheet. That's the part of the sheet's address between `/d/` and `/edit`.
4. **Project Settings (gear) → Script properties → Add property:**
   - name `EXPORT_KEY`;
   - value: a long random password (30+ characters). Save it in your password manager.
5. **Deploy → New deployment → Web app**:
   - Execute as **Me**;
   - Who has access **Anyone**. The key is what protects it.

   Click **Deploy** and approve the permission prompt (read access to your sheets). Copy the **Web app URL**.
6. In Field Ops, go to **Settings → A4Y Time Clock**. Paste the URL and the key, then press **Sync now**.

After that the server pulls new and changed entries every hour. Each sync looks back 60 days, so edits made in the time clock come through too.

## Option B: by hand

In the A4Y Time Clock sheet, open the **Time Entries** tab and choose **File → Download → Comma-separated values (.csv)**. Then upload the file under **Settings → A4Y Time Clock → Upload CSV**. Uploading the same file twice is safe.

## How entries are matched

| Time clock | Field Ops |
|---|---|
| **Entry ID** | The key. Syncing again updates the entry instead of making a copy. |
| **Employee ID / Employee** | **Team → person → Time clock ID**. Exact name works the first time, and the ID is saved automatically. Anyone Field Ops doesn't know yet is added as an *inactive* technician with no login, so their hours still count. Link or activate them under Team. |
| **Job #** | **Time clock job #** on the job or project (Edit job). `0000 Shop / Office` is shop time. Hours for a job number no project has yet are kept, and they attach as soon as you enter that number on the project. |
| **Cost code** `0810-L` | Cost code **0810**. The `-L` / `-M` / `-E` / `-S` type suffix is dropped, so labor and material for the same work share one code, like the job tracker's Cost Codes tab. |
| **Hours** | Used as-is, so the time clock's own lunch rules apply. |
| **Labor Amt.** | Sets the pay rate on the entry. Field Ops adds the person's burden % (Team) for job cost. |
| Times | Read in your time zone (Settings → A4Y Time Clock, default America/Boise). |
