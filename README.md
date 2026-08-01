# WhatsApp Company Bot

Local WhatsApp bot for one business number. It links through WhatsApp Web, asks each new user for basic details, saves answers per WhatsApp user, and answers company-info questions from `config/company.json`.

People use it inside the normal WhatsApp app by messaging your number. The bot code itself runs on this PC through a linked WhatsApp Web session.

## Run

Easy Windows launcher:

```powershell
npm run start:windows
```

Manual run:

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

## How It Works

- The bot runs locally on this PC.
- It links your WhatsApp number as a WhatsApp Web device.
- Customers message your normal WhatsApp number inside the WhatsApp app.
- Replies are sent from that same linked number while the bot is running.
- Per-user answers and chat history save locally in `data/users.json`.
- Local debug events save in `logs/events.log`.
- Customers can send normal messages like `hi` or `services`.
- From your own linked WhatsApp account, use self-test messages with the `!bot` prefix.

## Test It Yourself

Send yourself or any chat a message that starts with:

```text
!bot
```

Examples:

```text
!bot hi
!bot Hasan
!bot Qualia
!bot WhatsApp automation
!bot services
!bot profile
```

The prefix is only for your own outgoing messages. Real customers do not need it.

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
Do not share this file.

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
- It appears inside WhatsApp because your phone links this PC as a WhatsApp Web device.
- People message your normal WhatsApp number. The reply is sent from that same linked number while this bot is running.
- This is best for a simple local assistant on your own WhatsApp number.
- WhatsApp can log out linked devices. If that happens, restart and scan the QR again.
- For high-volume or official business messaging, use the WhatsApp Business Platform later.

## Troubleshooting

- QR does not show: close the terminal and run `npm run start:windows` again.
- WhatsApp logged out: run `npm run reset:session`, then run `npm run start:windows` and scan again.
- PowerShell profile warnings: the bot launcher uses `-NoProfile`, so those warnings are unrelated to the bot.
- Bot does not reply to your own message: use the `!bot` prefix, for example `!bot hi`.
- Bot sees a WhatsApp Status instead of a chat: Status messages are ignored; test in a normal chat thread.
- Bot goes offline: keep the PC awake and keep the terminal open.
- Company answers are wrong: edit `config/company.json`, save, then restart the bot.
