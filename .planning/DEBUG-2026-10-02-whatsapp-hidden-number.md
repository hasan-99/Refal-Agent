# Debug Report — 2026-10-02

**Symptom:** Conversation table displays “Number hidden by WhatsApp” for contacts whose WhatsApp JID uses `@lid`.
**Mode:** general

## Investigation

- Inspected the live message handler, contact persistence, dashboard contact summary, and installed Baileys 7.0.0-rc14 types/implementation.
- Baileys exposes `remoteJidAlt` on incoming message keys and keeps a local reverse LID-to-phone mapping via `signalRepository.lidMapping.getPNForLID`.
- The worker previously stored only the LID and push name; the dashboard therefore had no phone JID to format.

## Root Cause

`src/bot.js` in `rememberWhatsAppContact` ignored the message's alternate JID and the worker's persisted LID mapping. `dashboard/server.js` consequently reached the explicit `@lid` fallback in `displayPhone` even when Baileys had a verified phone mapping available.

The inbox label also treated `profile.name` as a verified customer name, even though old records may contain message-derived values. The inbox now uses only explicitly overridden names or WhatsApp-provided profile names; otherwise it labels the contact by the best available phone number.

## Fix Applied

- Added `src/whatsappContact.js` to accept only valid phone-number JIDs from WhatsApp alternate-JID metadata or the local LID mapping store.
- Updated `src/bot.js` to persist the verified phone JID in the existing `whatsapp` contact JSON and backfill existing LIDs from Baileys' saved local mapping in the background after reconnect.
- Updated `dashboard/server.js` to format that verified phone number for the inbox, keep the hidden-number fallback when no mapping exists, and stop presenting legacy `profile.name` values as verified names.
- Updated `dashboard/src/Conversations.jsx` to use the phone number as the contact label whenever there is no verified name, never the first-message preview.
- Verification: unit-style mapping checks passed for alternate JID, saved local mapping, invalid alternate, and regular phone-JID cases; root tests passed (92); dashboard tests passed (50); dashboard build passed; local dashboard returned HTTP 200; worker and dashboard restarted.

## Remaining Limitation

WhatsApp may not provide or retain a phone mapping for every LID. No number can be safely inferred in that case; the admin can enter a confirmed number through the existing contact editor.
