const PRIORITY_RANK = { normal: 0, high: 1, urgent: 2 };

export function groupHandoversByContact(handovers = []) {
  const groups = new Map();
  for (const handover of Array.isArray(handovers) ? handovers : []) {
    const contactKey = handover.contact?.id || handover.contact?.userId || handover.id;
    let group = groups.get(contactKey);
    if (!group) {
      group = { ...handover, groupKey: contactKey, groupCount: 0, handoverIds: [], drafts: [], alerts: [] };
      groups.set(contactKey, group);
    }
    group.groupCount += 1;
    group.groupCount = Math.max(group.groupCount, Array.isArray(handover.summary?.relatedRequests) ? handover.summary.relatedRequests.length : 0);
    if (handover.id) group.handoverIds.push(handover.id);
    if ((PRIORITY_RANK[handover.priority] || 0) > (PRIORITY_RANK[group.priority] || 0)) group.priority = handover.priority;
    if (handover.status === "open") group.status = "open";
    for (const draft of handover.drafts || []) if (!group.drafts.some((item) => item.id === draft.id)) group.drafts.push(draft);
    for (const alert of handover.alerts || []) if (!group.alerts.some((item) => item.id === alert.id)) group.alerts.push(alert);
  }
  return [...groups.values()];
}

export function countUniqueHandoverContacts(handovers = []) {
  const contacts = new Set();
  for (const handover of Array.isArray(handovers) ? handovers : []) {
    const contactId = handover.contact_id || handover.contact?.id || handover.contact?.userId;
    contacts.add(contactId ? `contact:${contactId}` : `handover:${handover.id || contacts.size}`);
  }
  return contacts.size;
}
