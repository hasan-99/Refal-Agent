# Debug Report - 2026-09-30

**Symptom:** First attempt to connect WhatsApp number `+35799260049` failed with “WhatsApp could not create a pairing code.”
**Mode:** connection failure

## Investigation
- Reproduced using an isolated fresh Baileys auth directory and the requested number.
- Inspected Baileys connection event ordering: an initial `connecting` update is emitted before the WebSocket opens; the QR-ready update is emitted after the socket opens.
- Found RAFA requested a pairing code on either `connecting` or QR-ready, so it raced the WebSocket and failed with `Connection Closed`.
- Found the dashboard discarded worker stderr, hiding the actionable failure detail.

## Root Cause
`src/bot.js` requested a phone-link code before the Baileys WebSocket was ready. The pairing code request must be gated on the QR-ready event.

## Fix Applied
- Added `src/whatsappPairing.js` to guard code requests and sanitize failure details.
- Changed pairing to request only after a QR-ready event and forward a sanitized diagnostic to the managed dashboard worker.
- Exposed the worker pairing failure detail to dashboard state and replaced inline WhatsApp errors with dismissible status/error toasts.
- Added regression checks for premature, valid, repeated, missing-number, and PII-redaction cases.

## Verification
- `npm test`: 25/25 passing.
- `npm --prefix dashboard test`: 27/27 passing.
- `npm --prefix dashboard run build`: passed.
- `node --check src/bot.js` and `node --check dashboard/whatsappController.js`: passed.
- Isolated live Baileys process for `+35799260049` reached `pairing-code` IPC event after `connecting`; the one-time code was not printed. Owner still needs to complete Linked Devices pairing on the phone.

## Remaining Gate
The actual linked-device session is not yet established. Pairing codes expire; the dashboard must be authenticated as an admin to view and use a fresh code.

## Logout Recovery Follow-up
- The dashboard later surfaced WhatsApp's definitive logged-out status. The local credential metadata was unregistered (`registered: false`), consistent with an invalid/incomplete linked-device session.
- A repeat-connect gap could leave revoked Baileys files in place. Added narrow cleanup of known Baileys credential/key filenames only when WhatsApp reports `DisconnectReason.loggedOut`; unrelated files in the auth directory are preserved.
- Root tests (25/25) and dashboard tests (27/27) pass. The dashboard session checked from the local server is unauthenticated, so an actual authenticated browser click cannot be performed from this session; a fresh admin pairing attempt is still needed.
