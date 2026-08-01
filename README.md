# WhatsApp Company Bot

Local WhatsApp bot for one business number. It links through WhatsApp Web, asks each new user for basic details, saves answers per WhatsApp user, and answers company-info questions from `config/company.json`.

People use it inside the normal WhatsApp app by messaging your number. The bot code itself runs on this PC through a linked WhatsApp Web session.

## Run

```powershell
cd C:\Users\hasan\Projects\Hasan-apps\whatsapp-company-bot
npm install
npm start
```

When the QR code appears, open WhatsApp on your phone:

```text
Settings > Linked devices > Link a device
```

Scan the QR. Keep this terminal open while you want the bot online.

## Edit Company Info

Update:

```text
config/company.json
```

Change the company name, services, contact details, FAQs, and fallback answer. Restart the bot after editing.

## User Data

Per-user answers are stored locally:

```text
data/users.json
```

This file is ignored by git because it contains customer/user information.

## User Commands

```text
start
help
profile
reset
services
contact
location
hours
pricing
```

## Notes

- This uses WhatsApp Web through `whatsapp-web.js`.
- This is best for a simple local assistant on your own WhatsApp number.
- WhatsApp can log out linked devices. If that happens, restart and scan the QR again.
- For high-volume or official business messaging, use the WhatsApp Business Platform later.
