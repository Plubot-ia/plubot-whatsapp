import express from 'express';

const router = express.Router();

// Send message through WhatsApp
router.post('/send', async (req, res) => {
  try {
    const { sessionId, to, message, options } = req.body;

    if (!sessionId || !to || !message) {
      return res.status(400).json({
        success: false,
        error: 'sessionId, to, and message are required',
      });
    }

    const result = await req.whatsappManager.sendMessage(sessionId, to, message, options);
    return res.json({
      success: true,
      ...result,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

// Get message history
router.get('/:sessionId/history', async (req, res, next) => {
  try {
    const { sessionId } = req.params;
    const { limit = 50 } = req.query;

    // Get from Redis
    const messages = await req.whatsappManager.redis.lrange(`messages:${sessionId}`, 0, limit - 1);

    res.json({
      success: true,
      messages: messages.map((msg) => JSON.parse(msg)),
    });
  } catch (error) {
    next(error);
  }
});

export default router;
