const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function registerPrivateAttachmentPreviewRoute(app, {
  requireAdmin,
  findConversationTurn,
  readLinkedAttachment,
  createSignedPreviewUrl
} = {}) {
  if (!app?.get || typeof requireAdmin !== "function" || typeof findConversationTurn !== "function"
      || typeof readLinkedAttachment !== "function" || typeof createSignedPreviewUrl !== "function") {
    throw new TypeError("An Express app and private attachment preview dependencies are required.");
  }

  app.get("/api/conversations/:userId/attachments/:attachmentId/preview", requireAdmin, async (req, res) => {
    const userId = String(req.params.userId || "").trim();
    const attachmentId = String(req.params.attachmentId || "");
    if (!userId || userId.length > 200 || !UUID.test(attachmentId)) {
      return res.status(404).json({ error: "Attachment not found." });
    }

    try {
      const turn = await findConversationTurn(userId, attachmentId);
      const reference = turn?.metadata?.attachment;
      if (!turn || reference?.id !== attachmentId || !UUID.test(String(turn.id || "")) || !reference.messageId) {
        return res.status(404).json({ error: "Attachment not found." });
      }

      const attachment = await readLinkedAttachment({
        attachmentId,
        turnId: turn.id,
        messageId: String(reference.messageId)
      });
      if (!attachment?.storagePath || attachment.status !== "linked") {
        return res.status(404).json({ error: "Attachment not found." });
      }

      const url = await createSignedPreviewUrl(attachment.storagePath, req, res);
      if (typeof url !== "string" || !url) throw new Error("Attachment preview is unavailable.");
      res.setHeader("Cache-Control", "no-store");
      return res.json({ url, expiresIn: 120 });
    } catch {
      return res.status(503).json({ error: "Attachment preview is temporarily unavailable." });
    }
  });
}
