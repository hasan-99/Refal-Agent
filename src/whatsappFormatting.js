"use strict";

// WhatsApp recognizes single asterisks for bold. Models and saved response
// preferences commonly emit Markdown's double-asterisk form, which WhatsApp
// partially interprets and leaves visible marker characters in the message.
function normalizeWhatsAppFormatting(value) {
  return String(value ?? "").replace(/\*\*([^\n]+?)\*\*/gu, "*$1*");
}

module.exports = { normalizeWhatsAppFormatting };
