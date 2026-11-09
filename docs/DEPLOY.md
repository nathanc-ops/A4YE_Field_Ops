# Putting Field Ops online (DigitalOcean)

Result: the app runs at **https://ops.all4youelectrical.com** on one small server you control, so techs can reach it from their phones anywhere. Setup takes about 30 minutes, most of it waiting.

**Cost:** about **$14–17/month**:
- Server: $12
- DigitalOcean's weekly server backups: +$2.40
- Off-site backup storage (Spaces): $5. Optional, but strongly recommended.

## What you need before starting

- A DigitalOcean account (digitalocean.com) with a payment method.
- Access to the DNS settings for **all4youelectrical.com**, wherever the domain is managed (GoDaddy, Cloudflare, Squarespace, Google/Squarespace Domains…).
- This project on your PC, so you can copy one file to the server.

## 1. Create the server ("droplet")

In DigitalOcean: **Create → Droplets**.

| Setting | Choose |
|---|---|
| Region | The one closest to you (e.g. San Francisco or New York) |
| Image | **Ubuntu 24.04 (LTS) x64** |
| Size | Basic → Regular → **$12/mo (2 GB RAM, 50 GB disk)** |
| Backups | **Enable** (weekly), +20% |
| Authentication | **SSH key** is safest. A long random **password** also works; save it in your password manager. |
| Hostname | `a4ye-fieldops` |

Click **Create Droplet**. Copy its **IPv4 address**, for example `164.90.1.23`.

## 2. Point the address at it

At your domain's DNS host, add a record:

| Type | Name / Host | Value | TTL |
|---|---|---|---|
| A | `ops` | the droplet's IP | 5 min / Auto |

If the domain is on Cloudflare, set the record to **DNS only** (grey cloud). Otherwise the HTTPS certificate can't be issued.

## 3. Run the setup

On your PC, open PowerShell in the project folder and copy the setup script to the server:

```
scp deploy\setup.sh root@164.90.1.23:/root/
```

Use your droplet's IP. Type `yes` the first time it asks about the fingerprint. Then log in and run it:

```
ssh root@164.90.1.23
bash setup.sh
```

It installs Node.js, the HTTPS proxy (Caddy) and a firewall, downloads the program, and starts it.

**If the GitHub repository is private**, the script stops and shows a key. Open the GitHub link it prints and paste the key in as a **Deploy key**, leaving *Allow write access* unticked. Then press Enter. The key only lets this server *read* the code.

At the end it prints a summary. If it says DNS doesn't point to the server yet, wait a few minutes. HTTPS switches on by itself once DNS points there.

## 4. First sign-in

Open **https://ops.all4youelectrical.com**. The first visit asks you to create the **owner (admin) account**: use your real email and a strong password. Then:

1. **Settings:** company info, license number, tax rate, terms.
2. **Team:** add each office person and tech with their own login.
3. **Import Data:** bring your records over (see the README).

Don't run `npm run seed` on the server. It loads demo data.

## 5. Email (so Send actually emails)

On the server, open the settings file:

```
nano /etc/fieldops/fieldops.env
```

Fill in the `SMTP_` lines and remove the `#` in front of them.

| Email provider | SMTP_HOST | SMTP_PORT | SMTP_USER / SMTP_PASS |
|---|---|---|---|
| Microsoft 365 | `smtp.office365.com` | 587 | Mailbox address and password. SMTP AUTH must be enabled for that mailbox in the M365 admin center. |
| Google Workspace | `smtp.gmail.com` | 587 | Address and an **App Password** (requires 2-step verification). |

Save with Ctrl+O, Enter, then Ctrl+X. Apply it with:

```
systemctl restart fieldops
```

## 6. Off-site backups (do not skip)

The server already backs up the database every night at 2:30 AM to `/var/lib/fieldops/backups`, keeping 30 days. But those copies live **on the same server**. Here's how to also send them somewhere else:

1. In DigitalOcean, go to **Spaces Object Storage → Create a Spaces Bucket**. Use the same region, name it `a4ye-backups`, and keep it **private**.
2. Go to **API → Spaces Keys → Generate New Key**. Copy the key and secret straight into the next command. Don't put them in email or chat.
3. On the server, run this (use your bucket's region, e.g. `nyc3`, `sfo3`):
   ```
   rclone config create offsite s3 provider DigitalOcean env_auth false \
     access_key_id YOUR_KEY secret_access_key YOUR_SECRET endpoint sfo3.digitaloceanspaces.com acl private
   ```
4. In `/etc/fieldops/fieldops.env`, set `OFFSITE=offsite:a4ye-backups`.
5. Test it with `bash /opt/fieldops/deploy/backup.sh`. It should end with "Copied off-site". Job photos are copied too, and nothing in the bucket is ever deleted.

## Day-to-day

| Task | Command (logged in to the server) |
|---|---|
| Update to the latest version | `bash /opt/fieldops/deploy/update.sh`. It backs up first, and puts the old version back if the new one fails to start. |
| Back up right now | `bash /opt/fieldops/deploy/backup.sh` |
| List or restore a backup | `bash /opt/fieldops/deploy/restore.sh`. It keeps the current database aside, so a restore can be undone. |
| Is it running? / recent errors | `systemctl status fieldops` / `journalctl -u fieldops -n 50` |
| Restart | `systemctl restart fieldops` |
| Change settings | `nano /etc/fieldops/fieldops.env`, then `systemctl restart fieldops` |

Security updates for Ubuntu install themselves. Reboot about once a month with `reboot`; the app starts again by itself.

## Go-live checklist

- [ ] https://ops.all4youelectrical.com loads with the padlock, on a phone over cellular (Wi-Fi off).
- [ ] Owner account created; every employee has their **own** login, and techs have the **Tech** role.
- [ ] Company settings and logo correct on a test estimate.
- [ ] A test estimate emailed to yourself arrives, and its link opens on your phone.
- [ ] Off-site backup ran (`backup.sh` says "Copied off-site") and files show up in the Spaces bucket.
- [ ] **Restore tested once:** `restore.sh` a backup, check the data, then restore the `before-restore` copy back. A backup you have never restored is a guess.
- [ ] DigitalOcean droplet backups turned on.
- [ ] Two-factor authentication turned on for your DigitalOcean and GitHub accounts. Whoever controls those controls your business data.
- [ ] Old system kept read-only for a month or two, in case something didn't come across.

## Where things live on the server

| What | Where |
|---|---|
| Program | `/opt/fieldops` (from GitHub, replaced on update) |
| Database and photos | `/var/lib/fieldops` (`fieldops.db`, `uploads/`, `backups/`) |
| Settings | `/etc/fieldops/fieldops.env` |
| HTTPS config | `/etc/caddy/Caddyfile` |
