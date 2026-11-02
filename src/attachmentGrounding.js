"use strict";

// A file may support a statement about its own contents only when the reply
// attributes that statement to the file. It never makes the underlying claim
// official or authoritative.
const ATTACHMENT_ATTRIBUTION = /\b(?:the\s+)?(?:attached\s+|uploaded\s+|provided\s+)?(?:document|file|image|photo|screenshot|scan|spreadsheet|sheet)\b[^.!?؟;；]{0,120}\b(?:contains?|shows?|lists?|mentions?|states?|omits?|records?|says?|indicates?|does\s+not\s+(?:mention|list|state|show)|is\s+(?:a|an))\b|\b(?:according\s+to|as\s+(?:listed|stated|shown|mentioned)\s+in|in)\s+(?:the\s+)?(?:attached\s+|uploaded\s+|provided\s+)?(?:document|file|image|photo|screenshot|scan|spreadsheet|sheet)\b|(?:ال(?:مستند|ملف|صورة|وثيقة|جدول)(?:\s+المرفق(?:ة)?)?)(?:\s+(?:هو|هي))?\s*[^.!?؟؛]{0,120}(?:يحتوي|تحتوي|يعرض|تعرض|يذكر|تذكر|يتضمن|تتضمن|يبدو|تبدو|هو|هي|عبارة\s+عن|لا\s+(?:يذكر|تذكر|يحدد|تحدد|يتضمن|تتضمن))|(?:في\s+ال(?:مستند|ملف|صورة|وثيقة|جدول)(?:\s+المرفق(?:ة)?)?|(?:بحسب|وفق(?:اً|ا)?\s+ل)\s*(?:ال)?(?:مستند|ملف|صورة|وثيقة|جدول))|\b(?:the\s+)?(?:document|file|image|photo|spreadsheet)\b[^.!?؟;；]{0,80}\b(?:does\s+not\s+(?:mention|list|state|show)|lacks?)\b|(?:σύμφωνα\s+με\s+(?:το\s+)?(?:έγγραφ\p{L}*|αρχε\p{L}*|συνημμέν\p{L}*)|στο\s+(?:έγγραφ\p{L}*|αρχε\p{L}*))|(?:το\s+)?(?:έγγραφ\p{L}*|αρχε\p{L}*|συνημμέν\p{L}*)[^.!?;；]{0,120}(?:περιέχ\p{L}*|αναφέρ\p{L}*|καταγράφ\p{L}*|δείχν\p{L}*|παραλείπ\p{L}*|δεν\s+(?:αναφέρ\p{L}*|καταγράφ\p{L}*|καθορίζ\p{L}*))/iu;

function explicitlyDescribesAttachment(text) {
  return ATTACHMENT_ATTRIBUTION.test(String(text || ""));
}

module.exports = { explicitlyDescribesAttachment };
