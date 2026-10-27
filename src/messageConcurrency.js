"use strict";

/**
 * Bounded FIFO executor for inbound messages. Messages for a contact stay in
 * arrival order, while unrelated contacts may run concurrently.
 */
function createMessageExecutor({ concurrency = 8, maxQueue = 200 } = {}) {
  const maxConcurrent = Math.min(32, Math.max(1, Math.floor(Number(concurrency) || 1)));
  const queueLimit = Math.min(2000, Math.max(0, Math.floor(Number(maxQueue) || 0)));
  const queue = [];
  const activeContacts = new Set();
  let active = 0;

  function pump() {
    while (active < maxConcurrent) {
      const index = queue.findIndex((job) => !activeContacts.has(job.contactKey));
      if (index < 0) return;
      const [job] = queue.splice(index, 1);
      active += 1;
      activeContacts.add(job.contactKey);
      const finish = () => {
        active -= 1;
        activeContacts.delete(job.contactKey);
        pump();
      };
      Promise.resolve()
        .then(job.run)
        .then((value) => {
          finish();
          job.resolve(value);
        }, (error) => {
          finish();
          job.reject(error);
        });
    }
  }

  return {
    run(contactKey, run) {
      if (typeof run !== "function") return Promise.reject(new TypeError("A message task is required."));
      const key = String(contactKey || "").trim();
      if (!key) return Promise.reject(new TypeError("A contact key is required."));
      const schedulingKey = canonicalContactKey(key);
      return new Promise((resolve, reject) => {
        const job = { contactKey: schedulingKey, run, resolve, reject };
        queue.push(job);
        pump();
        // Queue capacity applies only to jobs still waiting after all runnable
        // work has started. This allows maxQueue: 0 to mean “no waiting”, while
        // still admitting immediately runnable work (including an unrelated
        // contact when the queue contains only jobs blocked behind one contact).
        if (queue.includes(job) && queue.length > queueLimit) {
          queue.splice(queue.indexOf(job), 1);
          const error = new Error("Inbound message queue is full.");
          error.code = "MESSAGE_QUEUE_FULL";
          reject(error);
          pump();
        }
      });
    },
    getStats() {
      return { active, queued: queue.length, activeContacts: activeContacts.size, concurrency: maxConcurrent, maxQueue: queueLimit };
    }
  };
}

// WhatsApp's legacy c.us and current s.whatsapp.net domains can identify the
// same phone contact. Keep the provider's original JID for application data,
// but serialize both spellings under one local worker key.
function canonicalContactKey(contactKey) {
  return String(contactKey).replace(/@c\.us$/i, "@s.whatsapp.net");
}

function parseMessageQueueLimit(value, fallback = 200) {
  if (value === undefined || value === null || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 2000) {
    throw new RangeError("RAFA_INBOUND_QUEUE_LIMIT must be an integer from 0 to 2000.");
  }
  return parsed;
}

module.exports = { createMessageExecutor, parseMessageQueueLimit, canonicalContactKey };
